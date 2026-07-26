import assert from "node:assert/strict";
import test from "node:test";
import {
  BayesianConformalScorer,
  benjaminiYekutieli,
  conformalTailProbability,
  inverseAnomalyMetric,
  normalInverseGammaPosterior,
  studentTCdf,
  studentTQuantile,
  transformAnomalyMetric,
} from "../src/anomalyModel.js";
import { hash, type AnomalyMetricBucket } from "../src/domain.js";

function bucket(
  chainId: string,
  start: number,
  tps: number,
): AnomalyMetricBucket {
  return {
    id: hash(`${chainId}|${start}`),
    chainId,
    start,
    end: start + 300,
    firstBlock: start,
    lastBlock: start,
    source: {
      provider: "the-graph-substreams",
      endpoint: "fixture",
      queriedAt: "2026-07-26T00:00:00.000Z",
    },
    metrics: {
      blocksPerMinute: 30,
      tps,
      averageTransactionFeeWei: 2e12,
      averageEffectiveGasPriceWei: 2e8,
      gasUtilization: 0.5,
      failedTransactionRate: 0.01,
      averageBlockIntervalSeconds: 2,
      averageUniqueSendersPerBlock: 20,
    },
    learning: "accepted",
  };
}

test("metric transforms round-trip positive and ratio values", () => {
  for (const value of [0, 1, 10, 1e12]) {
    const transformed = transformAnomalyMetric("tps", value);
    assert.ok(
      Math.abs(inverseAnomalyMetric("tps", transformed) - value) <
        Math.max(1e-9, value * 1e-12),
    );
  }
  for (const value of [1e-6, 0.01, 0.5, 0.99, 1 - 1e-6]) {
    const transformed = transformAnomalyMetric("gasUtilization", value);
    assert.ok(
      Math.abs(
        inverseAnomalyMetric("gasUtilization", transformed) - value,
      ) < 1e-12,
    );
  }
});

test("Normal-Inverse-Gamma posterior matches the exact fixture", () => {
  const posterior = normalInverseGammaPosterior(
    { count: 4, mean: 2, sumSquares: 5 },
    { mean: 1, scale: 2 },
  );
  assert.equal(posterior.kappa, 5);
  assert.equal(posterior.alpha, 5);
  assert.equal(posterior.beta, 10.9);
  assert.equal(posterior.mean, 1.8);
  assert.equal(posterior.degreesOfFreedom, 10);
  assert.ok(Math.abs(posterior.scale - Math.sqrt(2.616)) < 1e-12);
});

test("Student-t CDF and quantile are inverse and symmetric", () => {
  const quantile = studentTQuantile(0.995, 12);
  assert.ok(Math.abs(studentTCdf(quantile, 12) - 0.995) < 1e-10);
  assert.ok(Math.abs(studentTCdf(-quantile, 12) - 0.005) < 1e-10);
});

test("conformal tail ranks are monotone", () => {
  const calibration = [0.1, 0.2, 0.4, 0.8];
  assert.equal(conformalTailProbability(calibration, 0.2), 0.8);
  assert.equal(conformalTailProbability(calibration, 0.9), 0.2);
  assert.ok(
    conformalTailProbability(calibration, 0.7) >=
      conformalTailProbability(calibration, 0.9),
  );
});

test("Benjamini-Yekutieli correction is deterministic and monotone", () => {
  const adjusted = benjaminiYekutieli([0.001, 0.01, 0.2]);
  assert.ok(Math.abs(adjusted[0]! - 0.0055) < 1e-12);
  assert.ok(Math.abs(adjusted[1]! - 0.0275) < 1e-12);
  assert.ok(Math.abs(adjusted[2]! - 0.3666666666666667) < 1e-12);
  assert.ok(adjusted[0]! <= adjusted[1]! && adjusted[1]! <= adjusted[2]!);
});

test("prequential scoring is chain-isolated and does not learn previews", () => {
  const from = Date.parse("2026-01-01T00:00:00Z") / 1_000;
  const history = Array.from({ length: 300 }, (_, index) =>
    bucket("base", from + index * 300, 20 + Math.sin(index / 7)),
  );
  const at = from + history.length * 300;
  const first = new BayesianConformalScorer("base");
  const second = new BayesianConformalScorer("base");
  first.warm(history);
  second.warm(history);
  first.preview(bucket("base", at + 300, 500));
  assert.deepEqual(
    first.preview(bucket("base", at, 20.2)),
    second.preview(bucket("base", at, 20.2)),
  );
  const isolated = new BayesianConformalScorer("optimism");
  isolated.warm(history);
  assert.equal(
    isolated.preview(bucket("optimism", at, 500)).signals.length,
    0,
  );
});
