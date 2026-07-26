import {
  applyAnomalyBuckets,
  collectHistoricalAnomalyBuckets,
  type AnomalyChainConfig,
} from "../src/anomalies.js";
import {
  hash,
  type AnomalyMetricBucket,
  type Database,
} from "../src/domain.js";

interface ValidationCase {
  id: string;
  chain: AnomalyChainConfig;
  eventBlock: number;
  startedAt: string;
  endedAt: string;
  labelSource: string;
}

const cases: ValidationCase[] = [
  {
    id: "base-2026-06-25-block-production-halt",
    chain: {
      id: "base",
      name: "Base",
      chainId: 8453,
      rpcUrl: "https://mainnet.base.org",
      substreamsEndpoint: "https://base.substreams.pinax.network",
      confirmations: 20,
    },
    eventBlock: 47_806_543,
    startedAt: "2026-06-25T15:47:13Z",
    endedAt: "2026-06-25T17:43:13Z",
    labelSource: "https://blog.base.dev/postmortem-june-25th-block-production-outage",
  },
  {
    id: "optimism-2026-07-07-unsafe-head-stall",
    chain: {
      id: "optimism",
      name: "Optimism",
      chainId: 10,
      rpcUrl: "https://mainnet.optimism.io",
      substreamsEndpoint: "https://optimism.substreams.pinax.network",
      confirmations: 20,
    },
    eventBlock: 153_924_302,
    startedAt: "2026-07-07T18:03:00Z",
    endedAt: "2026-07-07T18:23:00Z",
    labelSource:
      "https://status.optimism.io/cmrazrvph0am30rns9tzwb2oa",
  },
];

function emptyDatabase(): Database {
  return {
    rules: [],
    pendingRules: [],
    incidents: [],
    paymentsSeen: [],
    settledPaymentIds: [],
    usedNonces: [],
    auditEvents: [],
    anomalyMetricBuckets: [],
    anomalyAlerts: [],
    anomalyMonitorCursors: [],
    anomalyWebhookDeliveries: [],
    anomalyWalletWatches: [],
    anomalyWalletNotifications: [],
  };
}

function observedStallBuckets(
  validation: ValidationCase,
  source: AnomalyMetricBucket["source"],
): AnomalyMetricBucket[] {
  const startedAt = Date.parse(validation.startedAt) / 1000;
  const endedAt = Date.parse(validation.endedAt) / 1000;
  const firstCompleteBucket = Math.ceil(startedAt / 300) * 300;
  const lastCompleteBucket = Math.floor(endedAt / 300) * 300;
  const buckets: AnomalyMetricBucket[] = [];
  for (
    let start = firstCompleteBucket;
    start < lastCompleteBucket;
    start += 300
  ) {
    buckets.push({
      id: hash(`${validation.chain.id}|${start}`),
      chainId: validation.chain.id,
      start,
      end: start + 300,
      firstBlock: validation.eventBlock - 1,
      lastBlock: validation.eventBlock - 1,
      source,
      metrics: { blocksPerMinute: 0, tps: 0 },
      learning: "accepted",
    });
  }
  return buckets;
}

for (const validation of cases) {
  const startedAt = Date.parse(validation.startedAt) / 1000;
  const endedAt = Date.parse(validation.endedAt) / 1000;
  const startBlock = validation.eventBlock - 45_000;
  const stopBlock = validation.eventBlock + 5_400;
  const buckets = await collectHistoricalAnomalyBuckets(
    validation.chain,
    startBlock,
    stopBlock,
  );
  const eventBucketStart = Math.floor(startedAt / 300) * 300;
  const history = buckets.filter(({ end }) => end <= eventBucketStart);
  const actual = emptyDatabase();
  applyAnomalyBuckets(actual, buckets, endedAt + 10_800);
  const actualAlerts = actual.anomalyAlerts.filter(
    (alert) =>
      alert.startedAt <= endedAt + 3_600 &&
      alert.endedAt >= startedAt - 3_600,
  );

  const observed = emptyDatabase();
  applyAnomalyBuckets(
    observed,
    [
      ...history,
      ...observedStallBuckets(
        validation,
        buckets[0]?.source ?? {
          provider: "the-graph-substreams",
          endpoint: new URL(validation.chain.substreamsEndpoint!).origin,
          queriedAt: new Date().toISOString(),
        },
      ),
    ],
    endedAt,
  );
  const stallAlert = observed.anomalyAlerts.find((alert) =>
    alert.signals.some(
      ({ metric, direction }) =>
        metric === "blocksPerMinute" && direction === "low",
    ),
  );
  const firstCanonical = buckets[0];
  const lastCanonical = buckets.at(-1);
  console.log(
    JSON.stringify({
      case: validation.id,
      chain: validation.chain.name,
      label: {
        startedAt: validation.startedAt,
        endedAt: validation.endedAt,
        source: validation.labelSource,
      },
      canonicalReplay: {
        buckets: buckets.length,
        from: firstCanonical
          ? new Date(firstCanonical.start * 1000).toISOString()
          : null,
        to: lastCanonical
          ? new Date(lastCanonical.end * 1000).toISOString()
          : null,
        nearbyAlerts: actualAlerts.map((alert) => ({
          severity: alert.severity,
          startedAt: new Date(alert.startedAt * 1000).toISOString(),
          metrics: alert.signals.map(({ metric, direction }) => ({
            metric,
            direction,
          })),
        })),
      },
      liveWallClockReplay: {
        baselineBuckets: history.length,
        observedEmptyBuckets: observedStallBuckets(
          validation,
          buckets[0]!.source,
        ).length,
        detected: Boolean(stallAlert),
        severity: stallAlert?.severity ?? null,
        detectedAt: stallAlert
          ? new Date(stallAlert.startedAt * 1000).toISOString()
          : null,
        metrics:
          stallAlert?.signals.map(({ metric, direction }) => ({
            metric,
            direction,
          })) ?? [],
      },
    }),
  );
}
