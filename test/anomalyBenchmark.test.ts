import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANOMALY_RESEARCH_INDEX,
  BENCHMARK_BUCKETS_PER_CHAIN,
  BENCHMARK_FROM,
  BENCHMARK_SCORED_BUCKETS_PER_CHAIN,
  BENCHMARK_TO,
  benchmarkCandidateProfiles,
  loadBenchmarkLabels,
  matchBenchmarkEpisodes,
  readAnnualBenchmark,
  runSyntheticBenchmarkFixture,
  type BenchmarkEpisode,
} from "../src/anomalyBenchmark.js";
import { hash } from "../src/domain.js";

test("annual benchmark boundaries contain the exact bucket counts", () => {
  assert.equal((BENCHMARK_TO - BENCHMARK_FROM) / 300, BENCHMARK_BUCKETS_PER_CHAIN);
  assert.equal(BENCHMARK_BUCKETS_PER_CHAIN - 30 * 288, BENCHMARK_SCORED_BUCKETS_PER_CHAIN);
});

test("research index makes the benchmark scoring rules explicit", () => {
  assert.equal(ANOMALY_RESEARCH_INDEX.length, 3);
  assert.equal(
    new Set(ANOMALY_RESEARCH_INDEX.map(({ id }) => id)).size,
    ANOMALY_RESEARCH_INDEX.length,
  );
  assert.ok(ANOMALY_RESEARCH_INDEX.every(({ url }) => url.startsWith("https://")));
  assert.match(
    ANOMALY_RESEARCH_INDEX.map(({ modelApplication }) => modelApplication).join(" "),
    /before learning.*Never expand.*precision-recall/s,
  );
});

test("official label manifest separates canonical, simulated, and excluded events", async () => {
  const manifest = await loadBenchmarkLabels();
  assert.ok(
    manifest.labels.some(({ observability }) => observability === "canonical"),
  );
  assert.ok(
    manifest.labels.some(
      ({ observability }) => observability === "observer-simulation",
    ),
  );
  assert.ok(
    manifest.exclusions.every(({ exclusionReason }) => Boolean(exclusionReason)),
  );
});

test("event matching never applies point adjustment to a long overlapping episode", () => {
  const label = {
    id: "event",
    chainId: "base",
    name: "Event",
    startedAt: "2026-01-01T12:00:00.000Z",
    endedAt: "2026-01-01T12:30:00.000Z",
    observability: "canonical" as const,
    source: "https://status.base.org/history",
  };
  const longEpisode: BenchmarkEpisode = {
    id: "long",
    chainId: "base",
    startedAt: Date.parse("2026-01-01T10:00:00.000Z") / 1_000,
    endedAt: Date.parse("2026-01-01T12:15:00.000Z") / 1_000,
    severity: "critical",
    score: 8,
    metrics: ["tps"],
  };
  const onTimeEpisode: BenchmarkEpisode = {
    ...longEpisode,
    id: "on-time",
    startedAt: Date.parse("2026-01-01T12:05:00.000Z") / 1_000,
    endedAt: Date.parse("2026-01-01T12:10:00.000Z") / 1_000,
  };
  assert.equal(
    matchBenchmarkEpisodes([longEpisode], [label]).matchedLabelIds.length,
    0,
  );
  const matched = matchBenchmarkEpisodes([longEpisode, onTimeEpisode], [label]);
  assert.deepEqual(matched.matchedLabelIds, ["event"]);
  assert.deepEqual(matched.latenciesMinutes, [5]);
});

test("all 32 candidates are frozen and the precision profile passes stress fixtures", () => {
  assert.equal(benchmarkCandidateProfiles().length, 32);
  const result = runSyntheticBenchmarkFixture({
    slotMinimum: 14,
    calibrationDays: 30,
    warningFdr: 0.005,
    criticalFdr: 0.0005,
    warningPersistence: 2,
  });
  assert.ok(result.criticalRecall >= 0.95);
  assert.equal(result.providerOutageAlerts, 0);
});

test("bundled benchmark reads require a valid canonical checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "biteback-artifact-test-"));
  const file = join(directory, "benchmark.json");
  const payload = { version: "fixture", promoted: false };
  await writeFile(
    file,
    JSON.stringify({ ...payload, artifactChecksum: hash(payload) }),
  );
  assert.equal((await readAnnualBenchmark(file))?.version, "fixture");
  await writeFile(
    file,
    JSON.stringify({ ...payload, promoted: true, artifactChecksum: hash(payload) }),
  );
  await assert.rejects(
    readAnnualBenchmark(file),
    /artifact checksum is invalid/,
  );
});
