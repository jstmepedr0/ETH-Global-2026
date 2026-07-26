import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BayesianConformalScorer,
  LegacyBayesianScorer,
  RobustMadScorer,
  anomalyMetricNames,
  type AnomalyModelProfile,
  type BucketScore,
} from "./anomalyModel.js";
import {
  collectHistoricalAnomalyChunk,
  historicalAnomalyBlockRange,
  type AnomalyChainConfig,
} from "./anomalies.js";
import {
  BitebackError,
  canonicalJson,
  hash,
  type AnomalyMetricBucket,
  type AnomalyMetricName,
  type AnomalySignal,
} from "./domain.js";

export const BENCHMARK_FROM = Date.parse("2025-07-26T00:00:00Z") / 1_000;
export const BENCHMARK_TO = Date.parse("2026-07-26T00:00:00Z") / 1_000;
export const BENCHMARK_WARMUP_TO = Date.parse("2025-08-25T00:00:00Z") / 1_000;
export const BENCHMARK_TUNING_TO = Date.parse("2026-03-26T00:00:00Z") / 1_000;
export const BENCHMARK_BUCKETS_PER_CHAIN = 105_120;
export const BENCHMARK_SCORED_BUCKETS_PER_CHAIN = 96_480;
export const BENCHMARK_BLOCK_CHUNK = 50_000;
export const BENCHMARK_ARTIFACT = "benchmark/anomaly-annual-v2.json";
export const BENCHMARK_LABELS = "benchmark/anomaly-labels-v1.json";

export const ANOMALY_RESEARCH_INDEX = [
  {
    id: "streaming-latency",
    citation: "Lavin & Ahmad, 2015",
    title: "Numenta Anomaly Benchmark",
    url: "https://arxiv.org/abs/1510.03336",
    focus: "Streaming evaluation and detection latency",
    modelApplication:
      "Score every 5-minute bucket before learning from it, then measure first-alert latency inside each official incident window.",
  },
  {
    id: "no-point-adjustment",
    citation: "Kim et al., 2021",
    title: "Current Time Series Anomaly Detection Benchmarks are Flawed",
    url: "https://arxiv.org/abs/2109.05257",
    focus: "Evaluation without point-adjusted F1",
    modelApplication:
      "Count each contiguous alert episode once. Never expand a single detection across an incident window or score with future labels.",
  },
  {
    id: "precision-recall",
    citation: "Saito & Rehmsmeier, 2015",
    title:
      "The Precision-Recall Plot Is More Informative than the ROC Plot When Evaluating Binary Classifiers on Imbalanced Datasets",
    url: "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0118432",
    focus: "Rare-event precision-recall evaluation",
    modelApplication:
      "Prioritize event-level precision-recall and unmatched alert burden over ROC because confirmed chain incidents are rare.",
  },
] as const;

export const ANOMALY_MODEL_INDEX = [
  {
    id: "bayesian-nig-v1",
    role: "Production baseline",
    method: "Seasonal Normal-Inverse-Gamma posterior predictive intervals",
    evaluation: "Retained unless the frozen v2 candidate passes every promotion gate.",
  },
  {
    id: "seasonal-mad",
    role: "Robust challenger",
    method: "Rolling seasonal median and median absolute deviation",
    evaluation: "Tests whether a simpler robust baseline reduces unmatched alerts.",
  },
  {
    id: "bayesian-nig-conformal-v2",
    role: "Promotion candidate",
    method: "Corrected NIG, conformal tail probabilities, and BY false-discovery control",
    evaluation: "Tuned before holdout and promoted only without observable-event recall regression.",
  },
] as const;

export interface BenchmarkLabel {
  id: string;
  chainId: string;
  name: string;
  startedAt: string;
  endedAt: string;
  component?: string;
  observability?: "canonical" | "observer-simulation" | "excluded";
  exclusionReason?: string | null;
  source: string;
}

export interface BenchmarkLabelManifest {
  version: string;
  window: { from: string; to: string };
  labels: BenchmarkLabel[];
  exclusions: BenchmarkLabel[];
}

export interface BenchmarkEpisode {
  id: string;
  chainId: string;
  startedAt: number;
  endedAt: number;
  severity: "warning" | "critical";
  score: number;
  metrics: AnomalyMetricName[];
}

interface ScoredBucket {
  start: number;
  signals: AnomalySignal[];
  predictions?: BucketScore["predictions"];
  metrics?: AnomalyMetricBucket["metrics"];
}

interface DetectorRun {
  chainId: string;
  buckets: ScoredBucket[];
  episodes: BenchmarkEpisode[];
}

export interface BenchmarkModelResult {
  id: "bayesian-nig-v1" | "seasonal-mad" | "bayesian-nig-conformal-v2";
  promoted: boolean;
  eventRecall: number;
  matchedEvents: number;
  observableEvents: number;
  unmatchedEpisodes: number;
  alertEpisodes: number;
  alertsPer30ChainDays: number;
  medianLatencyMinutes: number | null;
  meanLatencyScore: number | null;
  syntheticCriticalRecall?: number;
  empiricalCoverage99?: number;
  empiricalCoverage999?: number;
}

interface CandidateResult {
  profile: AnomalyModelProfile;
  syntheticCriticalRecall: number;
  tuningUnmatchedEpisodes: number;
  holdoutRecall: number | null;
  medianLatencyMinutes: number;
}

interface CacheState {
  version: 1;
  chainId: string;
  startBlock: number;
  stopBlock: number;
  nextBlock: number;
  lastBucketStart?: number;
  complete: boolean;
}

const benchmarkChains: AnomalyChainConfig[] = [
  {
    id: "base",
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    substreamsEndpoint: "https://base.substreams.pinax.network",
    confirmations: 20,
  },
  {
    id: "optimism",
    name: "Optimism",
    chainId: 10,
    rpcUrl: "https://mainnet.optimism.io",
    substreamsEndpoint: "https://optimism.substreams.pinax.network",
    confirmations: 20,
  },
  {
    id: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    substreamsEndpoint: "https://arb-one.streamingfast.io",
    confirmations: 64,
  },
];

function benchmarkChainConfiguration(): AnomalyChainConfig[] {
  const configured = process.env.ANOMALY_BENCHMARK_CHAINS_JSON;
  if (!configured) return benchmarkChains;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_CONFIG_INVALID",
      "ANOMALY_BENCHMARK_CHAINS_JSON must be valid JSON.",
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_CONFIG_INVALID",
      "The annual benchmark requires Base, Optimism, and Arbitrum One.",
    );
  }
  return parsed as AnomalyChainConfig[];
}

export async function loadBenchmarkLabels(
  file = BENCHMARK_LABELS,
): Promise<BenchmarkLabelManifest> {
  const manifest = JSON.parse(await readFile(file, "utf8")) as BenchmarkLabelManifest;
  if (
    manifest.window.from !== "2025-07-26T00:00:00Z" ||
    manifest.window.to !== "2026-07-26T00:00:00Z"
  ) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_LABELS_INVALID",
      "The label manifest does not match the frozen annual window.",
    );
  }
  for (const label of [...manifest.labels, ...manifest.exclusions]) {
    if (
      !label.id ||
      !label.chainId ||
      Date.parse(label.startedAt) >= Date.parse(label.endedAt) ||
      !label.component ||
      !label.observability ||
      !label.source.startsWith("https://") ||
      (label.observability === "excluded" && !label.exclusionReason)
    ) {
      throw new BitebackError(
        "ANOMALY_BENCHMARK_LABELS_INVALID",
        `Invalid benchmark label ${label.id || "(missing id)"}.`,
      );
    }
  }
  return manifest;
}

function cachePaths(output: string, chainId: string) {
  return {
    buckets: join(output, `${chainId}.ndjson`),
    state: join(output, `${chainId}.state.json`),
  };
}

async function readCacheState(file: string): Promise<CacheState | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as CacheState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(
  file: string,
  value: unknown,
  pretty = true,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`,
  );
  await rename(temporary, file);
}

async function readBucketCache(file: string): Promise<AnomalyMetricBucket[]> {
  try {
    const content = await readFile(file, "utf8");
    const byStart = new Map<number, AnomalyMetricBucket>();
    for (const line of content.split("\n")) {
      if (!line) continue;
      const bucket = JSON.parse(line) as AnomalyMetricBucket;
      byStart.set(bucket.start, bucket);
    }
    return [...byStart.values()].sort((left, right) => left.start - right.start);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function normalizedAnnualBuckets(
  chainId: string,
  cached: AnomalyMetricBucket[],
): AnomalyMetricBucket[] {
  const byStart = new Map(
    cached
      .filter(({ start }) => start >= BENCHMARK_FROM && start < BENCHMARK_TO)
      .map((bucket) => [bucket.start, bucket]),
  );
  const buckets: AnomalyMetricBucket[] = [];
  for (let start = BENCHMARK_FROM; start < BENCHMARK_TO; start += 300) {
    const found = byStart.get(start);
    if (!found) {
      throw new BitebackError(
        "ANOMALY_BENCHMARK_SOURCE_GAP",
        `${chainId} cache is missing bucket ${new Date(start * 1_000).toISOString()}.`,
        502,
      );
    }
    buckets.push(found);
  }
  if (buckets.length !== BENCHMARK_BUCKETS_PER_CHAIN) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_COVERAGE_INVALID",
      `${chainId} has ${buckets.length} buckets; expected ${BENCHMARK_BUCKETS_PER_CHAIN}.`,
      502,
    );
  }
  return buckets;
}

export async function ingestAnnualBenchmarkChain(
  chain: AnomalyChainConfig,
  output = "output/anomaly-benchmark",
  progress: (message: string) => void = console.log,
): Promise<AnomalyMetricBucket[]> {
  if (!chain.substreamsEndpoint) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_CONFIG_INVALID",
      `${chain.name} has no Substreams endpoint; annual RPC fallback is forbidden.`,
    );
  }
  await mkdir(output, { recursive: true });
  const paths = cachePaths(output, chain.id);
  let state = await readCacheState(paths.state);
  if (!state) {
    const range = await historicalAnomalyBlockRange(
      chain,
      BENCHMARK_FROM,
      BENCHMARK_TO,
    );
    state = {
      version: 1,
      chainId: chain.id,
      startBlock: range.startBlock,
      stopBlock: range.stopBlock,
      nextBlock: range.startBlock,
      complete: false,
    };
    await writeAtomic(paths.state, state);
  }
  if (
    state.chainId !== chain.id ||
    state.startBlock > state.stopBlock ||
    state.nextBlock < state.startBlock
  ) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_CACHE_INVALID",
      `Invalid resume state for ${chain.id}.`,
    );
  }

  while (!state.complete) {
    const stop = Math.min(
      state.stopBlock,
      state.nextBlock + BENCHMARK_BLOCK_CHUNK - 1,
    );
    progress(`${chain.name}: blocks ${state.nextBlock}-${stop}`);
    const chunk = await collectHistoricalAnomalyChunk(
      chain,
      state.nextBlock,
      stop,
    );
    if (
      chunk.blockCount !== stop - state.nextBlock + 1 ||
      chunk.firstBlock !== state.nextBlock ||
      chunk.lastBlock !== stop
    ) {
      throw new BitebackError(
        "ANOMALY_BENCHMARK_SOURCE_GAP",
        `${chain.name} returned incomplete block coverage.`,
        502,
      );
    }

    const finalChunk = stop === state.stopBlock;
    const completeBuckets = finalChunk ? chunk.buckets : chunk.buckets.slice(0, -1);
    const newBuckets = completeBuckets.filter(
      ({ start }) =>
        start >= BENCHMARK_FROM &&
        start < BENCHMARK_TO &&
        (state!.lastBucketStart === undefined || start > state!.lastBucketStart),
    );
    if (newBuckets.length > 0) {
      await appendFile(
        paths.buckets,
        `${newBuckets.map((bucket) => JSON.stringify(bucket)).join("\n")}\n`,
      );
      state.lastBucketStart = newBuckets.at(-1)!.start;
    }
    if (finalChunk) {
      state.nextBlock = state.stopBlock + 1;
      state.complete = true;
    } else {
      const partial = chunk.buckets.at(-1);
      if (!partial || partial.firstBlock <= state.nextBlock) {
        throw new BitebackError(
          "ANOMALY_BENCHMARK_CACHE_INVALID",
          `${chain.name} could not establish a safe chunk boundary.`,
        );
      }
      state.nextBlock = partial.firstBlock;
    }
    await writeAtomic(paths.state, state);
  }
  return normalizedAnnualBuckets(chain.id, await readBucketCache(paths.buckets));
}

function overlaps(
  episode: BenchmarkEpisode,
  label: BenchmarkLabel,
  tolerance = 300,
): boolean {
  const start = Date.parse(label.startedAt) / 1_000;
  const end = Date.parse(label.endedAt) / 1_000;
  return (
    episode.startedAt >= start - tolerance &&
    episode.startedAt <= end + tolerance &&
    episode.endedAt >= start
  );
}

export function matchBenchmarkEpisodes(
  episodes: BenchmarkEpisode[],
  labels: BenchmarkLabel[],
): {
  matchedLabelIds: string[];
  unmatched: BenchmarkEpisode[];
  latenciesMinutes: number[];
} {
  const matched = new Set<string>();
  const matchedEpisodes = new Set<string>();
  const latencies: number[] = [];
  for (const label of labels) {
    const candidate = episodes
      .filter((episode) => episode.chainId === label.chainId && overlaps(episode, label))
      .sort((left, right) => left.startedAt - right.startedAt)[0];
    if (!candidate) continue;
    matched.add(label.id);
    matchedEpisodes.add(candidate.id);
    latencies.push(
      Math.max(
        0,
        (candidate.startedAt - Date.parse(label.startedAt) / 1_000) / 60,
      ),
    );
  }
  return {
    matchedLabelIds: [...matched],
    unmatched: episodes.filter((episode) => !matchedEpisodes.has(episode.id)),
    latenciesMinutes: latencies,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function episodesFromScores(
  chainId: string,
  buckets: ScoredBucket[],
  warningPersistence: number,
  warningFdr?: number,
  criticalFdr?: number,
): BenchmarkEpisode[] {
  const consecutive = new Map<string, { count: number; startedAt: number }>();
  const episodes: BenchmarkEpisode[] = [];
  let active: BenchmarkEpisode | undefined;
  let previousStart = -1;

  for (const bucket of buckets) {
    const available = bucket.signals.filter((signal) => {
      if (warningFdr === undefined) return true;
      return (
        (signal.adjustedPValue ?? 1) <= warningFdr &&
        (signal.conformalPValue ?? signal.rawPValue ?? 1) <= warningFdr
      );
    });
    const currentKeys = new Set(
      available.map(({ metric, direction }) => `${metric}|${direction}`),
    );
    for (const key of consecutive.keys()) {
      if (!currentKeys.has(key) || bucket.start !== previousStart + 300) {
        consecutive.delete(key);
      }
    }

    const triggered: AnomalySignal[] = [];
    let episodeStart = bucket.start;
    for (const signal of available) {
      const key = `${signal.metric}|${signal.direction}`;
      const critical = criticalFdr === undefined
        ? signal.severity === "critical"
        : (signal.adjustedPValue ?? 1) <= criticalFdr;
      if (critical) {
        triggered.push({ ...signal, severity: "critical" });
        continue;
      }
      const run = consecutive.get(key);
      const next = {
        count: (run?.count ?? 0) + 1,
        startedAt: run?.startedAt ?? bucket.start,
      };
      consecutive.set(key, next);
      if (next.count >= warningPersistence) {
        triggered.push({ ...signal, severity: "warning" });
        episodeStart = Math.min(episodeStart, next.startedAt);
      }
    }

    if (triggered.length > 0) {
      const severity = triggered.some(({ severity }) => severity === "critical")
        ? "critical"
        : "warning";
      const metrics = [...new Set(triggered.map(({ metric }) => metric))];
      const score = Math.max(
        0,
        ...triggered.map((signal) => signal.score ?? (
          signal.severity === "critical" ? 3.3 : 2.58
        )),
      );
      if (active && episodeStart <= active.endedAt) {
        active.endedAt = bucket.start + 300;
        active.score = Math.max(active.score, score);
        active.severity =
          active.severity === "critical" || severity === "critical"
            ? "critical"
            : "warning";
        active.metrics = [...new Set([...active.metrics, ...metrics])];
      } else {
        active = {
          id: hash(`${chainId}|${episodeStart}|${episodes.length}`),
          chainId,
          startedAt: episodeStart,
          endedAt: bucket.start + 300,
          severity,
          score,
          metrics,
        };
        episodes.push(active);
      }
    } else {
      active = undefined;
    }
    previousStart = bucket.start;
  }
  return episodes;
}

function filterRange<T extends { startedAt: number }>(
  values: T[],
  from: number,
  to: number,
): T[] {
  return values.filter(({ startedAt }) => startedAt >= from && startedAt < to);
}

function outsideExclusions(
  episodes: BenchmarkEpisode[],
  exclusions: BenchmarkLabel[],
): BenchmarkEpisode[] {
  return episodes.filter(
    (episode) =>
      !exclusions.some(
        (label) => label.chainId === episode.chainId && overlaps(episode, label, 0),
      ),
  );
}

type ScorerKind = "v1" | "mad" | "v2";

function evaluateChain(
  chainId: string,
  annual: AnomalyMetricBucket[],
  kind: ScorerKind,
  profile?: AnomalyModelProfile,
  retainDetail = false,
): DetectorRun {
  const v1 = kind === "v1" ? new LegacyBayesianScorer(chainId) : undefined;
  const mad = kind === "mad" ? new RobustMadScorer(chainId) : undefined;
  const v2 =
    kind === "v2" ? new BayesianConformalScorer(chainId, profile) : undefined;
  const buckets: ScoredBucket[] = [];

  for (const bucket of annual) {
    let signals: AnomalySignal[];
    let predictions: BucketScore["predictions"] | undefined;
    let observations: BucketScore["observations"] | undefined;
    if (v2) {
      const score = v2.preview(bucket);
      signals = score.signals;
      predictions = score.predictions;
      observations = score.observations;
    } else if (v1) {
      signals = v1.preview(bucket);
    } else {
      signals = mad!.preview(bucket);
    }
    if (bucket.start >= BENCHMARK_WARMUP_TO) {
      buckets.push({
        start: bucket.start,
        signals,
        ...(retainDetail && predictions ? { predictions } : {}),
        ...(retainDetail ? { metrics: bucket.metrics } : {}),
      });
    }
    if (signals.length === 0) {
      if (v2) {
        v2.observe(bucket, { signals, predictions: predictions!, observations: observations! });
      } else if (v1) {
        v1.observe(bucket);
      } else {
        mad!.observe(bucket);
      }
    }
  }
  const episodes = episodesFromScores(
    chainId,
    buckets,
    profile?.warningPersistence ?? 2,
    profile?.warningFdr,
    profile?.criticalFdr,
  );
  return {
    chainId,
    buckets,
    episodes,
  };
}

function syntheticBuckets(chainId = "synthetic"): {
  buckets: AnomalyMetricBucket[];
  labels: BenchmarkLabel[];
  exclusions: BenchmarkLabel[];
} {
  const from = Date.parse("2025-09-01T00:00:00Z") / 1_000;
  const source = {
    provider: "the-graph-substreams" as const,
    endpoint: "fixture",
    queriedAt: "2026-07-26T00:00:00.000Z",
  };
  let seed = 0x5eed1234;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const events = [
    { id: "spike", at: 35 * 288 + 24, length: 2 },
    { id: "drop", at: 38 * 288 + 80, length: 3 },
    { id: "failure", at: 41 * 288 + 120, length: 2 },
    { id: "congestion", at: 44 * 288 + 180, length: 4 },
    { id: "stall-5", at: 48 * 288 + 30, length: 1 },
    { id: "stall-60", at: 51 * 288 + 210, length: 12 },
    { id: "drift", at: 53 * 288 + 120, length: 12 },
    { id: "regime", at: 55 * 288 + 60, length: 6 },
  ];
  const bucketCount = 60 * 288;
  const buckets: AnomalyMetricBucket[] = Array.from(
    { length: bucketCount },
    (_, index) => {
    const start = from + index * 300;
    const slot = index % 288;
    const daily = 1 + 0.18 * Math.sin((slot / 288) * Math.PI * 2);
    const noise = 0.97 + random() * 0.06;
    const metrics: Record<AnomalyMetricName, number> = {
      blocksPerMinute: 30 * noise,
      tps: 55 * daily * noise,
      averageTransactionFeeWei: 2e12 * daily * noise,
      averageEffectiveGasPriceWei: 2e8 * daily * noise,
      gasUtilization: Math.min(0.9, 0.42 * daily * noise),
      failedTransactionRate: 0.008 * noise,
      averageBlockIntervalSeconds: 2 / noise,
      averageUniqueSendersPerBlock: 19 * daily * noise,
    };
    const event = events.find(
      ({ at, length }) => index >= at && index < at + length,
    );
    if (event?.id === "spike") metrics.tps *= 15;
    if (event?.id === "drop") {
      metrics.tps *= 0.01;
      metrics.averageUniqueSendersPerBlock *= 0.02;
    }
    if (event?.id === "failure") metrics.failedTransactionRate = 0.75;
    if (event?.id === "congestion") {
      metrics.gasUtilization = 0.999;
      metrics.averageTransactionFeeWei *= 80;
      metrics.averageEffectiveGasPriceWei *= 80;
    }
    if (event?.id.startsWith("stall")) {
      metrics.blocksPerMinute = 0;
      metrics.tps = 0;
      metrics.averageBlockIntervalSeconds = 300;
      metrics.averageUniqueSendersPerBlock = 0;
    }
    if (event?.id === "drift") {
      const offset = index - event.at + 1;
      metrics.tps *= 1 + offset * 1.5;
      metrics.averageTransactionFeeWei *= 1 + offset * 1.2;
    }
    if (event?.id === "regime") {
      metrics.tps *= 6;
      metrics.gasUtilization = 0.98;
    }
    return {
      id: hash(`${chainId}|${start}`),
      chainId,
      start,
      end: start + 300,
      firstBlock: index,
      lastBlock: index,
      source,
      metrics,
      learning: "accepted" as const,
    };
  });
  const labels = events.map(({ id, at, length }) => ({
    id: `synthetic-${id}`,
    chainId,
    name: `Seeded ${id}`,
    startedAt: new Date((from + at * 300) * 1_000).toISOString(),
    endedAt: new Date((from + (at + length) * 300) * 1_000).toISOString(),
    component: "synthetic",
    observability: "canonical" as const,
    source: "fixture://seed-5eed1234",
  }));
  const outageAt = 58 * 288;
  buckets[outageAt]!.metrics = {};
  return {
    buckets,
    labels,
    exclusions: [{
      id: "synthetic-provider-outage",
      chainId,
      name: "Single-provider outage",
      startedAt: new Date((from + outageAt * 300) * 1_000).toISOString(),
      endedAt: new Date((from + (outageAt + 1) * 300) * 1_000).toISOString(),
      exclusionReason: "Source degradation is not a chain anomaly.",
      source: "fixture://seed-5eed1234",
    }],
  };
}

function profileKey(profile: AnomalyModelProfile): string {
  return [
    profile.slotMinimum,
    profile.calibrationDays,
    profile.warningFdr,
    profile.criticalFdr,
    profile.warningPersistence,
  ].join("|");
}

function coreProfiles(): AnomalyModelProfile[] {
  return ([7, 14] as const).flatMap((slotMinimum) =>
    ([14, 30] as const).flatMap((calibrationDays) =>
      ([0.005, 0.01] as const).map((warningFdr) => ({
        slotMinimum,
        calibrationDays,
        warningFdr,
        criticalFdr: 0.001 as const,
        warningPersistence: 2 as const,
      })),
    ),
  );
}

export function benchmarkCandidateProfiles(): AnomalyModelProfile[] {
  return coreProfiles().flatMap((core) =>
    ([0.0005, 0.001] as const).flatMap((criticalFdr) =>
      ([2, 3] as const).map((warningPersistence) => ({
        ...core,
        criticalFdr,
        warningPersistence,
      })),
    ),
  );
}

export function runSyntheticBenchmarkFixture(
  profile: AnomalyModelProfile,
): {
  criticalRecall: number;
  matchedEvents: number;
  totalEvents: number;
  providerOutageAlerts: number;
} {
  const synthetic = syntheticBuckets();
  const run = evaluateChain(
    "synthetic",
    synthetic.buckets,
    "v2",
    profile,
  );
  const episodes = episodesFromScores(
    run.chainId,
    run.buckets,
    profile.warningPersistence,
    profile.warningFdr,
    profile.criticalFdr,
  );
  const critical = episodes.filter(({ severity }) => severity === "critical");
  const matched = matchBenchmarkEpisodes(critical, synthetic.labels);
  const providerOutageAlerts = episodes.filter((episode) =>
    synthetic.exclusions.some((label) => overlaps(episode, label, 0)),
  ).length;
  return {
    criticalRecall: matched.matchedLabelIds.length / synthetic.labels.length,
    matchedEvents: matched.matchedLabelIds.length,
    totalEvents: synthetic.labels.length,
    providerOutageAlerts,
  };
}

function reepisode(run: DetectorRun, profile: AnomalyModelProfile): DetectorRun {
  return {
    ...run,
    episodes: episodesFromScores(
      run.chainId,
      run.buckets,
      profile.warningPersistence,
      profile.warningFdr,
      profile.criticalFdr,
    ),
  };
}

function labelsInRange(
  labels: BenchmarkLabel[],
  from: number,
  to: number,
): BenchmarkLabel[] {
  return labels.filter((label) => {
    const start = Date.parse(label.startedAt) / 1_000;
    return start >= from && start < to;
  });
}

function candidateResult(
  profile: AnomalyModelProfile,
  coreRuns: DetectorRun[],
  syntheticCore: DetectorRun,
  synthetic: ReturnType<typeof syntheticBuckets>,
  labels: BenchmarkLabelManifest,
): CandidateResult {
  const runs = coreRuns.map((run) => reepisode(run, profile));
  const syntheticRun = reepisode(syntheticCore, profile);
  const syntheticMatch = matchBenchmarkEpisodes(
    syntheticRun.episodes.filter(({ severity }) => severity === "critical"),
    synthetic.labels,
  );
  const devLabels = labelsInRange(
    labels.labels.filter(({ observability }) => observability === "canonical"),
    BENCHMARK_WARMUP_TO,
    BENCHMARK_TUNING_TO,
  );
  const devEpisodes = outsideExclusions(
    runs.flatMap(({ episodes }) =>
      filterRange(episodes, BENCHMARK_WARMUP_TO, BENCHMARK_TUNING_TO),
    ),
    labels.exclusions,
  );
  const devMatch = matchBenchmarkEpisodes(devEpisodes, devLabels);
  const cleanDevEpisodes = outsideExclusions(devEpisodes, devLabels);
  return {
    profile,
    syntheticCriticalRecall:
      synthetic.labels.length === 0
        ? 0
        : syntheticMatch.matchedLabelIds.length / synthetic.labels.length,
    tuningUnmatchedEpisodes: cleanDevEpisodes.length,
    holdoutRecall: null,
    medianLatencyMinutes: median(devMatch.latenciesMinutes),
  };
}

function modelResult(
  id: BenchmarkModelResult["id"],
  runs: DetectorRun[],
  manifest: BenchmarkLabelManifest,
  promoted: boolean,
  syntheticCriticalRecall?: number,
): BenchmarkModelResult {
  const canonical = manifest.labels.filter(
    ({ observability }) => observability === "canonical",
  );
  const episodes = outsideExclusions(
    runs.flatMap(({ episodes }) => episodes),
    manifest.exclusions,
  );
  const matched = matchBenchmarkEpisodes(episodes, canonical);
  const labeledWindows = [...manifest.labels, ...manifest.exclusions];
  const calibration = { total: 0, inside99: 0, inside999: 0 };
  for (const run of runs) {
    for (const bucket of run.buckets) {
      if (
        labeledWindows.some((label) => {
          if (label.chainId !== run.chainId) return false;
          const start = Date.parse(label.startedAt) / 1_000;
          const end = Date.parse(label.endedAt) / 1_000;
          return bucket.start >= start && bucket.start < end;
        })
      ) {
        continue;
      }
      for (const metric of anomalyMetricNames) {
        const observed = bucket.metrics?.[metric];
        const prediction = bucket.predictions?.[metric];
        if (observed === undefined || !prediction) continue;
        calibration.total += 1;
        if (observed >= prediction.lower99 && observed <= prediction.upper99) {
          calibration.inside99 += 1;
        }
        if (
          observed >= prediction.lower999 &&
          observed <= prediction.upper999
        ) {
          calibration.inside999 += 1;
        }
      }
    }
  }
  const chainDays = 3 * ((BENCHMARK_TO - BENCHMARK_WARMUP_TO) / 86_400);
  return {
    id,
    promoted,
    eventRecall:
      canonical.length === 0 ? 0 : matched.matchedLabelIds.length / canonical.length,
    matchedEvents: matched.matchedLabelIds.length,
    observableEvents: canonical.length,
    unmatchedEpisodes: matched.unmatched.length,
    alertEpisodes: episodes.length,
    alertsPer30ChainDays: matched.unmatched.length / chainDays * 30,
    medianLatencyMinutes:
      matched.latenciesMinutes.length > 0
        ? median(matched.latenciesMinutes)
        : null,
    meanLatencyScore:
      matched.latenciesMinutes.length > 0
        ? matched.latenciesMinutes.reduce(
            (total, latency) => total + Math.exp(-latency / 30),
            0,
          ) / matched.latenciesMinutes.length
        : null,
    ...(syntheticCriticalRecall === undefined
      ? {}
      : { syntheticCriticalRecall }),
    ...(calibration.total === 0
      ? {}
      : {
          empiricalCoverage99: calibration.inside99 / calibration.total,
          empiricalCoverage999: calibration.inside999 / calibration.total,
        }),
  };
}

function precisionRecallSeries(
  id: BenchmarkModelResult["id"],
  runs: DetectorRun[],
  manifest: BenchmarkLabelManifest,
) {
  const canonical = manifest.labels.filter(
    ({ observability }) => observability === "canonical",
  );
  const episodes = outsideExclusions(
    runs.flatMap(({ episodes }) => episodes),
    manifest.exclusions,
  );
  return {
    model: id,
    points: (["warning", "critical"] as const).map((threshold) => {
      const eligible =
        threshold === "warning"
          ? episodes
          : episodes.filter(({ severity }) => severity === "critical");
      const match = matchBenchmarkEpisodes(eligible, canonical);
      return {
        threshold,
        precisionProxy:
          match.matchedLabelIds.length /
          Math.max(1, match.matchedLabelIds.length + match.unmatched.length),
        recall:
          canonical.length === 0
            ? 0
            : match.matchedLabelIds.length / canonical.length,
      };
    }),
  };
}

function checksumBuckets(buckets: AnomalyMetricBucket[]): string {
  const digest = createHash("sha256");
  for (const bucket of buckets) {
    digest.update(
      canonicalJson({
        chainId: bucket.chainId,
        start: bucket.start,
        firstBlock: bucket.firstBlock,
        lastBlock: bucket.lastBlock,
        metrics: bucket.metrics,
      }),
    );
    digest.update("\n");
  }
  return `sha256:${digest.digest("hex")}`;
}

async function checksumInput(location: string): Promise<string> {
  let bytes: Uint8Array;
  if (location.startsWith("http")) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`${location} returned ${response.status}.`);
    }
    const buffer: ArrayBuffer = await response.arrayBuffer();
    bytes = new Uint8Array(buffer);
  } else {
    bytes = await readFile(location);
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hourlyScores(run: DetectorRun): Array<{ at: number; score: number }> {
  const hourly = new Map<number, number>();
  for (const bucket of run.buckets) {
    const hour = Math.floor(bucket.start / 3_600) * 3_600;
    const score = Math.max(
      0,
      ...bucket.signals.map(
        ({ score, severity }) =>
          score ?? (severity === "critical" ? 3.3 : 2.58),
      ),
    );
    hourly.set(hour, Math.max(hourly.get(hour) ?? 0, score));
  }
  return [...hourly].map(([at, score]) => ({
    at,
    score: Number(score.toFixed(3)),
  }));
}

function eventDetails(
  runs: DetectorRun[],
  labels: BenchmarkLabel[],
): Array<{
  id: string;
  metric: AnomalyMetricName | null;
  detectionAt: number | null;
  points: Array<{
    at: number;
    observed: number;
    expected: number;
    lower99: number;
    upper99: number;
    lower999: number;
    upper999: number;
  }>;
}> {
  return labels.map((label) => {
    const run = runs.find(({ chainId }) => chainId === label.chainId);
    if (!run) return { id: label.id, metric: null, detectionAt: null, points: [] };
    const from = Date.parse(label.startedAt) / 1_000 - 6 * 3_600;
    const to = Date.parse(label.endedAt) / 1_000 + 6 * 3_600;
    const window = run.buckets.filter(
      ({ start }) => start >= from && start <= to,
    );
    const strongest = window
      .flatMap((bucket) =>
        bucket.signals.map((signal) => ({ bucket, signal })),
      )
      .sort(
        (left, right) =>
          (right.signal.score ?? 0) - (left.signal.score ?? 0),
      )[0];
    const metric = strongest?.signal.metric ?? null;
    return {
      id: label.id,
      metric,
      detectionAt: strongest?.bucket.start ?? null,
      points: metric
        ? window.flatMap((bucket) => {
            const prediction = bucket.predictions?.[metric];
            const observed =
              bucket.metrics?.[metric] ??
              bucket.signals.find((candidate) => candidate.metric === metric)
                ?.observed;
            const signal = bucket.signals.find(
              (candidate) => candidate.metric === metric,
            );
            const range = prediction ?? signal;
            return range && observed !== undefined
              ? [{
                  at: bucket.start,
                  observed,
                  expected: range.expected,
                  lower99: range.lower99,
                  upper99: range.upper99,
                  lower999: range.lower999,
                  upper999: range.upper999,
                }]
              : [];
          })
        : [],
    };
  });
}

function perChainResults(
  runs: DetectorRun[],
  labels: BenchmarkLabelManifest,
): Array<{
  chainId: string;
  buckets: number;
  scoredBuckets: number;
  observableEvents: number;
  matchedEvents: number;
  unmatchedEpisodes: number;
  medianLatencyMinutes: number | null;
}> {
  return runs.map((run) => {
    const canonical = labels.labels.filter(
      (label) =>
        label.chainId === run.chainId && label.observability === "canonical",
    );
    const episodes = outsideExclusions(run.episodes, labels.exclusions);
    const match = matchBenchmarkEpisodes(episodes, canonical);
    return {
      chainId: run.chainId,
      buckets: BENCHMARK_BUCKETS_PER_CHAIN,
      scoredBuckets: run.buckets.length,
      observableEvents: canonical.length,
      matchedEvents: match.matchedLabelIds.length,
      unmatchedEpisodes: match.unmatched.length,
      medianLatencyMinutes:
        match.latenciesMinutes.length > 0 ? median(match.latenciesMinutes) : null,
    };
  });
}

export async function buildAnnualBenchmark(
  options: {
    output?: string;
    artifact?: string;
    progress?: (message: string) => void;
  } = {},
): Promise<Record<string, unknown>> {
  const output = options.output ?? "output/anomaly-benchmark";
  const artifactFile = options.artifact ?? BENCHMARK_ARTIFACT;
  const progress = options.progress ?? console.log;
  if (!process.env.PINAX_JWT) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_AUTH_REQUIRED",
      "PINAX_JWT is required for the annual Substreams benchmark.",
      503,
    );
  }
  const labels = await loadBenchmarkLabels();
  const chains = benchmarkChainConfiguration();
  const annualByChain = new Map<string, AnomalyMetricBucket[]>();
  for (const chain of chains) {
    annualByChain.set(
      chain.id,
      await ingestAnnualBenchmarkChain(chain, output, progress),
    );
  }
  for (const [chainId, buckets] of annualByChain) {
    if (
      buckets.length !== BENCHMARK_BUCKETS_PER_CHAIN ||
      buckets.filter(({ start }) => start >= BENCHMARK_WARMUP_TO).length !==
        BENCHMARK_SCORED_BUCKETS_PER_CHAIN
    ) {
      throw new BitebackError(
        "ANOMALY_BENCHMARK_COVERAGE_INVALID",
        `${chainId} does not have exact annual/scored coverage.`,
      );
    }
  }

  progress("Evaluating bayesian-nig-v1 and seasonal MAD.");
  const v1Runs = [...annualByChain].map(([chainId, buckets]) =>
    evaluateChain(chainId, buckets, "v1"),
  );
  const madRuns = [...annualByChain].map(([chainId, buckets]) =>
    evaluateChain(chainId, buckets, "mad"),
  );
  const synthetic = syntheticBuckets();
  const candidates: CandidateResult[] = [];
  for (const profile of coreProfiles()) {
    progress(`Evaluating v2 core ${profileKey(profile)}.`);
    const annual = [...annualByChain].map(([chainId, buckets]) =>
      evaluateChain(chainId, buckets, "v2", profile),
    );
    const syntheticRun = evaluateChain(
      "synthetic",
      synthetic.buckets,
      "v2",
      profile,
    );
    for (const criticalFdr of [0.0005, 0.001] as const) {
      for (const warningPersistence of [2, 3] as const) {
        candidates.push(
          candidateResult(
            { ...profile, criticalFdr, warningPersistence },
            annual,
            syntheticRun,
            synthetic,
            labels,
          ),
        );
      }
    }
  }
  const holdoutLabels = labelsInRange(
    labels.labels.filter(({ observability }) => observability === "canonical"),
    BENCHMARK_TUNING_TO,
    BENCHMARK_TO,
  );
  const v1HoldoutEpisodes = outsideExclusions(
    v1Runs.flatMap(({ episodes }) =>
      filterRange(episodes, BENCHMARK_TUNING_TO, BENCHMARK_TO),
    ),
    labels.exclusions,
  );
  const v1HoldoutMatch = matchBenchmarkEpisodes(
    v1HoldoutEpisodes,
    holdoutLabels,
  );
  const v1HoldoutRecall =
    holdoutLabels.length === 0
      ? 1
      : v1HoldoutMatch.matchedLabelIds.length / holdoutLabels.length;
  const frozen = candidates
    .filter((candidate) => candidate.syntheticCriticalRecall >= 0.95)
    .sort(
      (left, right) =>
        left.tuningUnmatchedEpisodes - right.tuningUnmatchedEpisodes ||
        left.medianLatencyMinutes - right.medianLatencyMinutes ||
        profileKey(left.profile).localeCompare(profileKey(right.profile)),
    )[0];
  const proposed = frozen ?? candidates[0]!;
  progress(`Evaluating frozen v2 profile ${profileKey(proposed.profile)}.`);
  const v2Runs = [...annualByChain].map(([chainId, buckets]) =>
    evaluateChain(chainId, buckets, "v2", proposed.profile, true),
  );
  const v2HoldoutEpisodes = outsideExclusions(
    v2Runs.flatMap(({ episodes }) =>
      filterRange(episodes, BENCHMARK_TUNING_TO, BENCHMARK_TO),
    ),
    labels.exclusions,
  );
  const v2HoldoutMatch = matchBenchmarkEpisodes(
    v2HoldoutEpisodes,
    holdoutLabels,
  );
  const v2HoldoutRecall =
    holdoutLabels.length === 0
      ? 1
      : v2HoldoutMatch.matchedLabelIds.length / holdoutLabels.length;
  if (frozen) frozen.holdoutRecall = v2HoldoutRecall;
  const selected =
    frozen && v2HoldoutRecall >= v1HoldoutRecall ? frozen : undefined;
  const promoted = Boolean(selected);
  const selectedRuns = promoted ? v2Runs : v1Runs;
  const selectedProfile = selected?.profile ?? null;
  const models = [
    modelResult("bayesian-nig-v1", v1Runs, labels, !promoted),
    modelResult("seasonal-mad", madRuns, labels, false),
    modelResult(
      "bayesian-nig-conformal-v2",
      v2Runs,
      labels,
      promoted,
      proposed.syntheticCriticalRecall,
    ),
  ];
  const selectedModel = promoted
    ? "bayesian-nig-conformal-v2"
    : "bayesian-nig-v1";
  const hourly = Object.fromEntries(
    selectedRuns.map((run) => [run.chainId, hourlyScores(run)]),
  );
  const canonicalLabels = labels.labels.filter(
    ({ observability }) => observability === "canonical",
  );
  const artifactWithoutChecksum = {
    version: "anomaly-benchmark-v2",
    generatedAt: "2026-07-26T00:00:00.000Z",
    window: {
      from: "2025-07-26T00:00:00.000Z",
      to: "2026-07-26T00:00:00.000Z",
      warmupBucketsPerChain: 8_640,
      scoredBucketsPerChain: BENCHMARK_SCORED_BUCKETS_PER_CHAIN,
    },
    methodology: {
      evaluation: "prequential-streaming-without-point-adjustment",
      labelPolicy:
        "Official canonical mainnet sequencing/block-production incidents only.",
      unmatchedPolicy:
        "Unmatched episodes are reported separately; incomplete status histories prevent calling each a confirmed false positive.",
      selection:
        "Freeze the synthetic-passing candidate with the fewest unmatched tuning episodes and lowest tuning latency; promote only if its holdout event recall does not regress versus v1.",
      tuning: {
        from: "2025-08-25T00:00:00.000Z",
        to: "2026-03-26T00:00:00.000Z",
        candidates: 32,
      },
      holdout: {
        from: "2026-03-26T00:00:00.000Z",
        to: "2026-07-26T00:00:00.000Z",
      },
    },
    selectedModel,
    promoted,
    selectedParameters: selectedProfile,
    proposedV2Parameters: proposed.profile,
    inputChecksums: {
      labelManifest: await checksumInput(BENCHMARK_LABELS),
      substreamsPackage: await checksumInput(
        process.env.ANOMALY_SUBSTREAMS_PACKAGE ??
          "substreams/anomaly-metrics/anomaly-metrics-v1.0.0.spkg",
      ),
    },
    coverage: chains.map((chain) => ({
      chainId: chain.id,
      chainName: chain.name,
      evmChainId: chain.chainId,
      buckets: annualByChain.get(chain.id)!.length,
      scoredBuckets: BENCHMARK_SCORED_BUCKETS_PER_CHAIN,
      checksum: checksumBuckets(annualByChain.get(chain.id)!),
    })),
    models,
    perChain: perChainResults(selectedRuns, labels),
    precisionRecall: [
      precisionRecallSeries("bayesian-nig-v1", v1Runs, labels),
      precisionRecallSeries("seasonal-mad", madRuns, labels),
      precisionRecallSeries(
        "bayesian-nig-conformal-v2",
        v2Runs,
        labels,
      ),
    ],
    calibration: models.flatMap((model) =>
      model.empiricalCoverage99 === undefined
        ? []
        : [{
            model: model.id,
            nominal99: 0.99,
            empirical99: model.empiricalCoverage99,
            nominal999: 0.999,
            empirical999: model.empiricalCoverage999,
          }],
    ),
    hourlyMaximumScores: hourly,
    labels: {
      version: labels.version,
      canonical: canonicalLabels,
      observerSimulations: labels.labels.filter(
        ({ observability }) => observability === "observer-simulation",
      ),
      exclusions: labels.exclusions,
    },
    eventDetails: eventDetails(selectedRuns, labels.labels),
    candidateAudit: candidates.map((candidate) => ({
      parameters: candidate.profile,
      syntheticCriticalRecall: candidate.syntheticCriticalRecall,
      tuningUnmatchedEpisodes: candidate.tuningUnmatchedEpisodes,
      holdoutRecall: candidate.holdoutRecall,
      medianLatencyMinutes: Number.isFinite(candidate.medianLatencyMinutes)
        ? candidate.medianLatencyMinutes
        : null,
      selected: selected === candidate,
      frozenBeforeHoldout: frozen === candidate,
      holdoutPromotionPassed:
        frozen === candidate &&
        candidate.holdoutRecall !== null &&
        candidate.holdoutRecall >= v1HoldoutRecall,
    })),
    research: ANOMALY_RESEARCH_INDEX,
    modelResearch: ANOMALY_MODEL_INDEX,
    safety: {
      mutatesIncidents: false,
      mutatesClaims: false,
      mutatesDecisions: false,
      mutatesSettlements: false,
      mutatesPayouts: false,
    },
  };
  const artifact = {
    ...artifactWithoutChecksum,
    artifactChecksum: `sha256:${createHash("sha256")
      .update(canonicalJson(artifactWithoutChecksum))
      .digest("hex")}`,
  };
  await writeAtomic(artifactFile, artifact, false);
  return artifact;
}

export async function readAnnualBenchmark(
  file = process.env.ANOMALY_BENCHMARK_ARTIFACT ?? BENCHMARK_ARTIFACT,
): Promise<Record<string, unknown> | undefined> {
  try {
    const artifact = JSON.parse(
      await readFile(file, "utf8"),
    ) as Record<string, unknown>;
    const { artifactChecksum, ...payload } = artifact;
    if (
      typeof artifactChecksum !== "string" ||
      hash(payload) !== artifactChecksum
    ) {
      throw new BitebackError(
        "ANOMALY_BENCHMARK_CHECKSUM_INVALID",
        "Annual benchmark artifact checksum is invalid.",
        503,
      );
    }
    return artifact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
