import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AnomalyMonitor,
  aggregateBlockMetrics,
  anomalyWebhookSignature,
  applyAnomalyBuckets,
  parseAnomalyChains,
  scoreAnomalyBucket,
  smokeTestAnomalySubstreams,
  type BlockMetricAggregate,
} from "../src/anomalies.js";
import {
  Store,
  hash,
  type AnomalyMetricBucket,
  type Database,
  type Incident,
} from "../src/domain.js";

const source = {
  provider: "evm-rpc" as const,
  endpoint: "https://rpc.test",
  queriedAt: "2026-07-25T00:00:00.000Z",
};

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

function bucket(
  chainId: string,
  start: number,
  tps: number,
  failedTransactionRate = 0.01,
): AnomalyMetricBucket {
  return {
    id: hash(`${chainId}|${start}`),
    chainId,
    start,
    end: start + 300,
    firstBlock: start,
    lastBlock: start + 1,
    source,
    metrics: {
      blocksPerMinute: 1,
      tps,
      averageTransactionFeeWei: 100_000_000_000_000,
      averageEffectiveGasPriceWei: 2_000_000_000,
      gasUtilization: 0.5,
      failedTransactionRate,
      averageBlockIntervalSeconds: 12,
      averageUniqueSendersPerBlock: 80,
    },
    learning: "accepted",
  };
}

function stableHistory(chainId: string, end: number): AnomalyMetricBucket[] {
  return Array.from({ length: 288 }, (_, index) =>
    bucket(
      chainId,
      end - (288 - index) * 300,
      10 + Math.sin(index / 4) * 0.5,
      0.01 + (index % 3) * 0.001,
    ),
  );
}

test("block aggregates produce exact metrics and explicit empty buckets", () => {
  const blocks: BlockMetricAggregate[] = [
    {
      blockNumber: 1,
      blockHash: "0x1",
      timestamp: 10,
      transactionCount: 2,
      failedTransactionCount: 1,
      uniqueSenderCount: 2,
      gasUsed: "100",
      gasLimit: "200",
      totalFeesWei: "1000",
      feeTransactionCount: 2,
      feeGasUsed: "100",
    },
    {
      blockNumber: 2,
      blockHash: "0x2",
      timestamp: 20,
      transactionCount: 3,
      failedTransactionCount: 0,
      uniqueSenderCount: 3,
      gasUsed: "200",
      gasLimit: "400",
      totalFeesWei: "2000",
      feeTransactionCount: 3,
      feeGasUsed: "200",
    },
    {
      blockNumber: 3,
      blockHash: "0x3",
      timestamp: 610,
      transactionCount: 1,
      failedTransactionCount: 0,
      uniqueSenderCount: 1,
      gasUsed: "50",
      gasLimit: "100",
      totalFeesWei: "500",
      feeTransactionCount: 1,
      feeGasUsed: "50",
    },
  ];
  const result = aggregateBlockMetrics("chain-a", blocks, source);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.metrics.tps, 5 / 300);
  assert.equal(result[0]?.metrics.gasUtilization, 0.5);
  assert.equal(result[0]?.metrics.failedTransactionRate, 0.2);
  assert.equal(result[0]?.metrics.averageBlockIntervalSeconds, 10);
  assert.deepEqual(result[1]?.metrics, { blocksPerMinute: 0, tps: 0 });
  assert.equal(result[2]?.start, 600);
});

test("fee metrics stay unavailable when the source has no effective gas price", () => {
  const [result] = aggregateBlockMetrics(
    "legacy-chain",
    [
      {
        blockNumber: 1,
        blockHash: "0x1",
        timestamp: 10,
        transactionCount: 1,
        failedTransactionCount: 0,
        uniqueSenderCount: 1,
        gasUsed: "100",
        gasLimit: "200",
      },
    ],
    source,
  );
  assert.equal(result?.metrics.averageTransactionFeeWei, undefined);
  assert.equal(result?.metrics.averageEffectiveGasPriceWei, undefined);
  assert.equal(result?.metrics.gasUtilization, 0.5);
});

test("RPC ingestion honors finality, receipt fallback, restart cursors, and outages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "biteback-anomaly-rpc-test-"));
  const store = new Store(join(directory, "database.json"));
  await store.load();
  await store.update((database) => {
    database.anomalyMonitorCursors.push({
      chainId: "chain-a",
      lastFinalizedBlock: 97,
      status: "idle",
      ready: false,
      acceptedBuckets: 0,
    });
  });
  const previousEnabled = process.env.ANOMALY_ENABLED;
  const previousChains = process.env.ANOMALY_CHAINS_JSON;
  const previousFetch = globalThis.fetch;
  const bucketStart = Math.floor(Date.now() / 300_000) * 300 - 300;
  let receiptFallbackCalls = 0;
  try {
    process.env.ANOMALY_ENABLED = "1";
    process.env.ANOMALY_CHAINS_JSON = JSON.stringify([
      {
        id: "chain-a",
        name: "Chain A",
        chainId: 1,
        rpcUrl: "https://rpc.test",
        confirmations: 2,
      },
    ]);
    globalThis.fetch = (async (_input, init) => {
      const calls = JSON.parse(String(init?.body)) as Array<{
        id: number;
        method: string;
      }>;
      return new Response(
        JSON.stringify(
          calls.map(({ id, method }) => {
            if (method === "eth_blockNumber") return { id, result: "0x64" };
            if (method === "eth_getBlockByNumber") {
              return {
                id,
                result: {
                  number: "0x62",
                  hash: "0x62",
                  timestamp: `0x${(bucketStart + 10).toString(16)}`,
                  gasUsed: "0x5208",
                  gasLimit: "0xa410",
                  transactions: [{ hash: "0xtx", from: "0xsender" }],
                },
              };
            }
            if (method === "eth_getBlockReceipts") {
              return { id, error: { message: "method unavailable" } };
            }
            receiptFallbackCalls += 1;
            return {
              id,
              result: {
                status: "0x1",
                gasUsed: "0x5208",
                effectiveGasPrice: "0x3b9aca00",
              },
            };
          }),
        ),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const monitor = new AnomalyMonitor(store);
    await monitor.run();
    assert.equal(
      store.read().anomalyMonitorCursors[0]?.lastFinalizedBlock,
      98,
    );
    assert.equal(store.read().anomalyMetricBuckets.length, 1);
    assert.equal(
      store.read().anomalyMetricBuckets[0]?.source.provider,
      "evm-rpc",
    );
    assert.equal(receiptFallbackCalls, 1);

    await monitor.run();
    assert.equal(store.read().anomalyMetricBuckets.length, 1);

    globalThis.fetch = (async () => {
      throw new Error("RPC offline");
    }) as typeof fetch;
    await monitor.run();
    assert.equal(store.read().anomalyMonitorCursors[0]?.status, "degraded");
    assert.equal(store.read().anomalyMetricBuckets.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnabled === undefined) delete process.env.ANOMALY_ENABLED;
    else process.env.ANOMALY_ENABLED = previousEnabled;
    if (previousChains === undefined) delete process.env.ANOMALY_CHAINS_JSON;
    else process.env.ANOMALY_CHAINS_JSON = previousChains;
  }
});

test("cross-chain heartbeat reports healthy, stalled, and down chains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "biteback-heartbeat-test-"));
  const store = new Store(join(directory, "database.json"));
  await store.load();
  const now = Math.floor(Date.now() / 1000);
  await store.update((database) => {
    database.anomalyMonitorCursors.push(
      {
        chainId: "chain-a",
        status: "ready",
        ready: true,
        acceptedBuckets: 288,
        heartbeatAt: new Date(now * 1000).toISOString(),
        lastObservedHead: 100,
        lastObservedBlockTimestamp: now - 10,
        rpcLatencyMs: 20,
        consecutiveHeartbeatFailures: 0,
      },
      {
        chainId: "chain-b",
        status: "ready",
        ready: true,
        acceptedBuckets: 288,
        heartbeatAt: new Date(now * 1000).toISOString(),
        lastObservedHead: 200,
        lastObservedBlockTimestamp: now - 400,
        rpcLatencyMs: 30,
        heartbeatQuorum: "agreed",
        secondaryObservedHead: 200,
        secondaryBlockTimestamp: now - 400,
        secondaryRpcLatencyMs: 35,
        consecutiveHeartbeatFailures: 0,
      },
    );
  });
  const previousEnabled = process.env.ANOMALY_ENABLED;
  const previousChains = process.env.ANOMALY_CHAINS_JSON;
  const previousStale = process.env.ANOMALY_HEARTBEAT_STALE_SECONDS;
  try {
    process.env.ANOMALY_ENABLED = "1";
    process.env.ANOMALY_HEARTBEAT_STALE_SECONDS = "300";
    process.env.ANOMALY_CHAINS_JSON = JSON.stringify([
      {
        id: "chain-a",
        name: "Chain A",
        chainId: 1,
        rpcUrl: "https://a.rpc.test",
        confirmations: 12,
      },
      {
        id: "chain-b",
        name: "Chain B",
        chainId: 2,
        rpcUrl: "https://b.rpc.test",
        secondaryRpcUrl: "https://b-secondary.rpc.test",
        confirmations: 12,
      },
    ]);
    const monitor = new AnomalyMonitor(store);
    assert.equal(monitor.heartbeat().status, "unhealthy");
    assert.equal(monitor.heartbeat().chains[0]?.status, "healthy");
    assert.equal(monitor.heartbeat().chains[1]?.status, "stalled");

    await store.update((database) => {
      const chain = database.anomalyMonitorCursors[1]!;
      chain.lastObservedBlockTimestamp = now - 5;
      chain.heartbeatQuorum = "disagreed";
    });
    assert.equal(monitor.heartbeat().chains[1]?.status, "degraded");

    await store.update((database) => {
      const chain = database.anomalyMonitorCursors[1]!;
      chain.consecutiveHeartbeatFailures = 2;
    });
    assert.equal(monitor.heartbeat().chains[1]?.status, "down");
  } finally {
    if (previousEnabled === undefined) delete process.env.ANOMALY_ENABLED;
    else process.env.ANOMALY_ENABLED = previousEnabled;
    if (previousChains === undefined) delete process.env.ANOMALY_CHAINS_JSON;
    else process.env.ANOMALY_CHAINS_JSON = previousChains;
    if (previousStale === undefined) {
      delete process.env.ANOMALY_HEARTBEAT_STALE_SECONDS;
    } else {
      process.env.ANOMALY_HEARTBEAT_STALE_SECONDS = previousStale;
    }
  }
});

test("disagreeing RPC heads degrade liveness without creating stall buckets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "biteback-quorum-test-"));
  const store = new Store(join(directory, "database.json"));
  await store.load();
  const now = Math.floor(Date.now() / 300_000) * 300;
  await store.update((database) => {
    database.anomalyMetricBuckets.push(bucket("chain-a", now - 600, 10));
    database.anomalyMonitorCursors.push({
      chainId: "chain-a",
      lastFinalizedBlock: 100,
      status: "ready",
      ready: true,
      acceptedBuckets: 288,
    });
  });
  const previousEnabled = process.env.ANOMALY_ENABLED;
  const previousChains = process.env.ANOMALY_CHAINS_JSON;
  const previousFetch = globalThis.fetch;
  try {
    process.env.ANOMALY_ENABLED = "1";
    process.env.ANOMALY_CHAINS_JSON = JSON.stringify([
      {
        id: "chain-a",
        name: "Chain A",
        chainId: 1,
        rpcUrl: "https://primary.rpc.test",
        secondaryRpcUrl: "https://secondary.rpc.test",
        confirmations: 0,
      },
    ]);
    globalThis.fetch = (async (input, init) => {
      const primary = String(input).includes("primary");
      const calls = JSON.parse(String(init?.body)) as Array<{
        id: number;
        method: string;
      }>;
      return new Response(
        JSON.stringify(
          calls.map(({ id, method }) =>
            method === "eth_blockNumber"
              ? { id, result: primary ? "0x64" : "0x50" }
              : {
                  id,
                  result: {
                    number: primary ? "0x64" : "0x50",
                    hash: primary ? "0x64" : "0x50",
                    timestamp: `0x${(now - 600).toString(16)}`,
                    gasUsed: "0x0",
                    gasLimit: "0x1",
                    transactions: [],
                  },
                },
          ),
        ),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const monitor = new AnomalyMonitor(store);
    await monitor.run();
    assert.equal(store.read().anomalyMetricBuckets.length, 1);
    assert.equal(store.read().anomalyMonitorCursors[0]?.status, "degraded");
    assert.equal(monitor.heartbeat().chains[0]?.status, "degraded");
    assert.equal(monitor.heartbeat().chains[0]?.quorum, "disagreed");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnabled === undefined) delete process.env.ANOMALY_ENABLED;
    else process.env.ANOMALY_ENABLED = previousEnabled;
    if (previousChains === undefined) delete process.env.ANOMALY_CHAINS_JSON;
    else process.env.ANOMALY_CHAINS_JSON = previousChains;
  }
});

test("Bayesian scoring isolates chains and detects spikes and ratio surges", () => {
  const now = Math.floor(Date.now() / 300_000) * 300;
  const history = stableHistory("chain-a", now);
  const otherChain = stableHistory("chain-b", now).map((entry) => ({
    ...entry,
    metrics: { ...entry.metrics, tps: 10_000 },
  }));
  const signals = scoreAnomalyBucket(
    bucket("chain-a", now, 40, 0.9),
    [...history, ...otherChain],
  );
  assert.equal(signals.some(({ metric }) => metric === "tps"), true);
  assert.equal(
    signals.some(({ metric }) => metric === "failedTransactionRate"),
    true,
  );
  assert.equal(signals.every(({ severity }) => severity === "critical"), true);
});

test("a lower failure rate is not treated as a wallet-risk anomaly", () => {
  const now = Math.floor(Date.now() / 300_000) * 300;
  const signals = scoreAnomalyBucket(
    bucket("chain-a", now, 10, 0),
    stableHistory("chain-a", now),
  );
  assert.equal(
    signals.some(({ metric }) => metric === "failedTransactionRate"),
    false,
  );
});

test("warnings require two buckets, critical anomalies alert immediately", () => {
  const now = Math.floor(Date.now() / 300_000) * 300;
  const database = emptyDatabase();
  const history = stableHistory("chain-a", now);
  applyAnomalyBuckets(database, history);

  let warningValue: number | undefined;
  for (let candidate = 10.5; candidate < 20; candidate += 0.01) {
    const signal = scoreAnomalyBucket(
      bucket("chain-a", now, candidate),
      database.anomalyMetricBuckets,
    ).find(({ metric }) => metric === "tps");
    if (signal?.severity === "warning") {
      warningValue = candidate;
      break;
    }
  }
  assert.notEqual(warningValue, undefined);
  applyAnomalyBuckets(database, [bucket("chain-a", now, warningValue!)]);
  assert.equal(database.anomalyAlerts.length, 0);
  assert.equal(database.anomalyMetricBuckets.at(-1)?.learning, "quarantined");

  applyAnomalyBuckets(database, [
    bucket("chain-a", now + 300, warningValue!),
  ]);
  assert.equal(database.anomalyAlerts.length, 1);
  assert.equal(database.anomalyAlerts[0]?.severity, "warning");
  assert.equal(database.anomalyAlerts[0]?.bucketIds.length, 2);

  applyAnomalyBuckets(database, [bucket("chain-b", now, 10)]);
  applyAnomalyBuckets(database, stableHistory("chain-b", now + 300));
  applyAnomalyBuckets(database, [bucket("chain-b", now + 300, 100)]);
  assert.equal(
    database.anomalyAlerts.some(
      ({ chainId, severity }) =>
        chainId === "chain-b" && severity === "critical",
    ),
    true,
  );
});

test("wallet watches receive deduplicated warnings without opening disputes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "biteback-anomaly-watch-test-"));
  const store = new Store(join(directory, "database.json"));
  await store.load();
  const now = Math.floor(Date.now() / 300_000) * 300;
  const database = emptyDatabase();
  applyAnomalyBuckets(database, stableHistory("chain-a", now));
  applyAnomalyBuckets(database, [bucket("chain-a", now, 100)]);
  await store.update((target) => Object.assign(target, database));

  const previousEnabled = process.env.ANOMALY_ENABLED;
  const previousChains = process.env.ANOMALY_CHAINS_JSON;
  try {
    process.env.ANOMALY_ENABLED = "1";
    process.env.ANOMALY_CHAINS_JSON = JSON.stringify([
      {
        id: "chain-a",
        name: "Chain A",
        chainId: 1,
        rpcUrl: "https://rpc.test",
        confirmations: 12,
      },
    ]);
    const monitor = new AnomalyMonitor(store);
    const wallet = "0x0000000000000000000000000000000000000001";
    await monitor.watchWallet(wallet, "chain-a");
    await monitor.watchWallet(wallet, "chain-a");
    assert.equal(monitor.walletNotifications(wallet).length, 1);
    assert.equal(
      monitor.disputeReadiness(store.read().anomalyAlerts[0]!.id, wallet)
        .anomalyCanOpenDispute,
      false,
    );
    assert.equal(store.read().incidents.length, 0);

    await monitor.resolve(
      store.read().anomalyAlerts[0]!.id,
      "confirmed",
      "Validated chain incident",
    );
    assert.equal(monitor.walletNotifications(wallet).length, 2);
    assert.equal(store.read().incidents.length, 0);
  } finally {
    if (previousEnabled === undefined) delete process.env.ANOMALY_ENABLED;
    else process.env.ANOMALY_ENABLED = previousEnabled;
    if (previousChains === undefined) delete process.env.ANOMALY_CHAINS_JSON;
    else process.env.ANOMALY_CHAINS_JSON = previousChains;
  }
});

test("resolving expected behavior admits quarantined buckets without touching incidents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "biteback-anomaly-test-"));
  const store = new Store(join(directory, "database.json"));
  await store.load();
  const now = Math.floor(Date.now() / 300_000) * 300;
  const database = emptyDatabase();
  database.incidents.push({ id: "legacy-incident" } as Incident);
  applyAnomalyBuckets(database, stableHistory("chain-a", now));
  applyAnomalyBuckets(database, [bucket("chain-a", now, 100)]);
  await store.update((target) => Object.assign(target, database));

  const previousEnabled = process.env.ANOMALY_ENABLED;
  const previousChains = process.env.ANOMALY_CHAINS_JSON;
  try {
    process.env.ANOMALY_ENABLED = "1";
    process.env.ANOMALY_CHAINS_JSON = JSON.stringify([
      {
        id: "chain-a",
        name: "Chain A",
        chainId: 1,
        rpcUrl: "https://rpc.test",
        confirmations: 12,
      },
    ]);
    const monitor = new AnomalyMonitor(store);
    const alert = store.read().anomalyAlerts[0]!;
    await monitor.resolve(alert.id, "expected", "Scheduled network upgrade");
    const result = store.read();
    assert.equal(result.incidents[0]?.id, "legacy-incident");
    assert.equal(result.anomalyAlerts[0]?.status, "resolved");
    assert.equal(
      result.anomalyMetricBuckets.find(({ id }) => id === alert.bucketIds[0])
        ?.learning,
      "accepted",
    );
  } finally {
    if (previousEnabled === undefined) delete process.env.ANOMALY_ENABLED;
    else process.env.ANOMALY_ENABLED = previousEnabled;
    if (previousChains === undefined) delete process.env.ANOMALY_CHAINS_JSON;
    else process.env.ANOMALY_CHAINS_JSON = previousChains;
  }
});

test("webhook signatures bind timestamp and exact body", () => {
  const expected = `sha256=${createHmac("sha256", "secret")
    .update('123.{"event":"anomaly.opened"}')
    .digest("hex")}`;
  assert.equal(
    anomalyWebhookSignature(
      "secret",
      "123",
      '{"event":"anomaly.opened"}',
    ),
    expected,
  );
});

test(
  "configured Substreams emits compact live block metrics",
  { skip: process.env.ANOMALY_LIVE_TEST !== "1" },
  async () => {
    const chain = parseAnomalyChains().find(({ substreamsEndpoint }) =>
      Boolean(substreamsEndpoint),
    );
    assert.ok(chain);
    const metric = await smokeTestAnomalySubstreams(chain);
    assert.equal(metric.blockNumber > 0, true);
    assert.equal(metric.timestamp > 0, true);
  },
);
