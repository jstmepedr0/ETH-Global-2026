import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createAuthInterceptor,
  createRegistry,
  createRequest,
  createSubstream,
  fetchSubstream,
  streamBlocks,
  unpackMapOutput,
} from "@substreams/core";
import { z } from "zod";
import {
  BayesianConformalScorer,
  precisionModelProfile,
  scoreAnomalyBucketV2,
  type AnomalyModelProfile,
} from "./anomalyModel.js";
import {
  BitebackError,
  hash,
  type AnomalyAlert,
  type AnomalyMetricBucket,
  type AnomalyMetricName,
  type AnomalyMetricValues,
  type AnomalySignal,
  type AnomalyWalletNotification,
  type AnomalyWalletWatch,
  type AnomalyWebhookDelivery,
  type Database,
  type Store,
} from "./domain.js";

const BUCKET_SECONDS = 300;
const HISTORY_SECONDS = 30 * 24 * 60 * 60;
const MIN_READY_BUCKETS = 24 * 60 / 5;
const MODEL_SELECTION: {
  version: "bayesian-nig-v1" | "bayesian-nig-conformal-v2";
  profile: AnomalyModelProfile;
} = await readFile(
    "benchmark/anomaly-annual-v2.json",
    "utf8",
  )
    .then((content) => {
      const artifact = JSON.parse(content) as {
        promoted?: boolean;
        selectedModel?: string;
        selectedParameters?: AnomalyModelProfile;
        artifactChecksum?: string;
        [key: string]: unknown;
      };
      const { artifactChecksum, ...payload } = artifact;
      const checksumValid =
        typeof artifactChecksum === "string" &&
        hash(payload) === artifactChecksum;
      const profile = artifact.selectedParameters;
      const validProfile =
        profile &&
        [7, 14].includes(profile.slotMinimum) &&
        [14, 30].includes(profile.calibrationDays) &&
        [0.005, 0.01].includes(profile.warningFdr) &&
        [0.0005, 0.001].includes(profile.criticalFdr) &&
        [2, 3].includes(profile.warningPersistence);
      return artifact.promoted &&
          artifact.selectedModel === "bayesian-nig-conformal-v2" &&
          checksumValid &&
          validProfile
        ? {
            version: "bayesian-nig-conformal-v2" as const,
            profile,
          }
        : {
            version: "bayesian-nig-v1" as const,
            profile: precisionModelProfile,
          };
    })
    .catch(() => ({
      version: "bayesian-nig-v1" as const,
      profile: precisionModelProfile,
    }));
const MODEL_VERSION = MODEL_SELECTION.version;
const MODEL_PROFILE = MODEL_SELECTION.profile;
const RETRY_SECONDS = [60, 300, 1_800] as const;
const BACKFILL_BLOCKS_PER_RUN = 50_000;
const RPC_BLOCKS_PER_RUN = 500;

function heartbeatStaleSeconds(): number {
  const configured = Number(process.env.ANOMALY_HEARTBEAT_STALE_SECONDS ?? 300);
  return Number.isFinite(configured) && configured >= 60
    ? Math.floor(configured)
    : 300;
}

export interface AnomalyChainConfig {
  id: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  secondaryRpcUrl?: string;
  substreamsEndpoint?: string;
  confirmations: number;
}

export interface BlockMetricAggregate {
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  transactionCount: number;
  failedTransactionCount: number;
  uniqueSenderCount: number;
  gasUsed: string;
  gasLimit: string;
  totalFeesWei?: string;
  feeTransactionCount?: number;
  feeGasUsed?: string;
}

interface MetricPrediction {
  expected: number;
  lower99: number;
  upper99: number;
  lower999: number;
  upper999: number;
}

interface RpcTransaction {
  hash: string;
  from: string;
}

interface RpcBlock {
  number: string;
  hash: string;
  timestamp: string;
  gasUsed: string;
  gasLimit: string;
  transactions: RpcTransaction[];
}

interface RpcReceipt {
  status?: string;
  gasUsed: string;
  effectiveGasPrice?: string;
}

interface RpcEnvelope<T> {
  id: number;
  result?: T;
  error?: { message?: string };
}

interface SubstreamsBlockMetric {
  blockNumber?: string | number;
  blockHash?: string;
  timestamp?: string | number;
  transactionCount?: string | number;
  failedTransactionCount?: string | number;
  uniqueSenderCount?: string | number;
  gasUsed?: string;
  gasLimit?: string;
  totalFeesWei?: string;
  feeTransactionCount?: string | number;
  feeGasUsed?: string;
}

const chainSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),
  secondaryRpcUrl: z.string().url().optional(),
  substreamsEndpoint: z.string().url().optional(),
  confirmations: z.number().int().min(0).max(10_000).default(12),
});

const metricNames: AnomalyMetricName[] = [
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

export function anomalyWatchMessage(wallet: string, chainId: string): string {
  return [
    "BITEBACK_ANOMALY_WATCH_V1",
    `wallet=${wallet.toLowerCase()}`,
    `chain=${chainId}`,
  ].join("\n");
}

export function anomalyMonitoringEnabled(): boolean {
  return ["1", "true", "yes"].includes(
    (process.env.ANOMALY_ENABLED ?? "").toLowerCase(),
  );
}

export function parseAnomalyChains(value = process.env.ANOMALY_CHAINS_JSON): AnomalyChainConfig[] {
  if (!value) {
    throw new BitebackError(
      "ANOMALY_CONFIG_INVALID",
      "ANOMALY_CHAINS_JSON is required when anomaly monitoring is enabled.",
      503,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new BitebackError(
      "ANOMALY_CONFIG_INVALID",
      "ANOMALY_CHAINS_JSON must contain valid JSON.",
      503,
    );
  }
  const parsed = z.array(chainSchema).min(1).safeParse(input);
  if (!parsed.success) {
    throw new BitebackError(
      "ANOMALY_CONFIG_INVALID",
      z.prettifyError(parsed.error),
      503,
    );
  }
  if (new Set(parsed.data.map(({ id }) => id)).size !== parsed.data.length) {
    throw new BitebackError(
      "ANOMALY_CONFIG_INVALID",
      "Every anomaly chain id must be unique.",
      503,
    );
  }
  return parsed.data.map((chain) => ({
    id: chain.id,
    name: chain.name,
    chainId: chain.chainId,
    rpcUrl: chain.rpcUrl,
    confirmations: chain.confirmations,
    ...(chain.substreamsEndpoint
      ? { substreamsEndpoint: chain.substreamsEndpoint }
      : {}),
    ...(chain.secondaryRpcUrl
      ? { secondaryRpcUrl: chain.secondaryRpcUrl }
      : {}),
  }));
}

function publicEndpoint(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "local";
  }
}

function hexNumber(value: number): string {
  return `0x${value.toString(16)}`;
}

function parseHex(value: string | undefined): number {
  if (!value) return 0;
  return Number.parseInt(value, 16);
}

async function rpcBatch<T>(
  rpcUrl: string,
  calls: Array<{ method: string; params: unknown[] }>,
): Promise<Array<RpcEnvelope<T>>> {
  if (calls.length === 0) return [];
  const body = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: call.method,
    params: call.params,
  }));
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`RPC returned ${response.status}.`);
  }
  const payload = (await response.json()) as Array<RpcEnvelope<T>> | RpcEnvelope<T>;
  const envelopes = Array.isArray(payload) ? payload : [payload];
  return envelopes.sort((left, right) => left.id - right.id);
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const [response] = await rpcBatch<T>(rpcUrl, [{ method, params }]);
  if (!response?.result || response.error) {
    throw new Error(response?.error?.message ?? `${method} returned no result.`);
  }
  return response.result;
}

async function finalizedHead(chain: AnomalyChainConfig): Promise<number> {
  const head = parseHex(await rpcCall<string>(chain.rpcUrl, "eth_blockNumber"));
  return Math.max(0, head - chain.confirmations);
}

interface HeartbeatObservation {
  head: number;
  blockTimestamp: number;
  latencyMs: number;
}

async function heartbeatObservation(
  rpcUrl: string,
  confirmations: number,
): Promise<HeartbeatObservation> {
  const startedAt = performance.now();
  const latest = parseHex(await rpcCall<string>(rpcUrl, "eth_blockNumber"));
  const head = Math.max(0, latest - confirmations);
  const block = await rpcCall<RpcBlock>(
    rpcUrl,
    "eth_getBlockByNumber",
    [hexNumber(head), false],
  );
  return {
    head,
    blockTimestamp: parseHex(block.timestamp),
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

async function blockAtOrAfterTimestamp(
  chain: AnomalyChainConfig,
  head: number,
  timestamp: number,
): Promise<number> {
  let low = 0;
  let high = head;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const block = await rpcCall<RpcBlock>(
      chain.rpcUrl,
      "eth_getBlockByNumber",
      [hexNumber(middle), false],
    );
    if (parseHex(block.timestamp) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

export async function historicalAnomalyBlockRange(
  chain: AnomalyChainConfig,
  from: number,
  to: number,
): Promise<{ startBlock: number; stopBlock: number }> {
  if (to <= from) {
    throw new BitebackError(
      "ANOMALY_VALIDATION_INVALID",
      "Historical range must end after it starts.",
    );
  }
  const head = await finalizedHead(chain);
  const startBlock = await blockAtOrAfterTimestamp(chain, head, from);
  const stopBlock =
    (await blockAtOrAfterTimestamp(chain, head, to)) - 1;
  if (stopBlock < startBlock) {
    throw new BitebackError(
      "ANOMALY_VALIDATION_INVALID",
      "Historical range contains no finalized blocks.",
    );
  }
  return { startBlock, stopBlock };
}

async function* rpcBlockMetrics(
  chain: AnomalyChainConfig,
  startBlock: number,
  stopBlock: number,
): AsyncGenerator<BlockMetricAggregate> {
  for (let cursor = startBlock; cursor <= stopBlock; cursor += 20) {
    const numbers = Array.from(
      { length: Math.min(20, stopBlock - cursor + 1) },
      (_, index) => cursor + index,
    );
    const responses = await rpcBatch<RpcBlock>(
      chain.rpcUrl,
      numbers.map((number) => ({
        method: "eth_getBlockByNumber",
        params: [hexNumber(number), true],
      })),
    );
    const blocks = responses.map((response) => {
      if (!response.result || response.error) {
        throw new Error(response.error?.message ?? "RPC block response is incomplete.");
      }
      return response.result;
    });
    const receiptSets = await rpcBatch<RpcReceipt[]>(
      chain.rpcUrl,
      blocks.map((block) => ({
        method: "eth_getBlockReceipts",
        params: [block.number],
      })),
    );
    for (const [index, block] of blocks.entries()) {
      let receipts = receiptSets[index]?.result;
      if (!receipts || receiptSets[index]?.error) {
        const responses = await rpcBatch<RpcReceipt>(
          chain.rpcUrl,
          block.transactions.map(({ hash: transactionHash }) => ({
            method: "eth_getTransactionReceipt",
            params: [transactionHash],
          })),
        );
        receipts = responses.flatMap((response) =>
          response.result && !response.error ? [response.result] : [],
        );
      }
      if (receipts.length !== block.transactions.length) {
        throw new Error(`RPC receipts are incomplete for block ${parseHex(block.number)}.`);
      }
      let totalFees = 0n;
      let feeGasUsed = 0n;
      let feeTransactionCount = 0;
      let failed = 0;
      for (const receipt of receipts) {
        if (receipt.status === "0x0") failed += 1;
        if (receipt.effectiveGasPrice !== undefined) {
          const transactionGasUsed = BigInt(receipt.gasUsed || "0x0");
          totalFees += transactionGasUsed * BigInt(receipt.effectiveGasPrice);
          feeGasUsed += transactionGasUsed;
          feeTransactionCount += 1;
        }
      }
      yield {
        blockNumber: parseHex(block.number),
        blockHash: block.hash.toLowerCase(),
        timestamp: parseHex(block.timestamp),
        transactionCount: block.transactions.length,
        failedTransactionCount: failed,
        uniqueSenderCount: new Set(
          block.transactions.map(({ from }) => from.toLowerCase()),
        ).size,
        gasUsed: BigInt(block.gasUsed).toString(),
        gasLimit: BigInt(block.gasLimit).toString(),
        ...(feeTransactionCount > 0
          ? {
              totalFeesWei: totalFees.toString(),
              feeTransactionCount,
              feeGasUsed: feeGasUsed.toString(),
            }
          : {}),
      };
    }
  }
}

async function loadSubstreamsPackage(location: string) {
  if (/^https?:\/\//.test(location)) return fetchSubstream(location);
  return createSubstream(await readFile(location));
}

async function* substreamsBlockMetrics(
  chain: AnomalyChainConfig,
  startBlock: number,
  stopBlock: number,
): AsyncGenerator<BlockMetricAggregate> {
  const endpoint = chain.substreamsEndpoint;
  if (!endpoint) return;
  const packageLocation =
    process.env.ANOMALY_SUBSTREAMS_PACKAGE ??
    "substreams/anomaly-metrics/anomaly-metrics-v1.0.0.spkg";
  const substreamPackage = await loadSubstreamsPackage(packageLocation);
  const registry = createRegistry(substreamPackage);
  const token = process.env.PINAX_JWT;
  const transport = createConnectTransport({
    baseUrl: endpoint,
    httpVersion: "2",
    interceptors: token ? [createAuthInterceptor(token) as never] : [],
    useBinaryFormat: true,
    jsonOptions: { typeRegistry: registry as never },
  });
  const request = createRequest({
    substreamPackage,
    outputModule: "map_block_metrics",
    productionMode: true,
    finalBlocksOnly: true,
    startBlockNum: BigInt(startBlock),
    stopBlockNum: BigInt(stopBlock + 1),
  });
  for await (const response of streamBlocks(transport as never, request)) {
    const output = unpackMapOutput(response, registry);
    if (!output) continue;
    const metric = output.toJson({
      typeRegistry: registry,
    }) as unknown as SubstreamsBlockMetric;
    const blockNumber = Number(metric.blockNumber);
    const timestamp = Number(metric.timestamp);
    if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(timestamp)) continue;
    yield {
      blockNumber,
      blockHash: metric.blockHash ?? "",
      timestamp,
      transactionCount: Number(metric.transactionCount ?? 0),
      failedTransactionCount: Number(metric.failedTransactionCount ?? 0),
      uniqueSenderCount: Number(metric.uniqueSenderCount ?? 0),
      gasUsed: metric.gasUsed ?? "0",
      gasLimit: metric.gasLimit ?? "0",
      ...(Number(metric.feeTransactionCount) > 0
        ? {
            totalFeesWei: metric.totalFeesWei ?? "0",
            feeTransactionCount: Number(metric.feeTransactionCount),
            feeGasUsed: metric.feeGasUsed ?? "0",
          }
        : {}),
    };
  }
}

export async function smokeTestAnomalySubstreams(
  chain: AnomalyChainConfig,
): Promise<BlockMetricAggregate> {
  if (!chain.substreamsEndpoint) {
    throw new BitebackError(
      "ANOMALY_CONFIG_INVALID",
      "The smoke-test chain requires a Substreams endpoint.",
      503,
    );
  }
  const head = await finalizedHead(chain);
  for await (const block of substreamsBlockMetrics(chain, head, head)) {
    return block;
  }
  throw new Error("Substreams returned no block metrics.");
}

export async function collectHistoricalAnomalyBuckets(
  chain: AnomalyChainConfig,
  startBlock: number,
  stopBlock: number,
): Promise<AnomalyMetricBucket[]> {
  if (!chain.substreamsEndpoint || startBlock < 0 || stopBlock < startBlock) {
    throw new BitebackError(
      "ANOMALY_VALIDATION_INVALID",
      "Historical validation requires a Substreams endpoint and valid block range.",
    );
  }
  return collectBuckets(
    chain.id,
    substreamsBlockMetrics(chain, startBlock, stopBlock),
    {
      provider: "the-graph-substreams",
      endpoint: publicEndpoint(chain.substreamsEndpoint),
      queriedAt: new Date().toISOString(),
    },
  );
}

export async function collectHistoricalAnomalyChunk(
  chain: AnomalyChainConfig,
  startBlock: number,
  stopBlock: number,
): Promise<{
  buckets: AnomalyMetricBucket[];
  blockCount: number;
  firstBlock: number;
  lastBlock: number;
}> {
  if (!chain.substreamsEndpoint || startBlock < 0 || stopBlock < startBlock) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_INVALID",
      "Annual benchmark ingestion requires Substreams and a valid block range.",
    );
  }
  const blocks: BlockMetricAggregate[] = [];
  let expectedBlock = startBlock;
  const stream = substreamsBlockMetrics(chain, startBlock, stopBlock);
  while (true) {
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([
      stream.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BitebackError(
                "ANOMALY_BENCHMARK_SOURCE_TIMEOUT",
                `Substreams made no progress for 120 seconds on ${chain.id}.`,
                504,
              ),
            ),
          120_000,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (next.done) break;
    const block = next.value;
    if (block.blockNumber !== expectedBlock) {
      throw new BitebackError(
        "ANOMALY_BENCHMARK_SOURCE_GAP",
        `Substreams gap on ${chain.id}: expected block ${expectedBlock}, received ${block.blockNumber}.`,
        502,
      );
    }
    blocks.push(block);
    expectedBlock += 1;
  }
  if (expectedBlock !== stopBlock + 1) {
    throw new BitebackError(
      "ANOMALY_BENCHMARK_SOURCE_GAP",
      `Substreams ended at block ${expectedBlock - 1} on ${chain.id}; expected ${stopBlock}.`,
      502,
    );
  }
  const source = {
    provider: "the-graph-substreams" as const,
    endpoint: publicEndpoint(chain.substreamsEndpoint),
    queriedAt: new Date().toISOString(),
  };
  return {
    buckets: aggregateBlockMetrics(chain.id, blocks, source),
    blockCount: blocks.length,
    firstBlock: startBlock,
    lastBlock: stopBlock,
  };
}

function bucketFromBlocks(
  chainId: string,
  blocks: BlockMetricAggregate[],
  source: AnomalyMetricBucket["source"],
): AnomalyMetricBucket {
  const first = blocks[0]!;
  const last = blocks.at(-1)!;
  const start = Math.floor(first.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
  const transactionCount = blocks.reduce(
    (total, block) => total + block.transactionCount,
    0,
  );
  const failedTransactionCount = blocks.reduce(
    (total, block) => total + block.failedTransactionCount,
    0,
  );
  const gasUsed = blocks.reduce((total, block) => total + BigInt(block.gasUsed), 0n);
  const gasLimit = blocks.reduce((total, block) => total + BigInt(block.gasLimit), 0n);
  const feeTransactionCount = blocks.reduce(
    (total, block) => total + (block.feeTransactionCount ?? 0),
    0,
  );
  const totalFees = feeTransactionCount > 0
    ? blocks.reduce(
        (total, block) => total + BigInt(block.totalFeesWei ?? 0),
        0n,
      )
    : undefined;
  const feeGasUsed = blocks.reduce(
    (total, block) => total + BigInt(block.feeGasUsed ?? 0),
    0n,
  );
  const intervals = blocks
    .slice(1)
    .map((block, index) => block.timestamp - blocks[index]!.timestamp)
    .filter((seconds) => seconds >= 0);
  const metrics: AnomalyMetricValues = {
    blocksPerMinute: blocks.length / 5,
    tps: transactionCount / BUCKET_SECONDS,
    averageUniqueSendersPerBlock:
      blocks.reduce((total, block) => total + block.uniqueSenderCount, 0) /
      blocks.length,
  };
  if (transactionCount > 0 && totalFees !== undefined) {
    metrics.averageTransactionFeeWei =
      Number(totalFees) / feeTransactionCount;
  }
  if (transactionCount > 0) {
    metrics.failedTransactionRate = failedTransactionCount / transactionCount;
  }
  if (feeGasUsed > 0n && totalFees !== undefined) {
    metrics.averageEffectiveGasPriceWei =
      Number(totalFees) / Number(feeGasUsed);
  }
  if (gasLimit > 0n) metrics.gasUtilization = Number(gasUsed) / Number(gasLimit);
  if (intervals.length > 0) {
    metrics.averageBlockIntervalSeconds =
      intervals.reduce((total, seconds) => total + seconds, 0) / intervals.length;
  }
  return {
    id: hash(`${chainId}|${start}`),
    chainId,
    start,
    end: start + BUCKET_SECONDS,
    firstBlock: first.blockNumber,
    lastBlock: last.blockNumber,
    source,
    metrics,
    learning: "accepted",
  };
}

function emptyBucket(
  chainId: string,
  start: number,
  blockNumber: number,
  source: AnomalyMetricBucket["source"],
): AnomalyMetricBucket {
  return {
    id: hash(`${chainId}|${start}`),
    chainId,
    start,
    end: start + BUCKET_SECONDS,
    firstBlock: blockNumber,
    lastBlock: blockNumber,
    source,
    metrics: { blocksPerMinute: 0, tps: 0 },
    learning: "accepted",
  };
}

export function aggregateBlockMetrics(
  chainId: string,
  blocks: BlockMetricAggregate[],
  source: AnomalyMetricBucket["source"],
): AnomalyMetricBucket[] {
  const sorted = [...blocks].sort(
    (left, right) => left.blockNumber - right.blockNumber,
  );
  const grouped = new Map<number, BlockMetricAggregate[]>();
  for (const block of sorted) {
    const start = Math.floor(block.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
    const group = grouped.get(start) ?? [];
    group.push(block);
    grouped.set(start, group);
  }
  const buckets: AnomalyMetricBucket[] = [];
  let previous: AnomalyMetricBucket | undefined;
  for (const group of grouped.values()) {
    const bucket = bucketFromBlocks(chainId, group, source);
    if (previous) {
      for (
        let missing = previous.end;
        missing < bucket.start;
        missing += BUCKET_SECONDS
      ) {
        buckets.push(emptyBucket(chainId, missing, previous.lastBlock, source));
      }
    }
    buckets.push(bucket);
    previous = bucket;
  }
  return buckets;
}

async function collectBuckets(
  chainId: string,
  blocks: AsyncIterable<BlockMetricAggregate>,
  source: AnomalyMetricBucket["source"],
): Promise<AnomalyMetricBucket[]> {
  const buckets: AnomalyMetricBucket[] = [];
  let group: BlockMetricAggregate[] = [];
  let groupStart: number | undefined;
  let previous: AnomalyMetricBucket | undefined;
  const completedBefore = Math.floor(Date.now() / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;

  const flush = () => {
    if (group.length === 0) return;
    const bucket = bucketFromBlocks(chainId, group, source);
    if (bucket.end > completedBefore) return;
    if (previous) {
      for (
        let missing = previous.end;
        missing < bucket.start;
        missing += BUCKET_SECONDS
      ) {
        buckets.push(emptyBucket(chainId, missing, previous.lastBlock, source));
      }
    }
    buckets.push(bucket);
    previous = bucket;
  };

  for await (const block of blocks) {
    const start = Math.floor(block.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
    if (groupStart !== undefined && start !== groupStart) {
      flush();
      group = [];
    }
    groupStart = start;
    group.push(block);
  }
  flush();
  return buckets;
}

function transform(metric: AnomalyMetricName, value: number): number {
  if (ratioMetrics.has(metric)) {
    const clamped = Math.min(1 - 1e-6, Math.max(1e-6, value));
    return Math.log(clamped / (1 - clamped));
  }
  return Math.log1p(Math.max(0, value));
}

function inverseTransform(metric: AnomalyMetricName, value: number): number {
  if (ratioMetrics.has(metric)) return 1 / (1 + Math.exp(-value));
  return Math.max(0, Math.expm1(value));
}

function studentCritical(z: number, degreesOfFreedom: number): number {
  const df = Math.max(3, degreesOfFreedom);
  const z2 = z * z;
  return (
    z +
    (z * z2 + z) / (4 * df) +
    (5 * z * z2 * z2 + 16 * z * z2 + 3 * z) / (96 * df * df)
  );
}

function sameSeason(left: number, right: number): boolean {
  const leftDate = new Date(left * 1000);
  const rightDate = new Date(right * 1000);
  const leftWeekend = leftDate.getUTCDay() === 0 || leftDate.getUTCDay() === 6;
  const rightWeekend = rightDate.getUTCDay() === 0 || rightDate.getUTCDay() === 6;
  return (
    leftDate.getUTCHours() === rightDate.getUTCHours() &&
    Math.floor(leftDate.getUTCMinutes() / 5) ===
      Math.floor(rightDate.getUTCMinutes() / 5) &&
    leftWeekend === rightWeekend
  );
}

function predictionForMetric(
  metric: AnomalyMetricName,
  at: number,
  history: AnomalyMetricBucket[],
): MetricPrediction | undefined {
  const available = history.filter(
    (bucket) =>
      bucket.learning === "accepted" &&
      bucket.start >= at - HISTORY_SECONDS &&
      bucket.start < at &&
      bucket.metrics[metric] !== undefined,
  );
  if (available.length < MIN_READY_BUCKETS) return undefined;
  const seasonal = available.filter((bucket) => sameSeason(bucket.start, at));
  const sample = seasonal.length >= 7 ? seasonal : available;
  const values = sample.map((bucket) => transform(metric, bucket.metrics[metric]!));
  const count = values.length;
  const mean = values.reduce((total, value) => total + value, 0) / count;
  const sumSquares = values.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  );
  const variance = Math.max(sumSquares / Math.max(1, count - 1), 1e-4);

  const kappa0 = 0.01;
  const alpha0 = 2;
  const beta0 = variance;
  const kappa = kappa0 + count;
  const alpha = alpha0 + count / 2;
  const beta = beta0 + sumSquares / 2;
  const scale = Math.sqrt((beta * (kappa + 1)) / (alpha * kappa));
  const df = 2 * alpha;
  const critical99 = studentCritical(2.575829, df);
  const critical999 = studentCritical(3.290527, df);
  return {
    expected: inverseTransform(metric, mean),
    lower99: inverseTransform(metric, mean - critical99 * scale),
    upper99: inverseTransform(metric, mean + critical99 * scale),
    lower999: inverseTransform(metric, mean - critical999 * scale),
    upper999: inverseTransform(metric, mean + critical999 * scale),
  };
}

export function scoreAnomalyBucketV1(
  bucket: AnomalyMetricBucket,
  history: AnomalyMetricBucket[],
): AnomalySignal[] {
  const chainHistory = history.filter(({ chainId }) => chainId === bucket.chainId);
  const signals: AnomalySignal[] = [];
  for (const metric of metricNames) {
    const observed = bucket.metrics[metric];
    if (observed === undefined || !Number.isFinite(observed)) continue;
    const prediction = predictionForMetric(metric, bucket.start, chainHistory);
    if (!prediction) continue;
    const critical =
      observed < prediction.lower999 || observed > prediction.upper999;
    const warning = observed < prediction.lower99 || observed > prediction.upper99;
    if (!warning) continue;
    const direction = observed < prediction.expected ? "low" : "high";
    if (direction === "low" && highOnlyMetrics.has(metric)) continue;
    signals.push({
      metric,
      direction,
      observed,
      ...prediction,
      severity: critical ? "critical" : "warning",
    });
  }
  return signals;
}

export function scoreAnomalyBucket(
  bucket: AnomalyMetricBucket,
  history: AnomalyMetricBucket[],
): AnomalySignal[] {
  return MODEL_VERSION === "bayesian-nig-conformal-v2"
    ? scoreAnomalyBucketV2(bucket, history, MODEL_PROFILE)
    : scoreAnomalyBucketV1(bucket, history);
}

function sameSignal(left: AnomalySignal, right: AnomalySignal): boolean {
  return left.metric === right.metric && left.direction === right.direction;
}

function queueWebhook(
  database: Database,
  alertId: string,
  event: AnomalyWebhookDelivery["event"],
): void {
  if (!process.env.ANOMALY_WEBHOOK_URL || !process.env.ANOMALY_WEBHOOK_SECRET) return;
  const deliveryId = hash(`${alertId}|${event}|${Date.now()}`);
  if (database.anomalyWebhookDeliveries.some(({ id }) => id === deliveryId)) return;
  const now = new Date().toISOString();
  database.anomalyWebhookDeliveries.push({
    id: deliveryId,
    alertId,
    event,
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
  });
}

function queueWalletNotifications(
  database: Database,
  alert: AnomalyAlert,
  event: AnomalyWalletNotification["event"],
): void {
  for (const watch of database.anomalyWalletWatches.filter(
    ({ chainId }) => chainId === alert.chainId,
  )) {
    const id = hash(`${watch.id}|${alert.id}|${event}`);
    if (database.anomalyWalletNotifications.some((item) => item.id === id)) {
      continue;
    }
    database.anomalyWalletNotifications.push({
      id,
      watchId: watch.id,
      wallet: watch.wallet,
      chainId: alert.chainId,
      alertId: alert.id,
      event,
      severity: alert.severity,
      createdAt: new Date().toISOString(),
    });
  }
}

export function applyAnomalyBuckets(
  database: Database,
  incoming: AnomalyMetricBucket[],
  referenceTime = Math.floor(Date.now() / 1000),
): void {
  const scorers = new Map<string, BayesianConformalScorer>();
  const scoreCache = new Map<string, ReturnType<BayesianConformalScorer["preview"]>>();
  const scorerFor = (chainId: string) => {
    let scorer = scorers.get(chainId);
    if (!scorer) {
      scorer = new BayesianConformalScorer(chainId, MODEL_PROFILE);
      scorer.warm(
        database.anomalyMetricBuckets.filter(
          (bucket) => bucket.chainId === chainId,
        ),
      );
      scorers.set(chainId, scorer);
    }
    return scorer;
  };
  for (const bucket of incoming.sort((left, right) => left.start - right.start)) {
    if (database.anomalyMetricBuckets.some(({ id }) => id === bucket.id)) continue;
    const chainHistory = database.anomalyMetricBuckets.filter(
      ({ chainId }) => chainId === bucket.chainId,
    );
    const scorer =
      MODEL_VERSION === "bayesian-nig-conformal-v2"
        ? scorerFor(bucket.chainId)
        : undefined;
    const rawScore = scorer?.preview(bucket) ?? {
      signals: scoreAnomalyBucketV1(bucket, chainHistory),
      predictions: {},
      observations: [],
    };
    const rawSignals = rawScore.signals;
    const previous = chainHistory
      .filter(({ start }) => start === bucket.start - BUCKET_SECONDS)
      .at(-1);
    const previousSignals = previous
      ? scoreCache.get(previous.id)?.signals ??
        scoreAnomalyBucket(
          previous,
          chainHistory.filter(({ start }) => start < previous.start),
        )
      : [];
    const criticalSignals = rawSignals.filter(({ severity }) => severity === "critical");
    const repeatedWarnings = rawSignals.filter(
      (signal) =>
        signal.severity === "warning" &&
        previous?.learning === "quarantined" &&
        previousSignals.some(
          (previousSignal) =>
            previousSignal.severity === "warning" &&
            sameSignal(previousSignal, signal),
        ),
    );
    const alertSignals =
      criticalSignals.length > 0 ? rawSignals : repeatedWarnings;
    bucket.learning = rawSignals.length > 0 ? "quarantined" : "accepted";

    if (
      previous?.learning === "quarantined" &&
      !database.anomalyAlerts.some(({ bucketIds }) => bucketIds.includes(previous.id)) &&
      repeatedWarnings.length === 0
    ) {
      previous.learning = "accepted";
      if (scorer) scorer.observe(previous, scorer.preview(previous));
    }
    database.anomalyMetricBuckets.push(bucket);
    scoreCache.set(bucket.id, rawScore);
    if (bucket.learning === "accepted" && scorer) scorer.observe(bucket, rawScore);
    if (alertSignals.length === 0) continue;

    const severity = alertSignals.some(({ severity: level }) => level === "critical")
      ? "critical"
      : "warning";
    const startedAt =
      severity === "warning" && previous ? previous.start : bucket.start;
    const active = database.anomalyAlerts.find(
      (alert) =>
        alert.chainId === bucket.chainId &&
        alert.status !== "resolved" &&
        alert.endedAt >= startedAt - BUCKET_SECONDS,
    );
    if (active) {
      const escalated = active.severity === "warning" && severity === "critical";
      active.severity = severity === "critical" ? "critical" : active.severity;
      active.endedAt = bucket.end;
      active.lastBlock = bucket.lastBlock;
      active.updatedAt = new Date().toISOString();
      for (const bucketId of [
        ...(severity === "warning" && previous ? [previous.id] : []),
        bucket.id,
      ]) {
        if (!active.bucketIds.includes(bucketId)) active.bucketIds.push(bucketId);
      }
      for (const signal of alertSignals) {
        const index = active.signals.findIndex((candidate) =>
          sameSignal(candidate, signal),
        );
        if (index === -1) active.signals.push(signal);
        else active.signals[index] = signal;
      }
      if (escalated) {
        queueWebhook(database, active.id, "anomaly.escalated");
        queueWalletNotifications(database, active, "anomaly.escalated");
      }
      continue;
    }

    const now = new Date().toISOString();
    const id = hash(
      `${bucket.chainId}|${startedAt}|${alertSignals
        .map(({ metric, direction }) => `${metric}:${direction}`)
        .sort()
        .join(",")}`,
    );
    const alert: AnomalyAlert = {
      id,
      chainId: bucket.chainId,
      status: "open",
      severity,
      startedAt,
      endedAt: bucket.end,
      firstBlock: previous && severity === "warning" ? previous.firstBlock : bucket.firstBlock,
      lastBlock: bucket.lastBlock,
      bucketIds: [
        ...(previous && severity === "warning" ? [previous.id] : []),
        bucket.id,
      ],
      signals: alertSignals,
      modelVersion: MODEL_VERSION,
      source: bucket.source,
      createdAt: now,
      updatedAt: now,
    };
    database.anomalyAlerts.push(alert);
    queueWebhook(database, alert.id, "anomaly.opened");
    queueWalletNotifications(database, alert, "anomaly.opened");
  }

  const cutoff = referenceTime - HISTORY_SECONDS;
  const linked = new Set(
    database.anomalyAlerts.flatMap(({ bucketIds }) => bucketIds),
  );
  database.anomalyMetricBuckets = database.anomalyMetricBuckets.filter(
    (bucket) => bucket.start >= cutoff || linked.has(bucket.id),
  );
}

export function anomalyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
}

export class AnomalyMonitor {
  private readonly enabled = anomalyMonitoringEnabled();
  private readonly chains: AnomalyChainConfig[] = [];
  private configurationError?: string;
  private running: Promise<void> | undefined;

  constructor(private readonly store: Store) {
    if (!this.enabled) return;
    try {
      this.chains = parseAnomalyChains();
    } catch (error) {
      this.configurationError =
        error instanceof Error ? error.message : String(error);
    }
  }

  start(): void {
    if (!this.enabled || this.configurationError) return;
    void this.run();
    const monitorTimer = setInterval(() => void this.run(), 60_000);
    const heartbeatTimer = setInterval(
      () => void this.refreshHeartbeats(),
      60_000,
    );
    monitorTimer.unref();
    heartbeatTimer.unref();
  }

  private async refreshHeartbeats(): Promise<void> {
    await Promise.all(
      this.chains.map(async (chain) => {
        try {
          await this.checkHeartbeat(chain);
        } catch (error) {
          await this.recordHeartbeatFailure(
            chain.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );
  }

  async run(chainId?: string): Promise<void> {
    if (!this.enabled) return;
    if (this.configurationError) {
      throw new BitebackError(
        "ANOMALY_CONFIG_INVALID",
        this.configurationError,
        503,
      );
    }
    if (this.running) return this.running;
    this.running = this.runConfiguredChains(chainId).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runConfiguredChains(chainId?: string): Promise<void> {
    const selected = chainId
      ? this.chains.filter(({ id }) => id === chainId)
      : this.chains;
    if (chainId && selected.length === 0) {
      throw new BitebackError("ANOMALY_CHAIN_NOT_FOUND", "Chain not found.", 404);
    }
    for (const chain of selected) {
      await this.runChain(chain);
    }
    await this.deliverDueWebhooks();
  }

  private async runChain(chain: AnomalyChainConfig): Promise<void> {
    await this.setCursor(chain.id, { status: "syncing", error: undefined });
    let heartbeatRecorded = false;
    try {
      const heartbeat = await this.checkHeartbeat(chain);
      const { head } = heartbeat;
      heartbeatRecorded = true;
      const database = this.store.read();
      const cursor = database.anomalyMonitorCursors.find(
        ({ chainId }) => chainId === chain.id,
      );
      const latestBucket = database.anomalyMetricBuckets
        .filter(({ chainId }) => chainId === chain.id)
        .sort((left, right) => right.start - left.start)[0];
      const startBlock =
        cursor?.lastFinalizedBlock !== undefined
          ? cursor.lastFinalizedBlock + 1
          : latestBucket
            ? latestBucket.lastBlock + 1
            : await blockAtOrAfterTimestamp(
                chain,
                head,
                Math.floor(Date.now() / 1000) - HISTORY_SECONDS,
              );
      let buckets: AnomalyMetricBucket[] = [];
      if (startBlock <= head) {
        const stopBlock = Math.min(
          head,
          startBlock + BACKFILL_BLOCKS_PER_RUN - 1,
        );
        const queriedAt = new Date().toISOString();
        if (chain.substreamsEndpoint) {
          try {
            buckets = await collectBuckets(
              chain.id,
              substreamsBlockMetrics(chain, startBlock, stopBlock),
              {
                provider: "the-graph-substreams",
                endpoint: publicEndpoint(chain.substreamsEndpoint),
                queriedAt,
              },
            );
          } catch {
            buckets = await collectBuckets(
              chain.id,
              rpcBlockMetrics(
                chain,
                startBlock,
                Math.min(head, startBlock + RPC_BLOCKS_PER_RUN - 1),
              ),
              {
                provider: "evm-rpc",
                endpoint: publicEndpoint(chain.rpcUrl),
                queriedAt,
              },
            );
          }
        } else {
          buckets = await collectBuckets(
            chain.id,
            rpcBlockMetrics(
              chain,
              startBlock,
              Math.min(head, startBlock + RPC_BLOCKS_PER_RUN - 1),
            ),
            {
              provider: "evm-rpc",
              endpoint: publicEndpoint(chain.rpcUrl),
              queriedAt,
            },
          );
        }
        const firstBucket = buckets[0];
        if (latestBucket && firstBucket && latestBucket.end < firstBucket.start) {
          const missing: AnomalyMetricBucket[] = [];
          for (
            let start = latestBucket.end;
            start < firstBucket.start;
            start += BUCKET_SECONDS
          ) {
            missing.push(
              emptyBucket(chain.id, start, latestBucket.lastBlock, firstBucket.source),
            );
          }
          buckets = [...missing, ...buckets];
        }
      } else if (
        latestBucket &&
        (!chain.secondaryRpcUrl || heartbeat.quorum === "agreed")
      ) {
        const completedBefore =
          Math.floor(Date.now() / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;
        const source: AnomalyMetricBucket["source"] = {
          provider: "evm-rpc",
          endpoint: publicEndpoint(chain.rpcUrl),
          queriedAt: new Date().toISOString(),
        };
        for (
          let start = latestBucket.end;
          start < completedBefore && buckets.length < 12;
          start += BUCKET_SECONDS
        ) {
          buckets.push(emptyBucket(chain.id, start, head, source));
        }
      }

      await this.store.update((next) => {
        applyAnomalyBuckets(next, buckets);
        const nextCursor =
          next.anomalyMonitorCursors.find(({ chainId }) => chainId === chain.id) ??
          {
            chainId: chain.id,
            status: "idle" as const,
            ready: false,
            acceptedBuckets: 0,
          };
        if (!next.anomalyMonitorCursors.includes(nextCursor)) {
          next.anomalyMonitorCursors.push(nextCursor);
        }
        const acceptedBuckets = next.anomalyMetricBuckets.filter(
          (bucket) =>
            bucket.chainId === chain.id && bucket.learning === "accepted",
        ).length;
        const lastProcessed = buckets.at(-1)?.lastBlock;
        if (lastProcessed !== undefined) {
          nextCursor.lastFinalizedBlock = lastProcessed;
        }
        const completedBlock = nextCursor.lastFinalizedBlock ?? startBlock - 1;
        nextCursor.backfillStartBlock ??= Math.min(startBlock, completedBlock);
        nextCursor.backfillTargetBlock = head;
        nextCursor.backfillProgress = Math.max(
          0,
          Math.min(
            1,
            (completedBlock - nextCursor.backfillStartBlock + 1) /
              Math.max(
                1,
                nextCursor.backfillTargetBlock -
                  nextCursor.backfillStartBlock +
                  1,
              ),
          ),
        );
        nextCursor.status =
          chain.secondaryRpcUrl && heartbeat.quorum !== "agreed"
            ? "degraded"
            : completedBlock < head
              ? "syncing"
              : "ready";
        nextCursor.ready = acceptedBuckets >= MIN_READY_BUCKETS;
        nextCursor.acceptedBuckets = acceptedBuckets;
        nextCursor.lastRunAt = new Date().toISOString();
        nextCursor.lastSuccessAt = nextCursor.lastRunAt;
        delete nextCursor.error;
      });
    } catch (error) {
      await this.setCursor(chain.id, {
        status: "degraded",
        error: error instanceof Error ? error.message : String(error),
        heartbeatFailed: !heartbeatRecorded,
      });
    }
  }

  private async recordHeartbeat(
    chainId: string,
    primary: HeartbeatObservation,
    quorum: "single" | "agreed" | "disagreed",
    secondary?: HeartbeatObservation,
    quorumError?: string,
  ): Promise<void> {
    await this.store.update((database) => {
      let cursor = database.anomalyMonitorCursors.find(
        (candidate) => candidate.chainId === chainId,
      );
      if (!cursor) {
        cursor = {
          chainId,
          status: "syncing",
          ready: false,
          acceptedBuckets: 0,
        };
        database.anomalyMonitorCursors.push(cursor);
      }
      cursor.heartbeatAt = new Date().toISOString();
      cursor.lastObservedHead = primary.head;
      cursor.lastObservedBlockTimestamp = primary.blockTimestamp;
      cursor.rpcLatencyMs = primary.latencyMs;
      cursor.heartbeatQuorum = quorum;
      if (secondary) {
        cursor.secondaryObservedHead = secondary.head;
        cursor.secondaryBlockTimestamp = secondary.blockTimestamp;
        cursor.secondaryRpcLatencyMs = secondary.latencyMs;
      } else {
        delete cursor.secondaryObservedHead;
        delete cursor.secondaryBlockTimestamp;
        delete cursor.secondaryRpcLatencyMs;
      }
      cursor.consecutiveHeartbeatFailures = 0;
      if (quorumError) cursor.heartbeatError = quorumError;
      else delete cursor.heartbeatError;
    });
  }

  private async checkHeartbeat(
    chain: AnomalyChainConfig,
  ): Promise<
    HeartbeatObservation & { quorum: "single" | "agreed" | "disagreed" }
  > {
    const primary = await heartbeatObservation(
      chain.rpcUrl,
      chain.confirmations,
    );
    if (!chain.secondaryRpcUrl) {
      await this.recordHeartbeat(chain.id, primary, "single");
      return { ...primary, quorum: "single" };
    }
    let quorum: "agreed" | "disagreed" = "disagreed";
    try {
      const secondary = await heartbeatObservation(
        chain.secondaryRpcUrl,
        chain.confirmations,
      );
      const allowedHeadDifference = Math.max(
        2,
        Math.ceil(chain.confirmations / 2),
      );
      const agreed =
        Math.abs(primary.head - secondary.head) <= allowedHeadDifference &&
        Math.abs(primary.blockTimestamp - secondary.blockTimestamp) <= 120;
      quorum = agreed ? "agreed" : "disagreed";
      await this.recordHeartbeat(
        chain.id,
        primary,
        quorum,
        secondary,
        agreed
          ? undefined
          : "RPC providers disagree on the finalized chain head.",
      );
    } catch (error) {
      await this.recordHeartbeat(
        chain.id,
        primary,
        "disagreed",
        undefined,
        `Secondary RPC failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { ...primary, quorum };
  }

  private async recordHeartbeatFailure(
    chainId: string,
    error: string,
  ): Promise<void> {
    await this.store.update((database) => {
      let cursor = database.anomalyMonitorCursors.find(
        (candidate) => candidate.chainId === chainId,
      );
      if (!cursor) {
        cursor = {
          chainId,
          status: "idle",
          ready: false,
          acceptedBuckets: 0,
        };
        database.anomalyMonitorCursors.push(cursor);
      }
      cursor.consecutiveHeartbeatFailures =
        (cursor.consecutiveHeartbeatFailures ?? 0) + 1;
      cursor.heartbeatError = error;
    });
  }

  private async setCursor(
    chainId: string,
    patch: {
      status: "syncing" | "degraded";
      error: string | undefined;
      heartbeatFailed?: boolean;
    },
  ): Promise<void> {
    await this.store.update((database) => {
      let cursor = database.anomalyMonitorCursors.find(
        (candidate) => candidate.chainId === chainId,
      );
      if (!cursor) {
        cursor = {
          chainId,
          status: "idle",
          ready: false,
          acceptedBuckets: 0,
        };
        database.anomalyMonitorCursors.push(cursor);
      }
      cursor.status = patch.status;
      cursor.lastRunAt = new Date().toISOString();
      if (patch.heartbeatFailed) {
        cursor.consecutiveHeartbeatFailures =
          (cursor.consecutiveHeartbeatFailures ?? 0) + 1;
        if (patch.error) cursor.heartbeatError = patch.error;
      }
      if (patch.error) cursor.error = patch.error;
      else delete cursor.error;
    });
  }

  private async deliverDueWebhooks(): Promise<void> {
    const url = process.env.ANOMALY_WEBHOOK_URL;
    const secret = process.env.ANOMALY_WEBHOOK_SECRET;
    if (!url || !secret) return;
    const due = this.store
      .read()
      .anomalyWebhookDeliveries.filter(
        (delivery) =>
          !delivery.deliveredAt &&
          !delivery.failedAt &&
          delivery.nextAttemptAt <= new Date().toISOString(),
      );
    for (const delivery of due) {
      const alert = this.store
        .read()
        .anomalyAlerts.find(({ id }) => id === delivery.alertId);
      if (!alert) continue;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({
        event: delivery.event,
        deliveryId: delivery.id,
        sentAt: new Date().toISOString(),
        alert,
        wallets: this.store
          .read()
          .anomalyWalletNotifications.filter(
            (notification) =>
              notification.alertId === alert.id &&
              notification.event === delivery.event,
          )
          .map(({ wallet }) => wallet),
      });
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-biteback-event": delivery.event,
            "x-biteback-delivery": delivery.id,
            "x-biteback-timestamp": timestamp,
            "x-biteback-signature": anomalyWebhookSignature(
              secret,
              timestamp,
              body,
            ),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Webhook returned ${response.status}.`);
        await this.store.update((database) => {
          const target = database.anomalyWebhookDeliveries.find(
            ({ id }) => id === delivery.id,
          );
          if (!target) return;
          target.attempts += 1;
          target.deliveredAt = new Date().toISOString();
          delete target.lastError;
        });
      } catch (error) {
        await this.store.update((database) => {
          const target = database.anomalyWebhookDeliveries.find(
            ({ id }) => id === delivery.id,
          );
          if (!target) return;
          target.attempts += 1;
          target.lastError = error instanceof Error ? error.message : String(error);
          const delay = RETRY_SECONDS[target.attempts - 1];
          if (delay === undefined) {
            target.failedAt = new Date().toISOString();
          } else {
            target.nextAttemptAt = new Date(Date.now() + delay * 1000).toISOString();
          }
        });
      }
    }
  }

  chainStates() {
    const database = this.store.read();
    const heartbeatByChain = new Map(
      this.heartbeat().chains.map((chain) => [chain.id, chain]),
    );
    return {
      enabled: this.enabled,
      ...(this.configurationError ? { error: this.configurationError } : {}),
      chains: this.chains.map((chain) => {
        const cursor = database.anomalyMonitorCursors.find(
          ({ chainId }) => chainId === chain.id,
        );
        const latest = database.anomalyMetricBuckets
          .filter(({ chainId }) => chainId === chain.id)
          .sort((left, right) => right.start - left.start)[0];
        return {
          id: chain.id,
          name: chain.name,
          chainId: chain.chainId,
          source:
            latest?.source.provider ??
            (chain.substreamsEndpoint ? "the-graph-substreams" : "evm-rpc"),
          confirmations: chain.confirmations,
          status: cursor?.status ?? "idle",
          ready: cursor?.ready ?? false,
          acceptedBuckets: cursor?.acceptedBuckets ?? 0,
          lastRunAt: cursor?.lastRunAt ?? null,
          lastSuccessAt: cursor?.lastSuccessAt ?? null,
          backfillProgress: cursor?.backfillProgress ?? 0,
          heartbeat: heartbeatByChain.get(chain.id) ?? null,
          error: cursor?.error ?? null,
          latest: latest ?? null,
          openAlerts: database.anomalyAlerts.filter(
            (alert) => alert.chainId === chain.id && alert.status !== "resolved",
          ).length,
        };
      }),
    };
  }

  heartbeat() {
    const database = this.store.read();
    const checkedAt = Math.floor(Date.now() / 1000);
    const staleAfterSeconds = heartbeatStaleSeconds();
    const chains = this.chains.map((chain) => {
      const cursor = database.anomalyMonitorCursors.find(
        ({ chainId }) => chainId === chain.id,
      );
      const heartbeatAt = cursor?.heartbeatAt
        ? Math.floor(Date.parse(cursor.heartbeatAt) / 1000)
        : undefined;
      const observerAgeSeconds =
        heartbeatAt === undefined ? null : Math.max(0, checkedAt - heartbeatAt);
      const blockAgeSeconds =
        cursor?.lastObservedBlockTimestamp === undefined
          ? null
          : Math.max(0, checkedAt - cursor.lastObservedBlockTimestamp);
      const failures = cursor?.consecutiveHeartbeatFailures ?? 0;
      const quorum =
        cursor?.heartbeatQuorum ??
        (chain.secondaryRpcUrl ? "disagreed" : "single");
      let status: "healthy" | "degraded" | "stalled" | "down" | "unknown" =
        "healthy";
      if (heartbeatAt === undefined) {
        status = cursor?.status === "degraded" ? "down" : "unknown";
      } else if (
        failures >= 2 ||
        (observerAgeSeconds ?? 0) > staleAfterSeconds * 2
      ) {
        status = "down";
      } else if (chain.secondaryRpcUrl && quorum !== "agreed") {
        status = "degraded";
      } else if ((blockAgeSeconds ?? 0) > staleAfterSeconds) {
        status = "stalled";
      } else if (failures > 0 || cursor?.status === "degraded") {
        status = "degraded";
      }
      return {
        id: chain.id,
        name: chain.name,
        chainId: chain.chainId,
        status,
        heartbeatAt: cursor?.heartbeatAt ?? null,
        observerAgeSeconds,
        blockAgeSeconds,
        finalizedBlock: cursor?.lastObservedHead ?? null,
        rpcLatencyMs: cursor?.rpcLatencyMs ?? null,
        quorum,
        secondaryFinalizedBlock: cursor?.secondaryObservedHead ?? null,
        secondaryRpcLatencyMs: cursor?.secondaryRpcLatencyMs ?? null,
        consecutiveFailures: failures,
        error: cursor?.heartbeatError ?? cursor?.error ?? null,
      };
    });
    const statuses = new Set(chains.map(({ status }) => status));
    const status = !this.enabled
      ? "disabled"
      : chains.length === 0 || statuses.has("unknown")
        ? "unknown"
        : statuses.has("down") || statuses.has("stalled")
          ? "unhealthy"
          : statuses.has("degraded")
            ? "degraded"
            : "healthy";
    return {
      enabled: this.enabled,
      status,
      checkedAt: new Date(checkedAt * 1000).toISOString(),
      intervalSeconds: 60,
      staleAfterSeconds,
      chains,
    };
  }

  metrics(chainId: string, from?: number, to?: number) {
    if (!this.chains.some(({ id }) => id === chainId)) {
      throw new BitebackError("ANOMALY_CHAIN_NOT_FOUND", "Chain not found.", 404);
    }
    const history = this.store
      .read()
      .anomalyMetricBuckets.filter(({ chainId: candidate }) => candidate === chainId)
      .sort((left, right) => left.start - right.start);
    const buckets = history.filter(
        (bucket) =>
          (from === undefined || bucket.start >= from) &&
          (to === undefined || bucket.end <= to),
      );
    const latest = buckets.at(-1);
    const at = latest?.end ?? history.at(-1)?.end ?? Math.floor(Date.now() / 1000);
    const expected =
      MODEL_VERSION === "bayesian-nig-conformal-v2"
        ? (() => {
            const scorer = new BayesianConformalScorer(
              chainId,
              MODEL_PROFILE,
            );
            scorer.warm(history);
            return scorer.expected(at);
          })()
        : Object.fromEntries(
            metricNames.flatMap((metric) => {
              const prediction = predictionForMetric(metric, at, history);
              return prediction ? [[metric, prediction]] : [];
            }),
          );
    return {
      buckets,
      expected,
      modelVersion: MODEL_VERSION,
    };
  }

  alerts(filters: {
    chainId?: string | undefined;
    status?: AnomalyAlert["status"] | undefined;
    severity?: AnomalyAlert["severity"] | undefined;
    limit?: number | undefined;
  }): AnomalyAlert[] {
    return this.store
      .read()
      .anomalyAlerts.filter(
        (alert) =>
          (!filters.chainId || alert.chainId === filters.chainId) &&
          (!filters.status || alert.status === filters.status) &&
          (!filters.severity || alert.severity === filters.severity),
      )
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, filters.limit ?? 100);
  }

  alert(id: string): AnomalyAlert {
    const alert = this.store.read().anomalyAlerts.find((candidate) => candidate.id === id);
    if (!alert) {
      throw new BitebackError("ANOMALY_ALERT_NOT_FOUND", "Alert not found.", 404);
    }
    return alert;
  }

  assessment(id: string) {
    const alert = this.alert(id);
    const signals = new Set(
      alert.signals.map(({ metric, direction }) => `${metric}:${direction}`),
    );
    if (
      signals.has("blocksPerMinute:low") ||
      signals.has("averageBlockIntervalSeconds:high")
    ) {
      return {
        kind: "network-liveness",
        walletWarning:
          "Transactions may remain pending or appear inconsistently across RPC providers.",
        suggestedActions: [
          "Pause time-sensitive transactions.",
          "Check the transaction on a second RPC provider before retrying.",
          "After recovery, verify nonce and receipt status before submitting replacements.",
        ],
      };
    }
    if (
      signals.has("averageTransactionFeeWei:high") ||
      signals.has("averageEffectiveGasPriceWei:high") ||
      signals.has("gasUtilization:high")
    ) {
      return {
        kind: "fee-pressure",
        walletWarning: "Transactions may be unusually expensive or delayed.",
        suggestedActions: [
          "Delay non-urgent transactions.",
          "Set an explicit fee ceiling and avoid blind replacement transactions.",
        ],
      };
    }
    if (signals.has("failedTransactionRate:high")) {
      return {
        kind: "execution-failures",
        walletWarning: "Transactions are failing more often than the chain baseline.",
        suggestedActions: [
          "Simulate the transaction before resubmitting.",
          "Verify contract state, allowance, nonce, and slippage.",
        ],
      };
    }
    return {
      kind: signals.has("tps:high") ? "activity-spike" : "activity-drop",
      walletWarning: "Chain activity is outside its normal credible range.",
      suggestedActions: [
        "Verify the signal across a second data source.",
        "Review affected transactions before opening any dispute.",
      ],
    };
  }

  async watchWallet(
    wallet: string,
    chainId: string,
  ): Promise<AnomalyWalletWatch> {
    if (!this.chains.some(({ id }) => id === chainId)) {
      throw new BitebackError("ANOMALY_CHAIN_NOT_FOUND", "Chain not found.", 404);
    }
    const id = hash(`${wallet.toLowerCase()}|${chainId}`);
    await this.store.update((database) => {
      if (!database.anomalyWalletWatches.some((watch) => watch.id === id)) {
        database.anomalyWalletWatches.push({
          id,
          wallet: wallet.toLowerCase(),
          chainId,
          createdAt: new Date().toISOString(),
        });
      }
      for (const alert of database.anomalyAlerts.filter(
        (candidate) =>
          candidate.chainId === chainId && candidate.status !== "resolved",
      )) {
        queueWalletNotifications(database, alert, "anomaly.opened");
      }
    });
    return this.store
      .read()
      .anomalyWalletWatches.find((watch) => watch.id === id)!;
  }

  walletNotifications(
    wallet: string,
    chainId?: string,
    limit = 100,
  ) {
    return this.store
      .read()
      .anomalyWalletNotifications.filter(
        (notification) =>
          notification.wallet === wallet.toLowerCase() &&
          (!chainId || notification.chainId === chainId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((notification) => ({
        ...notification,
        alert: this.alert(notification.alertId),
        assessment: this.assessment(notification.alertId),
      }));
  }

  disputeReadiness(id: string, wallet?: string) {
    const alert = this.alert(id);
    const chain = this.chains.find(({ id: chainId }) => chainId === alert.chainId)!;
    const normalizedWallet = wallet?.toLowerCase();
    const relatedIncidents = this.store
      .read()
      .incidents.filter(
        (incident) =>
          incident.evidence.rule.sourceChain === `eip155:${chain.chainId}` &&
          incident.violations.some(
            (violation) =>
              (!normalizedWallet || violation.victim === normalizedWallet) &&
              [
                ...violation.withinPolicyPayments,
                ...violation.excessCharges,
              ].some(
                ({ timestamp }) =>
                  timestamp >= alert.startedAt - 3_600 &&
                  timestamp <= alert.endedAt + 3_600,
              ),
          ),
      )
      .map((incident) => ({
        id: incident.id,
        status: incident.status,
        victims: incident.violations.length,
        evidenceHash: incident.evidenceHash,
      }));
    return {
      anomalyCanOpenDispute: false,
      relatedIncidents,
      collectiveDisputeReady: relatedIncidents.length > 0,
      requirements: [
        "A wallet signs one confirmed transaction report.",
        "A published deterministic rule matches that transaction.",
        "The Graph independently derives every affected wallet and violation.",
      ],
      reportEndpoint: "/api/report",
    };
  }

  async acknowledge(id: string, note?: string): Promise<AnomalyAlert> {
    await this.store.update((database) => {
      const alert = database.anomalyAlerts.find((candidate) => candidate.id === id);
      if (!alert) {
        throw new BitebackError("ANOMALY_ALERT_NOT_FOUND", "Alert not found.", 404);
      }
      if (alert.status === "resolved") {
        throw new BitebackError("ANOMALY_ALERT_RESOLVED", "Alert is already resolved.", 409);
      }
      alert.status = "acknowledged";
      alert.acknowledgedAt = new Date().toISOString();
      alert.updatedAt = alert.acknowledgedAt;
      if (note) alert.note = note;
    });
    return this.alert(id);
  }

  async resolve(
    id: string,
    classification: "expected" | "confirmed",
    note: string,
  ): Promise<AnomalyAlert> {
    await this.store.update((database) => {
      const alert = database.anomalyAlerts.find((candidate) => candidate.id === id);
      if (!alert) {
        throw new BitebackError("ANOMALY_ALERT_NOT_FOUND", "Alert not found.", 404);
      }
      if (alert.status === "resolved") return;
      const now = new Date().toISOString();
      alert.status = "resolved";
      alert.classification = classification;
      alert.note = note;
      alert.resolvedAt = now;
      alert.updatedAt = now;
      if (classification === "expected") {
        for (const bucket of database.anomalyMetricBuckets) {
          if (alert.bucketIds.includes(bucket.id)) bucket.learning = "accepted";
        }
      }
      queueWebhook(database, alert.id, "anomaly.resolved");
      queueWalletNotifications(database, alert, "anomaly.resolved");
    });
    await this.deliverDueWebhooks();
    return this.alert(id);
  }
}
