import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createAuthInterceptor,
  createRegistry,
  createRequest,
  fetchSubstream,
  streamBlocks,
  unpackMapOutput,
} from "@substreams/core";
import { BitebackError, type GraphSource, type Payment } from "./domain.js";

interface TokenApiTransfer {
  block_num: number;
  datetime: string;
  timestamp: number;
  transaction_id: string;
  log_index: number;
  contract: string;
  from: string;
  to: string;
  amount: string;
}

interface TokenApiResponse {
  data?: TokenApiTransfer[];
  error?: { detail?: string; message?: string };
  message?: string;
}

interface SubstreamsTransfer {
  blockHash: string;
  blockNumber: string;
  blockTimestamp: string;
  txnHash: string;
  from: string;
  to: string;
  value: string;
  tokenAddr: string;
}

interface SubstreamsOutput {
  transfers?: SubstreamsTransfer[];
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
}

interface RpcResponse {
  result?: {
    blockNumber: string;
    status?: string;
    logs: RpcLog[];
  };
  error?: { message?: string };
}

interface RpcBlockNumberResponse {
  result?: string;
  error?: { message?: string };
}

export interface GraphPayments {
  payments: Payment[];
  source: GraphSource;
}

const tokenApiEndpoint = process.env.PINAX_BASE ?? "https://api.pinax.network/v1";

export async function queryPayments(from: number, to: number): Promise<GraphPayments> {
  if (process.env.SOURCE_PROVIDER === "substreams") return querySubstreams(from, to);
  return queryTokenApi(from, to);
}

async function queryTokenApi(from: number, to: number): Promise<GraphPayments> {
  const token = process.env.PINAX_JWT;
  const merchant = process.env.SOURCE_MERCHANT_ADDRESS;
  const contract = process.env.SOURCE_TOKEN_ADDRESS;
  const network = process.env.SOURCE_NETWORK ?? "base";
  if (!token || !merchant || !contract) {
    throw new BitebackError(
      "GRAPH_QUERY_FAILED",
      "PINAX_JWT, SOURCE_MERCHANT_ADDRESS and SOURCE_TOKEN_ADDRESS are required.",
      503,
    );
  }

  const watchedPayers = (process.env.SOURCE_VICTIM_ADDRESSES ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const payerFilters = watchedPayers.length > 0 ? watchedPayers : [undefined];
  const transfers: TokenApiTransfer[] = [];
  for (const payer of payerFilters) {
    for (let page = 1; page <= 100; page += 1) {
      const parameters = new URLSearchParams({
        network,
        to_address: merchant,
        contract,
        start_time: new Date(from * 1000).toISOString(),
        end_time: new Date(to * 1000).toISOString(),
        limit: "10",
        page: String(page),
      });
      if (payer) parameters.set("from_address", payer);
      const response = await fetch(`${tokenApiEndpoint}/evm/transfers?${parameters}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      }).catch((error: unknown) => {
        throw new BitebackError(
          "GRAPH_QUERY_FAILED",
          `The Graph Token API is unavailable: ${String(error)}`,
          502,
        );
      });
      const body = (await response.json().catch(() => ({}))) as TokenApiResponse;
      if (!response.ok) {
        const detail =
          body.error?.detail ?? body.error?.message ?? body.message ?? response.statusText;
        throw new BitebackError(
          "GRAPH_QUERY_FAILED",
          `The Graph Token API returned ${response.status}: ${detail}`,
          502,
        );
      }
      const pageTransfers = body.data ?? [];
      transfers.push(...pageTransfers);
      if (pageTransfers.length < 10) break;
    }
  }

  const payments = transfers.map((transfer): Payment => ({
    id: `${transfer.transaction_id.toLowerCase()}-${transfer.log_index}`,
    txHash: transfer.transaction_id.toLowerCase(),
    logIndex: transfer.log_index,
    blockNumber: transfer.block_num,
    timestamp: transfer.timestamp,
    token: transfer.contract.toLowerCase(),
    payer: transfer.from.toLowerCase(),
    merchant: transfer.to.toLowerCase(),
    amount: transfer.amount,
  }));
  return {
    payments,
    source: {
      provider: "the-graph-token-api",
      endpoint: tokenApiEndpoint,
      network,
      indexedBlock: Math.max(0, ...payments.map(({ blockNumber }) => blockNumber)),
      queriedAt: new Date().toISOString(),
    },
  };
}

async function querySubstreams(from: number, to: number): Promise<GraphPayments> {
  const token = process.env.PINAX_JWT;
  const merchant = process.env.SOURCE_MERCHANT_ADDRESS?.toLowerCase();
  const contract = process.env.SOURCE_TOKEN_ADDRESS?.toLowerCase();
  const startBlock = Number(process.env.SOURCE_START_BLOCK);
  const stopBlock = Number(process.env.SOURCE_STOP_BLOCK);
  const endpoint =
    process.env.SOURCE_SUBSTREAMS_ENDPOINT ??
    "https://basesepolia.substreams.pinax.network";
  const packageUrl =
    process.env.SOURCE_SUBSTREAMS_PACKAGE ??
    "https://spkg.io/hashirpm/erc20-transfer-events-v0.1.2.spkg";
  const module = process.env.SOURCE_SUBSTREAMS_MODULE ?? "map_tranfers";
  if (
    !token ||
    !merchant ||
    !contract ||
    !Number.isSafeInteger(startBlock) ||
    !Number.isSafeInteger(stopBlock) ||
    stopBlock <= startBlock
  ) {
    throw new BitebackError(
      "GRAPH_QUERY_FAILED",
      "Substreams requires PINAX_JWT, source addresses and a valid SOURCE_START_BLOCK/SOURCE_STOP_BLOCK range.",
      503,
    );
  }

  const watched = new Set(
    (process.env.SOURCE_VICTIM_ADDRESSES ?? "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  );

  try {
    const substreamPackage = await fetchSubstream(packageUrl);
    const registry = createRegistry(substreamPackage);
    const transport = createConnectTransport({
      baseUrl: endpoint,
      httpVersion: "2",
      interceptors: [createAuthInterceptor(token) as never],
      useBinaryFormat: true,
      jsonOptions: { typeRegistry: registry as never },
    });
    const request = createRequest({
      substreamPackage,
      outputModule: module,
      productionMode: true,
      startBlockNum: BigInt(startBlock),
      stopBlockNum: BigInt(stopBlock),
    });
    const candidates: Array<Omit<Payment, "id" | "logIndex">> = [];
    for await (const response of streamBlocks(transport as never, request)) {
      const output = unpackMapOutput(response, registry);
      if (!output) continue;
      const body = output.toJson({ typeRegistry: registry }) as unknown as SubstreamsOutput;
      for (const transfer of body.transfers ?? []) {
        const tokenAddress = fromBase64Bytes(transfer.tokenAddr);
        const payer = fromBase64Bytes(transfer.from);
        const recipient = fromBase64Bytes(transfer.to);
        const timestamp = Number(transfer.blockTimestamp);
        if (
          tokenAddress !== contract ||
          recipient !== merchant ||
          (watched.size > 0 && !watched.has(payer)) ||
          timestamp < from ||
          timestamp > to
        ) {
          continue;
        }
        candidates.push({
          txHash: fromBase64Bytes(transfer.txnHash),
          blockNumber: Number(transfer.blockNumber),
          timestamp,
          token: tokenAddress,
          payer,
          merchant: recipient,
          amount: transfer.value,
        });
      }
    }

    const payments = await addLogIndexes(candidates);
    return {
      payments,
      source: {
        provider: "the-graph-substreams",
        endpoint,
        network: process.env.SOURCE_NETWORK ?? "base-sepolia",
        indexedBlock: stopBlock - 1,
        queriedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof BitebackError) throw error;
    throw new BitebackError(
      "GRAPH_QUERY_FAILED",
      `The Graph Substreams query failed: ${String(error)}`,
      502,
    );
  }
}

function fromBase64Bytes(value: string): string {
  return `0x${Buffer.from(value, "base64").toString("hex")}`.toLowerCase();
}

export async function verifySourcePayments(payments: Payment[]): Promise<void> {
  const unique = [...new Map(payments.map((payment) => [payment.id, payment])).values()];
  const verified = await addLogIndexes(
    unique.map(({ id: _id, logIndex: _logIndex, ...payment }) => payment),
  );
  const verifiedIds = new Set(verified.map(({ id }) => id));
  const missing = unique.find(({ id }) => !verifiedIds.has(id));
  if (missing) {
    throw new BitebackError(
      "SOURCE_PAYMENT_REORGED",
      `Payment ${missing.id} is no longer canonical on the source chain.`,
      409,
    );
  }

  const rpcUrl = process.env.SOURCE_RPC_URL ?? "https://sepolia.base.org";
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as RpcBlockNumberResponse;
  if (!response.ok || !body.result) {
    throw new BitebackError(
      "GRAPH_QUERY_FAILED",
      `Source-chain head unavailable: ${body.error?.message ?? response.statusText}`,
      502,
    );
  }
  const head = Number.parseInt(body.result, 16);
  const confirmations = Number(process.env.SOURCE_MIN_CONFIRMATIONS ?? "20");
  const newest = Math.max(...unique.map(({ blockNumber }) => blockNumber));
  if (
    !Number.isSafeInteger(head) ||
    !Number.isSafeInteger(confirmations) ||
    confirmations < 0 ||
    head - newest < confirmations
  ) {
    throw new BitebackError(
      "SOURCE_CONFIRMATIONS_INSUFFICIENT",
      `Source payments have ${Math.max(0, head - newest)} confirmations; ${confirmations} required.`,
      409,
    );
  }
}

async function addLogIndexes(
  candidates: Array<Omit<Payment, "id" | "logIndex">>,
): Promise<Payment[]> {
  const rpcUrl = process.env.SOURCE_RPC_URL ?? "https://sepolia.base.org";
  const receipts = new Map<string, RpcResponse["result"]>();
  const payments: Payment[] = [];
  for (const candidate of candidates) {
    let logs = receipts.get(candidate.txHash);
    if (!logs) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [candidate.txHash],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as RpcResponse;
      if (!response.ok || !body.result) {
        throw new BitebackError(
          "GRAPH_QUERY_FAILED",
          `Source-chain receipt unavailable for ${candidate.txHash}: ${body.error?.message ?? response.statusText}`,
          502,
        );
      }
      if (body.result.status === "0x0") {
        throw new BitebackError(
          "SOURCE_PAYMENT_REORGED",
          `Source transaction failed for ${candidate.txHash}.`,
          409,
        );
      }
      const receiptBlock = Number.parseInt(body.result.blockNumber, 16);
      if (receiptBlock !== candidate.blockNumber) {
        throw new BitebackError(
          "SOURCE_PAYMENT_REORGED",
          `Source transaction moved blocks for ${candidate.txHash}.`,
          409,
        );
      }
      logs = body.result;
      receipts.set(candidate.txHash, logs);
    }
    const payerTopic = `0x${candidate.payer.slice(2).padStart(64, "0")}`;
    const merchantTopic = `0x${candidate.merchant.slice(2).padStart(64, "0")}`;
    const position = logs.logs.findIndex(
      (log) =>
        log.address.toLowerCase() === candidate.token &&
        log.topics[0]?.toLowerCase() ===
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" &&
        log.topics[1]?.toLowerCase() === payerTopic &&
        log.topics[2]?.toLowerCase() === merchantTopic &&
        BigInt(log.data).toString() === candidate.amount,
    );
    if (position < 0) {
      throw new BitebackError(
        "GRAPH_QUERY_FAILED",
        `Transfer log mismatch for ${candidate.txHash}.`,
        502,
      );
    }
    const log = logs.logs.splice(position, 1)[0];
    if (!log) throw new BitebackError("GRAPH_QUERY_FAILED", "Transfer log disappeared.", 502);
    const logIndex = Number.parseInt(log.logIndex, 16);
    payments.push({
      ...candidate,
      id: `${candidate.txHash}-${logIndex}`,
      logIndex,
    });
  }
  return payments;
}
