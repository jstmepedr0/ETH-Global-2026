import {
  type AnomalyMetricBucket,
  type AnomalyMetricName,
  type AnomalySignal,
} from "./domain.js";

const HISTORY_SECONDS = 30 * 24 * 60 * 60;
const MIN_READY_BUCKETS = 24 * 60 / 5;

export const anomalyMetricNames: AnomalyMetricName[] = [
  "blocksPerMinute",
  "tps",
  "averageTransactionFeeWei",
  "averageEffectiveGasPriceWei",
  "gasUtilization",
  "failedTransactionRate",
  "averageBlockIntervalSeconds",
  "averageUniqueSendersPerBlock",
];

const ratioMetrics = new Set<AnomalyMetricName>([
  "gasUtilization",
  "failedTransactionRate",
]);

const highOnlyMetrics = new Set<AnomalyMetricName>([
  "failedTransactionRate",
  "averageBlockIntervalSeconds",
]);

export interface AnomalyModelProfile {
  slotMinimum: 7 | 14;
  calibrationDays: 14 | 30;
  warningFdr: 0.005 | 0.01;
  criticalFdr: 0.0005 | 0.001;
  warningPersistence: 2 | 3;
}

export const precisionModelProfile: AnomalyModelProfile = {
  slotMinimum: 14,
  calibrationDays: 30,
  warningFdr: 0.005,
  criticalFdr: 0.0005,
  warningPersistence: 2,
};

export interface MetricPrediction {
  expected: number;
  lower99: number;
  upper99: number;
  lower999: number;
  upper999: number;
  location: number;
  scale: number;
  degreesOfFreedom: number;
}

interface TimedValue {
  at: number;
  value: number;
}

interface MetricObservation {
  metric: AnomalyMetricName;
  transformed: number;
  nonconformity?: number;
}

export interface BucketScore {
  signals: AnomalySignal[];
  predictions: Partial<Record<AnomalyMetricName, MetricPrediction>>;
  observations: MetricObservation[];
}

class RollingDistribution {
  private readonly queue: TimedValue[] = [];
  private readonly sorted: number[] = [];
  private total = 0;
  private totalSquares = 0;

  get count(): number {
    return this.queue.length;
  }

  add(at: number, value: number): void {
    this.queue.push({ at, value });
    const index = lowerBound(this.sorted, value);
    this.sorted.splice(index, 0, value);
    this.total += value;
    this.totalSquares += value * value;
  }

  prune(cutoff: number): void {
    while (this.queue[0] && this.queue[0].at < cutoff) {
      const expired = this.queue.shift()!;
      const index = lowerBound(this.sorted, expired.value);
      if (index < this.sorted.length) this.sorted.splice(index, 1);
      this.total -= expired.value;
      this.totalSquares -= expired.value * expired.value;
    }
  }

  mean(): number {
    return this.count === 0 ? 0 : this.total / this.count;
  }

  sumSquares(): number {
    if (this.count === 0) return 0;
    return Math.max(0, this.totalSquares - this.total * this.total / this.count);
  }

  variance(): number {
    return this.count < 2 ? 0 : this.sumSquares() / (this.count - 1);
  }

  median(): number {
    if (this.count === 0) return 0;
    const middle = Math.floor(this.count / 2);
    return this.count % 2 === 0
      ? (this.sorted[middle - 1]! + this.sorted[middle]!) / 2
      : this.sorted[middle]!;
  }

  robustScale(): number {
    if (this.count < 2) return Math.max(Math.sqrt(this.variance()), 0.01);
    const median = this.median();
    const deviations = this.sorted
      .map((value) => Math.abs(value - median))
      .sort((left, right) => left - right);
    const middle = Math.floor(deviations.length / 2);
    const mad = deviations.length % 2 === 0
      ? (deviations[middle - 1]! + deviations[middle]!) / 2
      : deviations[middle]!;
    return Math.max(1.4826 * mad, Math.sqrt(this.variance()) * 0.1, 0.01);
  }

  countAtOrAbove(value: number): number {
    return this.sorted.length - lowerBound(this.sorted, value);
  }
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function transformAnomalyMetric(
  metric: AnomalyMetricName,
  value: number,
): number {
  if (ratioMetrics.has(metric)) {
    const clamped = Math.min(1 - 1e-6, Math.max(1e-6, value));
    return Math.log(clamped / (1 - clamped));
  }
  return Math.log1p(Math.max(0, value));
}

export function inverseAnomalyMetric(
  metric: AnomalyMetricName,
  value: number,
): number {
  if (ratioMetrics.has(metric)) return 1 / (1 + Math.exp(-value));
  return Math.max(0, Math.expm1(value));
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) -
      Math.log(Math.sin(Math.PI * value)) -
      logGamma(1 - value);
  }
  const shifted = value - 1;
  let sum = 0.9999999999998099;
  for (const [index, coefficient] of coefficients.entries()) {
    sum += coefficient / (shifted + index + 1);
  }
  const t = shifted + coefficients.length - 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(sum)
  );
}

function betaFraction(x: number, a: number, b: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const twice = iteration * 2;
    let coefficient =
      iteration * (b - iteration) * x /
      ((qam + twice) * (a + twice));
    d = 1 + coefficient * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + coefficient / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    coefficient =
      -(a + iteration) * (qab + iteration) * x /
      ((a + twice) * (qap + twice));
    d = 1 + coefficient * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + coefficient / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log1p(-x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaFraction(x, a, b) / a;
  }
  return 1 - front * betaFraction(1 - x, b, a) / b;
}

export function studentTCdf(value: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
  if (value === 0) return 0.5;
  const df = Math.max(1, degreesOfFreedom);
  const x = df / (df + value * value);
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5);
  return value > 0 ? 1 - tail : tail;
}

const quantileCache = new Map<string, number>();

export function studentTQuantile(
  probability: number,
  degreesOfFreedom: number,
): number {
  if (probability <= 0) return Number.NEGATIVE_INFINITY;
  if (probability >= 1) return Number.POSITIVE_INFINITY;
  if (probability === 0.5) return 0;
  const df = Math.max(1, Math.round(degreesOfFreedom * 1e6) / 1e6);
  const key = `${probability}|${df}`;
  const cached = quantileCache.get(key);
  if (cached !== undefined) return cached;
  let low = -64;
  let high = 64;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, df) < probability) low = middle;
    else high = middle;
  }
  const result = (low + high) / 2;
  quantileCache.set(key, result);
  return result;
}

export function conformalTailProbability(
  calibration: number[],
  nonconformity: number,
): number {
  const atOrAbove = calibration.reduce(
    (count, value) => count + (value >= nonconformity ? 1 : 0),
    0,
  );
  return (1 + atOrAbove) / (calibration.length + 1);
}

export function normalInverseGammaPosterior(
  sample: { count: number; mean: number; sumSquares: number },
  prior: { mean: number; scale: number },
): {
  mean: number;
  kappa: number;
  alpha: number;
  beta: number;
  scale: number;
  degreesOfFreedom: number;
} {
  const kappa0 = 1;
  const alpha0 = 3;
  const beta0 = (alpha0 - 1) * prior.scale * prior.scale;
  const kappa = kappa0 + sample.count;
  const mean =
    (kappa0 * prior.mean + sample.count * sample.mean) / kappa;
  const alpha = alpha0 + sample.count / 2;
  const beta =
    beta0 +
    sample.sumSquares / 2 +
    (kappa0 * sample.count * (sample.mean - prior.mean) ** 2) /
      (2 * kappa);
  return {
    mean,
    kappa,
    alpha,
    beta,
    scale: Math.sqrt((beta * (kappa + 1)) / (alpha * kappa)),
    degreesOfFreedom: 2 * alpha,
  };
}

function weekend(at: number): boolean {
  const day = new Date(at * 1000).getUTCDay();
  return day === 0 || day === 6;
}

function seasonalKey(at: number): string {
  const date = new Date(at * 1000);
  return `${weekend(at) ? "weekend" : "weekday"}|${date.getUTCHours()}|${Math.floor(
    date.getUTCMinutes() / 5,
  )}`;
}

function nigPrediction(
  metric: AnomalyMetricName,
  sample: RollingDistribution,
  prior: { mean: number; scale: number },
): MetricPrediction {
  const posterior = normalInverseGammaPosterior(
    {
      count: sample.count,
      mean: sample.mean(),
      sumSquares: sample.sumSquares(),
    },
    prior,
  );
  const posteriorMean = posterior.mean;
  const scale = posterior.scale;
  const degreesOfFreedom = posterior.degreesOfFreedom;
  const critical99 = studentTQuantile(0.995, degreesOfFreedom);
  const critical999 = studentTQuantile(0.9995, degreesOfFreedom);
  return {
    expected: inverseAnomalyMetric(metric, posteriorMean),
    lower99: inverseAnomalyMetric(
      metric,
      posteriorMean - critical99 * scale,
    ),
    upper99: inverseAnomalyMetric(
      metric,
      posteriorMean + critical99 * scale,
    ),
    lower999: inverseAnomalyMetric(
      metric,
      posteriorMean - critical999 * scale,
    ),
    upper999: inverseAnomalyMetric(
      metric,
      posteriorMean + critical999 * scale,
    ),
    location: posteriorMean,
    scale: Math.max(scale, 1e-9),
    degreesOfFreedom,
  };
}

function legacyCritical(z: number, degreesOfFreedom: number): number {
  const df = Math.max(3, degreesOfFreedom);
  const z2 = z * z;
  return (
    z +
    (z * z2 + z) / (4 * df) +
    (5 * z * z2 * z2 + 16 * z * z2 + 3 * z) / (96 * df * df)
  );
}

function legacyPrediction(
  metric: AnomalyMetricName,
  sample: RollingDistribution,
): MetricPrediction {
  const count = sample.count;
  const mean = sample.mean();
  const sumSquares = sample.sumSquares();
  const variance = Math.max(sample.variance(), 1e-4);
  const kappa = 0.01 + count;
  const alpha = 2 + count / 2;
  const beta = variance + sumSquares / 2;
  const scale = Math.sqrt((beta * (kappa + 1)) / (alpha * kappa));
  const degreesOfFreedom = 2 * alpha;
  const critical99 = legacyCritical(2.575829, degreesOfFreedom);
  const critical999 = legacyCritical(3.290527, degreesOfFreedom);
  return {
    expected: inverseAnomalyMetric(metric, mean),
    lower99: inverseAnomalyMetric(metric, mean - critical99 * scale),
    upper99: inverseAnomalyMetric(metric, mean + critical99 * scale),
    lower999: inverseAnomalyMetric(metric, mean - critical999 * scale),
    upper999: inverseAnomalyMetric(metric, mean + critical999 * scale),
    location: mean,
    scale: Math.max(scale, 1e-9),
    degreesOfFreedom,
  };
}

export function benjaminiYekutieli(pValues: number[]): number[] {
  const count = pValues.length;
  if (count === 0) return [];
  const harmonic = Array.from({ length: count }, (_, index) => 1 / (index + 1))
    .reduce((total, value) => total + value, 0);
  const ranked = pValues
    .map((value, index) => ({ value: Math.min(1, Math.max(0, value)), index }))
    .sort((left, right) => left.value - right.value);
  const adjusted = new Array<number>(count);
  let minimum = 1;
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = Math.min(
      1,
      ranked[index]!.value * count * harmonic / (index + 1),
    );
    minimum = Math.min(minimum, candidate);
    adjusted[ranked[index]!.index] = minimum;
  }
  return adjusted;
}

export class BayesianConformalScorer {
  private readonly global = new Map<AnomalyMetricName, RollingDistribution>();
  private readonly seasonal = new Map<
    AnomalyMetricName,
    Map<string, RollingDistribution>
  >();
  private readonly calibration = new Map<string, RollingDistribution>();
  private readonly acceptedBucketTimes: number[] = [];
  private readonly priors = new Map<
    AnomalyMetricName,
    { mean: number; scale: number }
  >();
  private priorDay = -1;

  constructor(
    readonly chainId: string,
    readonly profile: AnomalyModelProfile = precisionModelProfile,
  ) {
    for (const metric of anomalyMetricNames) {
      this.global.set(metric, new RollingDistribution());
      this.seasonal.set(metric, new Map());
    }
  }

  warm(history: AnomalyMetricBucket[]): void {
    for (const bucket of history
      .filter(({ chainId }) => chainId === this.chainId)
      .sort((left, right) => left.start - right.start)) {
      const score = this.preview(bucket);
      if (bucket.learning === "accepted") this.observe(bucket, score);
    }
  }

  preview(bucket: AnomalyMetricBucket): BucketScore {
    this.prune(bucket.start);
    const predictions: Partial<Record<AnomalyMetricName, MetricPrediction>> = {};
    const candidates: Array<{
      metric: AnomalyMetricName;
      observed: number;
      prediction: MetricPrediction;
      direction: "high" | "low";
      pValue: number;
      conformalPValue: number;
      calibrationSamples: number;
      nonconformity: number;
    }> = [];
    const observations: MetricObservation[] = [];
    const ready = this.acceptedBucketTimes.length >= MIN_READY_BUCKETS;
    this.refreshPriors(bucket.start);

    for (const metric of anomalyMetricNames) {
      const observed = bucket.metrics[metric];
      if (observed === undefined || !Number.isFinite(observed)) continue;
      const transformed = transformAnomalyMetric(metric, observed);
      const global = this.global.get(metric)!;
      const slots = this.seasonal.get(metric)!;
      const slot = slots.get(seasonalKey(bucket.start));
      if (!ready || global.count < MIN_READY_BUCKETS) {
        observations.push({ metric, transformed });
        continue;
      }
      const sample = slot && slot.count >= this.profile.slotMinimum
        ? slot
        : global;
      const prediction = nigPrediction(
        metric,
        sample,
        this.priors.get(metric) ?? {
          mean: global.median(),
          scale: global.robustScale(),
        },
      );
      predictions[metric] = prediction;
      const standardized =
        (transformed - prediction.location) / prediction.scale;
      const direction = standardized < 0 ? "low" : "high";
      const nonconformity = highOnlyMetrics.has(metric)
        ? standardized
        : Math.abs(standardized);
      observations.push({ metric, transformed, nonconformity });
      const cdf = studentTCdf(standardized, prediction.degreesOfFreedom);
      const posteriorP = highOnlyMetrics.has(metric)
        ? 1 - cdf
        : 2 * Math.min(cdf, 1 - cdf);
      const calibration = this.calibration.get(
        `${metric}|${weekend(bucket.start) ? "weekend" : "weekday"}`,
      );
      const conformalP =
        calibration && calibration.count >= MIN_READY_BUCKETS
          ? (1 + calibration.countAtOrAbove(nonconformity)) /
            (calibration.count + 1)
          : posteriorP;
      candidates.push({
        metric,
        observed,
        prediction,
        direction,
        pValue: posteriorP,
        conformalPValue: conformalP,
        calibrationSamples: calibration?.count ?? 0,
        nonconformity,
      });
    }

    const adjusted = benjaminiYekutieli(
      candidates.map(({ pValue }) => pValue),
    );
    const signals = candidates.flatMap((candidate, index): AnomalySignal[] => {
      const adjustedPValue = adjusted[index] ?? 1;
      if (
        adjustedPValue > this.profile.warningFdr ||
        candidate.conformalPValue > this.profile.warningFdr
      ) {
        return [];
      }
      const severity =
        adjustedPValue <= this.profile.criticalFdr ? "critical" : "warning";
      return [{
        metric: candidate.metric,
        direction: candidate.direction,
        observed: candidate.observed,
        expected: candidate.prediction.expected,
        lower99: candidate.prediction.lower99,
        upper99: candidate.prediction.upper99,
        lower999: candidate.prediction.lower999,
        upper999: candidate.prediction.upper999,
        severity,
        rawPValue: candidate.pValue,
        conformalPValue: candidate.conformalPValue,
        adjustedPValue,
        score: -Math.log10(Math.max(adjustedPValue, 1e-12)),
        calibrationSamples: candidate.calibrationSamples,
      }];
    });
    return { signals, predictions, observations };
  }

  observe(bucket: AnomalyMetricBucket, score: BucketScore): void {
    this.acceptedBucketTimes.push(bucket.start);
    for (const observation of score.observations) {
      const global = this.global.get(observation.metric)!;
      global.add(bucket.start, observation.transformed);
      const slots = this.seasonal.get(observation.metric)!;
      const key = seasonalKey(bucket.start);
      const slot = slots.get(key) ?? new RollingDistribution();
      if (!slots.has(key)) slots.set(key, slot);
      slot.add(bucket.start, observation.transformed);
      if (observation.nonconformity !== undefined) {
        const calibrationKey = `${observation.metric}|${
          weekend(bucket.start) ? "weekend" : "weekday"
        }`;
        const calibration =
          this.calibration.get(calibrationKey) ?? new RollingDistribution();
        if (!this.calibration.has(calibrationKey)) {
          this.calibration.set(calibrationKey, calibration);
        }
        calibration.add(bucket.start, observation.nonconformity);
      }
    }
    this.prune(bucket.start);
  }

  expected(
    at: number,
  ): Partial<Record<AnomalyMetricName, MetricPrediction>> {
    const empty: AnomalyMetricBucket = {
      id: "",
      chainId: this.chainId,
      start: at,
      end: at + 300,
      firstBlock: 0,
      lastBlock: 0,
      source: {
        provider: "evm-rpc",
        endpoint: "local",
        queriedAt: new Date(0).toISOString(),
      },
      metrics: Object.fromEntries(
        anomalyMetricNames.flatMap((metric) => {
          const global = this.global.get(metric)!;
          return global.count > 0
            ? [[metric, inverseAnomalyMetric(metric, global.median())]]
            : [];
        }),
      ),
      learning: "accepted",
    };
    return this.preview(empty).predictions;
  }

  private prune(at: number): void {
    const cutoff = at - HISTORY_SECONDS;
    while (
      this.acceptedBucketTimes[0] !== undefined &&
      this.acceptedBucketTimes[0] < cutoff
    ) {
      this.acceptedBucketTimes.shift();
    }
    for (const distribution of this.global.values()) distribution.prune(cutoff);
    for (const slots of this.seasonal.values()) {
      for (const distribution of slots.values()) distribution.prune(cutoff);
    }
    const calibrationCutoff =
      at - this.profile.calibrationDays * 24 * 60 * 60;
    for (const distribution of this.calibration.values()) {
      distribution.prune(calibrationCutoff);
    }
  }

  private refreshPriors(at: number): void {
    const day = Math.floor(at / 86_400);
    if (day === this.priorDay) return;
    this.priorDay = day;
    for (const metric of anomalyMetricNames) {
      const distribution = this.global.get(metric)!;
      if (distribution.count === 0) continue;
      this.priors.set(metric, {
        mean: distribution.median(),
        scale: distribution.robustScale(),
      });
    }
  }
}

export class LegacyBayesianScorer {
  private readonly global = new Map<AnomalyMetricName, RollingDistribution>();
  private readonly seasonal = new Map<
    AnomalyMetricName,
    Map<string, RollingDistribution>
  >();
  private readonly acceptedBucketTimes: number[] = [];

  constructor(readonly chainId: string) {
    for (const metric of anomalyMetricNames) {
      this.global.set(metric, new RollingDistribution());
      this.seasonal.set(metric, new Map());
    }
  }

  preview(bucket: AnomalyMetricBucket): AnomalySignal[] {
    this.prune(bucket.start);
    if (this.acceptedBucketTimes.length < MIN_READY_BUCKETS) return [];
    const signals: AnomalySignal[] = [];
    for (const metric of anomalyMetricNames) {
      const observed = bucket.metrics[metric];
      if (observed === undefined || !Number.isFinite(observed)) continue;
      const global = this.global.get(metric)!;
      if (global.count < MIN_READY_BUCKETS) continue;
      const slot = this.seasonal.get(metric)!.get(seasonalKey(bucket.start));
      const prediction = legacyPrediction(
        metric,
        slot && slot.count >= 7 ? slot : global,
      );
      const critical =
        observed < prediction.lower999 || observed > prediction.upper999;
      const warning =
        observed < prediction.lower99 || observed > prediction.upper99;
      if (!warning) continue;
      const direction = observed < prediction.expected ? "low" : "high";
      if (direction === "low" && highOnlyMetrics.has(metric)) continue;
      signals.push({
        metric,
        direction,
        observed,
        expected: prediction.expected,
        lower99: prediction.lower99,
        upper99: prediction.upper99,
        lower999: prediction.lower999,
        upper999: prediction.upper999,
        severity: critical ? "critical" : "warning",
      });
    }
    return signals;
  }

  observe(bucket: AnomalyMetricBucket): void {
    this.acceptedBucketTimes.push(bucket.start);
    for (const metric of anomalyMetricNames) {
      const observed = bucket.metrics[metric];
      if (observed === undefined || !Number.isFinite(observed)) continue;
      const transformed = transformAnomalyMetric(metric, observed);
      this.global.get(metric)!.add(bucket.start, transformed);
      const slots = this.seasonal.get(metric)!;
      const key = seasonalKey(bucket.start);
      const slot = slots.get(key) ?? new RollingDistribution();
      if (!slots.has(key)) slots.set(key, slot);
      slot.add(bucket.start, transformed);
    }
    this.prune(bucket.start);
  }

  private prune(at: number): void {
    const cutoff = at - HISTORY_SECONDS;
    while (
      this.acceptedBucketTimes[0] !== undefined &&
      this.acceptedBucketTimes[0] < cutoff
    ) {
      this.acceptedBucketTimes.shift();
    }
    for (const distribution of this.global.values()) distribution.prune(cutoff);
    for (const slots of this.seasonal.values()) {
      for (const distribution of slots.values()) distribution.prune(cutoff);
    }
  }
}

export class RobustMadScorer {
  private readonly global = new Map<AnomalyMetricName, RollingDistribution>();
  private readonly seasonal = new Map<
    AnomalyMetricName,
    Map<string, RollingDistribution>
  >();
  private readonly acceptedBucketTimes: number[] = [];
  private readonly globalReference = new Map<
    AnomalyMetricName,
    { median: number; scale: number }
  >();
  private referenceDay = -1;

  constructor(readonly chainId: string) {
    for (const metric of anomalyMetricNames) {
      this.global.set(metric, new RollingDistribution());
      this.seasonal.set(metric, new Map());
    }
  }

  preview(bucket: AnomalyMetricBucket): AnomalySignal[] {
    this.prune(bucket.start);
    this.refreshReference(bucket.start);
    if (this.acceptedBucketTimes.length < MIN_READY_BUCKETS) return [];
    const candidates: Array<{
      metric: AnomalyMetricName;
      direction: "high" | "low";
      observed: number;
      expected: number;
      scale: number;
      transformed: number;
      pValue: number;
    }> = [];
    for (const metric of anomalyMetricNames) {
      const observed = bucket.metrics[metric];
      if (observed === undefined || !Number.isFinite(observed)) continue;
      const global = this.global.get(metric)!;
      if (global.count < MIN_READY_BUCKETS) continue;
      const slot = this.seasonal.get(metric)!.get(seasonalKey(bucket.start));
      const sample = slot && slot.count >= 14 ? slot : global;
      const reference = sample === global
        ? this.globalReference.get(metric)
        : undefined;
      const expectedTransformed = reference?.median ?? sample.median();
      const scale = reference?.scale ?? sample.robustScale();
      const transformed = transformAnomalyMetric(metric, observed);
      const z = (transformed - expectedTransformed) / scale;
      const direction = z < 0 ? "low" : "high";
      if (direction === "low" && highOnlyMetrics.has(metric)) continue;
      const cdf = studentTCdf(z, 1_000_000);
      candidates.push({
        metric,
        direction,
        observed,
        expected: inverseAnomalyMetric(metric, expectedTransformed),
        scale,
        transformed,
        pValue: highOnlyMetrics.has(metric)
          ? 1 - cdf
          : 2 * Math.min(cdf, 1 - cdf),
      });
    }
    const adjusted = benjaminiYekutieli(
      candidates.map(({ pValue }) => pValue),
    );
    return candidates.flatMap((candidate, index): AnomalySignal[] => {
      const adjustedPValue = adjusted[index] ?? 1;
      if (adjustedPValue > 0.01) return [];
      const q99 = studentTQuantile(0.995, 1_000_000) * candidate.scale;
      const q999 = studentTQuantile(0.9995, 1_000_000) * candidate.scale;
      return [{
        metric: candidate.metric,
        direction: candidate.direction,
        observed: candidate.observed,
        expected: candidate.expected,
        lower99: inverseAnomalyMetric(
          candidate.metric,
          transformAnomalyMetric(candidate.metric, candidate.expected) - q99,
        ),
        upper99: inverseAnomalyMetric(
          candidate.metric,
          transformAnomalyMetric(candidate.metric, candidate.expected) + q99,
        ),
        lower999: inverseAnomalyMetric(
          candidate.metric,
          transformAnomalyMetric(candidate.metric, candidate.expected) - q999,
        ),
        upper999: inverseAnomalyMetric(
          candidate.metric,
          transformAnomalyMetric(candidate.metric, candidate.expected) + q999,
        ),
        severity: adjustedPValue <= 0.001 ? "critical" : "warning",
        rawPValue: candidate.pValue,
        adjustedPValue,
        score: -Math.log10(Math.max(adjustedPValue, 1e-12)),
        calibrationSamples: 0,
      }];
    });
  }

  observe(bucket: AnomalyMetricBucket): void {
    this.acceptedBucketTimes.push(bucket.start);
    for (const metric of anomalyMetricNames) {
      const observed = bucket.metrics[metric];
      if (observed === undefined || !Number.isFinite(observed)) continue;
      const transformed = transformAnomalyMetric(metric, observed);
      this.global.get(metric)!.add(bucket.start, transformed);
      const slots = this.seasonal.get(metric)!;
      const key = seasonalKey(bucket.start);
      const slot = slots.get(key) ?? new RollingDistribution();
      if (!slots.has(key)) slots.set(key, slot);
      slot.add(bucket.start, transformed);
    }
    this.prune(bucket.start);
  }

  private prune(at: number): void {
    const cutoff = at - HISTORY_SECONDS;
    while (
      this.acceptedBucketTimes[0] !== undefined &&
      this.acceptedBucketTimes[0] < cutoff
    ) {
      this.acceptedBucketTimes.shift();
    }
    for (const distribution of this.global.values()) distribution.prune(cutoff);
    for (const slots of this.seasonal.values()) {
      for (const distribution of slots.values()) distribution.prune(cutoff);
    }
  }

  private refreshReference(at: number): void {
    const day = Math.floor(at / 86_400);
    if (day === this.referenceDay) return;
    this.referenceDay = day;
    for (const metric of anomalyMetricNames) {
      const distribution = this.global.get(metric)!;
      if (distribution.count === 0) continue;
      this.globalReference.set(metric, {
        median: distribution.median(),
        scale: distribution.robustScale(),
      });
    }
  }
}

export function scoreAnomalyBucketV2(
  bucket: AnomalyMetricBucket,
  history: AnomalyMetricBucket[],
  profile: AnomalyModelProfile = precisionModelProfile,
): AnomalySignal[] {
  const scorer = new BayesianConformalScorer(bucket.chainId, profile);
  scorer.warm(
    history.filter(
      (candidate) =>
        candidate.chainId === bucket.chainId && candidate.start < bucket.start,
    ),
  );
  return scorer.preview(bucket).signals;
}
