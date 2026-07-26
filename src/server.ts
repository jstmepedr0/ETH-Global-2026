import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  Contract,
  JsonRpcProvider,
  NonceManager,
  Signature,
  Wallet,
  getAddress,
  hexlify,
  id as ethersId,
  randomBytes as ethersRandomBytes,
  verifyMessage,
} from "ethers";
import { z } from "zod";
import {
  BitebackError,
  RULE_ID,
  Store,
  detectPolicyViolations,
  disputeReportMessage,
  hash,
  ruleWithoutSignature,
  settlementDecisionMessage,
  transition,
  type Decision,
  type DisputeReport,
  type Incident,
  type Payout,
  type Rule,
  type SettlementAttempt,
} from "./domain.js";
import {
  createPayoutAttempt,
  executePayout,
  getBondStatus,
  mirrorAuditMessages,
  publishAudit,
  reconcilePayout,
} from "./hedera.js";
import { handleMcp } from "./mcp.js";
import { VictimFinder } from "./victimFinder.js";
import { verifyAndJoinClaim, type JoinClaimInput } from "./claims.js";
import { archiveEvidence, verifyArchivedEvidence } from "./evidence.js";
import { queryPayments, verifySourcePayments } from "./graph.js";
import { compilePolicy, ruleSignatureMessage } from "./policyCompiler.js";
import {
  AnomalyMonitor,
  anomalyMonitoringEnabled,
  anomalyWatchMessage,
} from "./anomalies.js";
import {
  ANOMALY_MODEL_INDEX,
  ANOMALY_RESEARCH_INDEX,
  readAnnualBenchmark,
} from "./anomalyBenchmark.js";

const store = new Store();
await store.load();
const victimFinder = new VictimFinder(store);
const anomalyMonitor = new AnomalyMonitor(store);
const app = new Hono();

const DEMO_PROVIDER = {
  name: "ByteMeter API",
  service: "Data enrichment API",
  product: "3-query pack",
  price: "0.001 test USDC",
  chargeUnits: "1000",
  explanation:
    "Each wallet buys one 3-query pack. The billing worker then retries the same fixed-price charge.",
} as const;

type LiveDemoStage =
  | "preparing"
  | "first-charges"
  | "retry-delay"
  | "second-charges"
  | "report"
  | "reporting"
  | "graph"
  | "claims"
  | "evidence"
  | "authorization"
  | "authorizing"
  | "refund"
  | "complete"
  | "failed";

interface LiveDemoCharge {
  wallet: string;
  label: string;
  sequence: 1 | 2;
  status: "queued" | "submitted" | "confirmed" | "indexed";
  txHash?: string;
  blockNumber?: number;
  submittedAt?: string;
  confirmedAt?: string;
}

interface LiveDemoRun {
  id: string;
  stage: LiveDemoStage;
  message: string;
  startedAt: string;
  updatedAt: string;
  provider: typeof DEMO_PROVIDER;
  charges: LiveDemoCharge[];
  base: {
    latestBlock?: number;
    firstChargeBlock?: number;
    requiredBlock?: number;
  };
  graph: {
    status: "idle" | "querying" | "indexed" | "failed";
    queryCount: number;
    transferCount: number;
    affectedWallets: number;
    indexedBlock?: number;
    queriedAt?: string;
    error?: string;
  };
  report?: DisputeReport;
  claimsAuthorized: number;
  incidentId?: string;
  evidence?: {
    rootHash: string;
    evidenceHash: string;
    verified: boolean;
  };
  payout?: Payout;
  error?: string;
}

let liveDemoRun: LiveDemoRun | undefined;
let liveDemoContext:
  | {
      id: string;
      victims: Array<{
        label: string;
        wallet: ReturnType<typeof Wallet.createRandom>;
        payoutAccountId: string;
      }>;
      windowStart: number;
      windowEnd: number;
    }
  | undefined;

function updateLiveDemo(
  id: string,
  patch: Partial<Omit<LiveDemoRun, "id" | "provider" | "startedAt">>,
): void {
  if (!liveDemoRun || liveDemoRun.id !== id) return;
  liveDemoRun = {
    ...liveDemoRun,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

async function localApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = process.env.OPERATOR_TOKEN;
  const port = process.env.PORT ?? "8403";
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `${path} returned ${response.status}.`);
  }
  return body;
}

async function resolveDisputeReport(
  txHash: string,
  signature: string,
): Promise<{ report: DisputeReport; rule: Rule; from: number; to: number }> {
  let reporter: string;
  try {
    reporter = getAddress(verifyMessage(disputeReportMessage(txHash), signature));
  } catch {
    throw new BitebackError("INVALID_REPORT_SIGNATURE", "The wallet report signature is invalid.", 401);
  }

  const provider = new JsonRpcProvider(
    process.env.SOURCE_RPC_URL ?? "https://sepolia.base.org",
  );
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) {
    throw new BitebackError("INVALID_REPORTED_PAYMENT", "The reported transaction is not confirmed.", 404);
  }
  const transferTopic = ethersId("Transfer(address,address,uint256)");
  const transfers = receipt.logs
    .filter(
      ({ topics }) =>
        topics.length >= 3 && topics[0]?.toLowerCase() === transferTopic.toLowerCase(),
    )
    .map((log) => ({
      token: log.address.toLowerCase(),
      payer: getAddress(`0x${log.topics[1]!.slice(-40)}`),
      merchant: getAddress(`0x${log.topics[2]!.slice(-40)}`),
    }))
    .filter(({ payer }) => payer === reporter);
  const rules = store.read().rules;
  const matched = transfers
    .map((transfer) => ({
      transfer,
      rule: rules.find(
        (rule) =>
          rule.token.toLowerCase() === transfer.token &&
          rule.merchant.toLowerCase() === transfer.merchant.toLowerCase(),
      ),
    }))
    .find(({ rule }) => Boolean(rule));
  if (!matched?.rule) {
    throw new BitebackError(
      "RULE_NOT_FOUND",
      "The reported payment does not match a compiled merchant policy.",
      404,
    );
  }
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) {
    throw new BitebackError("INVALID_REPORTED_PAYMENT", "The payment block was not found.", 404);
  }
  const bucket = Math.floor(block.timestamp / matched.rule.bucketSeconds);
  return {
    report: {
      version: 1,
      reporter: reporter.toLowerCase(),
      txHash: txHash.toLowerCase(),
      merchant: matched.transfer.merchant.toLowerCase(),
      token: matched.transfer.token,
      timestamp: block.timestamp,
      signature,
      signedAt: new Date().toISOString(),
    },
    rule: matched.rule,
    from: bucket * matched.rule.bucketSeconds,
    to: (bucket + 1) * matched.rule.bucketSeconds - 1,
  };
}

async function executeLiveDemo(id: string): Promise<void> {
  const rpcUrl = process.env.SOURCE_RPC_URL ?? "https://sepolia.base.org";
  const tokenAddress = process.env.SOURCE_TOKEN_ADDRESS;
  const merchantKey = process.env.SOURCE_MERCHANT_PRIVATE_KEY;
  const chainId = Number(process.env.SOURCE_CHAIN_ID ?? "84532");
  if (!tokenAddress || !merchantKey || !process.env.OPERATOR_TOKEN) {
    throw new Error("The live demo requires Base token, merchant and operator configuration.");
  }

  const baseProvider = new JsonRpcProvider(rpcUrl);
  const merchantWallet = new Wallet(merchantKey, baseProvider);
  const merchant = new NonceManager(merchantWallet);
  const token = new Contract(
    tokenAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
    ],
    merchant,
  );
  const victims = ["A", "B", "C"].map((label) => ({
    label,
    wallet: Wallet.createRandom(),
    payoutAccountId: process.env[`HEDERA_VICTIM_${label}_ACCOUNT_ID`],
  }));
  if (victims.some(({ payoutAccountId }) => !payoutAccountId)) {
    throw new Error("Three Hedera demo recipients must be configured.");
  }

  const chargeUnits = BigInt(DEMO_PROVIDER.chargeUnits);
  const requiredUnits = chargeUnits * 2n * BigInt(victims.length);
  const merchantBalance = (await token.balanceOf!(merchantWallet.address)) as bigint;
  if (merchantBalance < requiredUnits) {
    throw new Error("The ByteMeter billing wallet needs more Base Sepolia test USDC.");
  }

  liveDemoRun!.charges = victims.flatMap(({ label, wallet }) => [
    {
      wallet: wallet.address,
      label,
      sequence: 1 as const,
      status: "queued" as const,
    },
    {
      wallet: wallet.address,
      label,
      sequence: 2 as const,
      status: "queued" as const,
    },
  ]);
  updateLiveDemo(id, {
    stage: "preparing",
    message: "Funding three fresh customer wallets for this live run.",
  });

  await Promise.all(
    victims.map(async ({ wallet }) => {
      const transaction = await token.transfer!(wallet.address, chargeUnits * 2n);
      await transaction.wait();
    }),
  );

  const domain = {
    name: "USDC",
    version: "2",
    chainId,
    verifyingContract: tokenAddress,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const validBefore = Math.floor(Date.now() / 1000) + 3600;

  const submitCharge = async (
    victim: (typeof victims)[number],
    sequence: 1 | 2,
  ): Promise<void> => {
    const message = {
      from: victim.wallet.address,
      to: merchantWallet.address,
      value: chargeUnits,
      validAfter: 0,
      validBefore,
      nonce: hexlify(ethersRandomBytes(32)),
    };
    const signature = Signature.from(
      await victim.wallet.signTypedData(domain, types, message),
    );
    const transaction = await token.transferWithAuthorization!(
      message.from,
      message.to,
      message.value,
      message.validAfter,
      message.validBefore,
      message.nonce,
      signature.v,
      signature.r,
      signature.s,
    );
    if (!liveDemoRun || liveDemoRun.id !== id) return;
    const submittedAt = new Date().toISOString();
    liveDemoRun.charges = liveDemoRun.charges.map((charge) =>
      charge.label === victim.label && charge.sequence === sequence
        ? { ...charge, status: "submitted", txHash: transaction.hash, submittedAt }
        : charge,
    );
    updateLiveDemo(id, {});
    const receipt = await transaction.wait();
    if (!receipt || !liveDemoRun || liveDemoRun.id !== id) return;
    liveDemoRun.charges = liveDemoRun.charges.map((charge) =>
      charge.label === victim.label && charge.sequence === sequence
        ? {
            ...charge,
            status: "confirmed",
            blockNumber: receipt.blockNumber,
            confirmedAt: new Date().toISOString(),
          }
        : charge,
    );
    updateLiveDemo(id, {});
  };

  updateLiveDemo(id, {
    stage: "first-charges",
    message: "ByteMeter is charging each wallet for one 3-query pack.",
  });
  await Promise.all(victims.map((victim) => submitCharge(victim, 1)));

  updateLiveDemo(id, {
    stage: "retry-delay",
    message: "The first packs are confirmed. Billing retry starts in four seconds.",
  });
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  updateLiveDemo(id, {
    stage: "second-charges",
    message: "The billing worker is submitting a second equal charge.",
  });
  await Promise.all(victims.map((victim) => submitCharge(victim, 2)));

  const confirmedBlocks = liveDemoRun!.charges
    .map(({ blockNumber }) => blockNumber)
    .filter((block): block is number => block !== undefined);
  const firstBlock = Math.min(...confirmedBlocks);
  const requiredBlock = Math.max(...confirmedBlocks);
  const [firstBlockData, lastBlockData, latestBlock] = await Promise.all([
    baseProvider.getBlock(firstBlock),
    baseProvider.getBlock(requiredBlock),
    baseProvider.getBlockNumber(),
  ]);
  const windowStart = (firstBlockData?.timestamp ?? Math.floor(Date.now() / 1000)) - 15;
  const windowEnd = (lastBlockData?.timestamp ?? Math.floor(Date.now() / 1000)) + 30;
  process.env.SOURCE_VICTIM_ADDRESSES = "";
  process.env.SOURCE_WINDOW_START = String(windowStart);
  process.env.SOURCE_WINDOW_END = String(windowEnd);
  process.env.SOURCE_START_BLOCK = String(firstBlock);
  process.env.SOURCE_STOP_BLOCK = String(requiredBlock + 1);

  liveDemoContext = {
    id,
    victims: victims.map(({ label, wallet, payoutAccountId }) => ({
      label,
      wallet,
      payoutAccountId: payoutAccountId!,
    })),
    windowStart,
    windowEnd,
  };
  updateLiveDemo(id, {
    stage: "report",
    message: "Six charges exist on Base. Wallet A must report one before BITEBACK scans.",
    base: { latestBlock, firstChargeBlock: firstBlock, requiredBlock },
    graph: {
      status: "idle",
      queryCount: 0,
      transferCount: 0,
      affectedWallets: 0,
    },
  });
}

async function continueLiveDemoAfterReport(id: string): Promise<void> {
  const context = liveDemoContext;
  const run = liveDemoRun;
  if (!context || context.id !== id || !run || run.id !== id || run.stage !== "reporting") {
    throw new BitebackError("INVALID_REQUEST", "The live run is not awaiting a report.", 409);
  }
  const reporter = context.victims[0]!;
  const reportedCharge = run.charges.find(
    ({ label, sequence }) => label === reporter.label && sequence === 2,
  );
  if (!reportedCharge?.txHash) {
    throw new BitebackError("INVALID_REQUEST", "Wallet A has no confirmed charge to report.", 409);
  }
  const signature = await reporter.wallet.signMessage(
    disputeReportMessage(reportedCharge.txHash),
  );
  const verifiedReport = await resolveDisputeReport(reportedCharge.txHash, signature);

  const rule = await victimFinder.ensureRule();
  updateLiveDemo(id, {
    stage: "graph",
    message: "Wallet A's signed report is verified. The Graph is searching for every match.",
    report: verifiedReport.report,
    graph: {
      status: "querying",
      queryCount: 0,
      transferCount: 0,
      affectedWallets: 0,
    },
  });
  let scan:
    | {
        incident: Incident;
        report: DisputeReport;
        verification: LiveDemoRun["graph"] & { provider?: string; network?: string };
      }
    | undefined;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      liveDemoRun!.graph = {
        ...liveDemoRun!.graph,
        status: "querying",
        queryCount: attempt,
      };
      updateLiveDemo(id, {});
      const result = await queryPayments(context.windowStart, context.windowEnd);
      const payments = result.payments;
      const violations = detectPolicyViolations(rule, payments);
      liveDemoRun!.graph = {
        status: payments.length >= 6 ? "indexed" : "querying",
        queryCount: attempt,
        transferCount: payments.length,
        affectedWallets: violations.length,
        indexedBlock: result.source.indexedBlock,
        queriedAt: result.source.queriedAt,
      };
      liveDemoRun!.charges = liveDemoRun!.charges.map((charge) =>
        payments.some(({ txHash }) => txHash === charge.txHash?.toLowerCase())
          ? { ...charge, status: "indexed" }
          : charge,
      );
      updateLiveDemo(id, {});
      if (payments.length >= 6 && violations.length === 3) {
        scan = await localApi("/api/report", {
          method: "POST",
          body: JSON.stringify({ txHash: reportedCharge.txHash, signature }),
        });
        break;
      }
    } catch (error) {
      liveDemoRun!.graph = {
        ...liveDemoRun!.graph,
        status: "failed",
        queryCount: attempt,
        error: error instanceof Error ? error.message : String(error),
      };
      updateLiveDemo(id, {});
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!scan) throw new Error("The Graph did not index all six charges in time.");

  updateLiveDemo(id, {
    stage: "claims",
    message: "One reporter became three affected wallets. They are authorizing recipients.",
    report: scan.report,
    incidentId: scan.incident.id,
    claimsAuthorized: 0,
  });

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  for (const victim of context.victims) {
    const nonce = cryptoRandomBytes(16).toString("hex");
    const payoutAccountId = victim.payoutAccountId!;
    const delegation = [
      "BITEBACK_DELEGATION_V1",
      `incidentId=${scan.incident.id}`,
      `victim=${victim.wallet.address.toLowerCase()}`,
      `payout=${payoutAccountId}`,
      `nonce=${nonce}`,
      `expiresAt=${expiresAt}`,
    ].join("\n");
    await localApi(`/api/incidents/${scan.incident.id}/join`, {
      method: "POST",
      body: JSON.stringify({
        victim: victim.wallet.address,
        payoutAccountId,
        nonce,
        expiresAt,
        signature: await victim.wallet.signMessage(delegation),
      }),
    });
    updateLiveDemo(id, {
      claimsAuthorized: liveDemoRun!.claimsAuthorized + 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  updateLiveDemo(id, {
    stage: "evidence",
    message: "Uploading the canonical Evidence Pack to 0G Storage.",
  });
  const frozen = await localApi<{
    rootHash: string;
    evidenceHash: string;
  }>(`/api/incidents/${scan.incident.id}/freeze`, {
    method: "POST",
    body: "{}",
  });
  const evidence = await localApi<{ verified: boolean }>(
    `/api/incidents/${scan.incident.id}/evidence`,
  );
  updateLiveDemo(id, {
    evidence: {
      rootHash: frozen.rootHash,
      evidenceHash: frozen.evidenceHash,
      verified: evidence.verified === true,
    },
  });

  updateLiveDemo(id, {
    stage: "authorization",
    message: "Evidence ready. ByteMeter must explicitly authorize this settlement.",
  });
}

async function authorizeLiveDemoSettlement(id: string): Promise<void> {
  const run = liveDemoRun;
  if (
    !run ||
    run.id !== id ||
    !["authorization", "authorizing"].includes(run.stage) ||
    !run.incidentId
  ) {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      "The live incident is not awaiting merchant authorization.",
      409,
    );
  }
  const incident = await localApi<Incident>(`/api/incidents/${run.incidentId}`);
  const nonce = cryptoRandomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const merchantKey = process.env.SOURCE_MERCHANT_PRIVATE_KEY;
  if (!merchantKey) throw new Error("SOURCE_MERCHANT_PRIVATE_KEY is required.");
  const merchant = new Wallet(merchantKey);
  const signature = await merchant.signMessage(
    settlementDecisionMessage(
      incident.id,
      incident.evidenceHash,
      "ACCEPT",
      incident.evidence.totals.payoutTinybar,
      nonce,
      expiresAt,
    ),
  );
  await localApi(`/api/incidents/${incident.id}/decision`, {
    method: "POST",
    body: JSON.stringify({
      decision: "ACCEPT",
      evidenceHash: incident.evidenceHash,
      nonce,
      expiresAt,
      signature,
    }),
  });
  updateLiveDemo(id, {
    stage: "refund",
    message: "Merchant authorization verified. Hedera is executing one atomic payout.",
  });
  const { payout } = await localApi<{ payout: Payout }>(
    `/api/incidents/${incident.id}/settle`,
    { method: "POST", body: "{}" },
  );
  updateLiveDemo(id, {
    stage: "complete",
    message: "Merchant-authorized settlement completed successfully.",
    payout,
  });
}

function errorResponse(error: unknown): {
  body: { error: { code: string; message: string } };
  status: number;
} {
  if (error instanceof BitebackError) {
    return {
      body: { error: { code: error.code, message: error.message } },
      status: error.status,
    };
  }
  console.error(error);
  return {
    body: { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } },
    status: 500,
  };
}

async function jsonInput<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 32_768) {
    throw new BitebackError("INVALID_REQUEST", "Request body exceeds 32 KiB.", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 32_768) {
    throw new BitebackError("INVALID_REQUEST", "Request body exceeds 32 KiB.", 413);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // The schema below returns the same stable INVALID_REQUEST envelope.
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BitebackError("INVALID_REQUEST", z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function requireOperator(authorization: string | undefined): void {
  const token = process.env.OPERATOR_TOKEN;
  if (!token) {
    throw new BitebackError(
      "OPERATOR_AUTH_NOT_CONFIGURED",
      "OPERATOR_TOKEN must be configured before mutating the service.",
      503,
    );
  }
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    throw new BitebackError("UNAUTHORIZED", "Operator token is invalid.", 401);
  }
}

function getIncident(database: ReturnType<Store["read"]>, id: string): Incident {
  const incident = database.incidents.find((candidate) => candidate.id === id);
  if (!incident) throw new BitebackError("VICTIM_NOT_IN_INCIDENT", "Incident not found.", 404);
  return incident;
}

async function publishPayoutAudit(incidentId: string, payout: Payout): Promise<void> {
  try {
    await publishAudit(
      store,
      "PAYOUT_SUBMITTED",
      "settlement-agent",
      {
        recipients: payout.recipients,
        totalTinybar: payout.totalTinybar,
        merchantAuthorized: true,
      },
      {
        dedupeKey: `payout:${incidentId}:submitted`,
        incidentId,
        hederaTransactionId: payout.transactionId,
      },
    );
    await publishAudit(
      store,
      "PAYOUT_CONFIRMED",
      "settlement-agent",
      { receiptStatus: "SUCCESS", totalTinybar: payout.totalTinybar },
      {
        dedupeKey: `payout:${incidentId}:confirmed`,
        incidentId,
        hederaTransactionId: payout.transactionId,
      },
    );
    await store.update((database) => {
      const incident = getIncident(database, incidentId);
      if (incident.payout) delete incident.payout.auditPending;
    });
  } catch {
    await store.update((database) => {
      const incident = getIncident(database, incidentId);
      if (incident.payout) incident.payout.auditPending = true;
    });
  }
}

async function finalizePayout(
  incidentId: string,
  payout: Payout,
  excessPaymentIds: string[],
): Promise<Payout> {
  await store.update((database) => {
    const incident = getIncident(database, incidentId);
    if (!incident.payout) {
      incident.payout = payout;
      delete incident.settlementAttempt;
      if (incident.status === "SETTLEMENT_FAILED") transition(incident, "SETTLING");
      if (incident.status === "SETTLING") transition(incident, "SETTLED");
      for (const paymentId of excessPaymentIds) {
        if (!database.settledPaymentIds.includes(paymentId)) {
          database.settledPaymentIds.push(paymentId);
        }
      }
    }
  });
  await publishPayoutAudit(incidentId, payout);
  return getIncident(store.read(), incidentId).payout ?? payout;
}

async function executeSettlementAttempt(
  incidentId: string,
  attempt: SettlementAttempt,
  excessPaymentIds: string[],
): Promise<Payout> {
  await publishAudit(
    store,
    "PAYOUT_SUBMITTED",
    "settlement-agent",
    {
      recipients: attempt.recipients,
      totalTinybar: attempt.totalTinybar,
      merchantAuthorized: true,
    },
    {
      dedupeKey: `payout:${incidentId}:submitted`,
      incidentId,
      hederaTransactionId: attempt.transactionId,
    },
  );
  try {
    return await finalizePayout(
      incidentId,
      await executePayout(attempt, incidentId),
      excessPaymentIds,
    );
  } catch (error) {
    const reconciliation = await reconcilePayout(attempt);
    if (reconciliation.status === "SUCCESS") {
      return finalizePayout(incidentId, reconciliation.payout, excessPaymentIds);
    }
    if (reconciliation.status === "FAILED") {
      await store.update((database) => {
        const incident = getIncident(database, incidentId);
        delete incident.settlementAttempt;
        if (incident.status === "SETTLING") transition(incident, "SETTLEMENT_FAILED");
      });
      throw error;
    }
    throw new BitebackError(
      "SETTLEMENT_RECONCILIATION_PENDING",
      `Hedera transaction ${attempt.transactionId} has an unknown outcome; no replacement will be created.`,
      409,
    );
  }
}

async function settleIncident(incidentId: string): Promise<Payout> {
  let current = getIncident(store.read(), incidentId);
  if (current.payout) {
    if (current.payout.auditPending) {
      await publishPayoutAudit(incidentId, current.payout);
    }
    return getIncident(store.read(), incidentId).payout ?? current.payout;
  }

  const excessPaymentIds = current.violations.flatMap(({ excessCharges }) =>
    excessCharges.map(({ id }) => id),
  );
  if (current.settlementAttempt) {
    const reconciliation = await reconcilePayout(current.settlementAttempt);
    if (reconciliation.status === "SUCCESS") {
      return finalizePayout(incidentId, reconciliation.payout, excessPaymentIds);
    }
    if (reconciliation.status === "PENDING") {
      const ageSeconds =
        (Date.now() - Date.parse(current.settlementAttempt.createdAt)) / 1000;
      if (ageSeconds <= 120) {
        return executeSettlementAttempt(
          incidentId,
          current.settlementAttempt,
          excessPaymentIds,
        );
      }
      throw new BitebackError(
        "SETTLEMENT_RECONCILIATION_PENDING",
        `Hedera transaction ${current.settlementAttempt.transactionId} remains unresolved.`,
        409,
      );
    }
    await store.update((database) => {
      const incident = getIncident(database, incidentId);
      delete incident.settlementAttempt;
      if (incident.status === "SETTLING") transition(incident, "SETTLEMENT_FAILED");
    });
    current = getIncident(store.read(), incidentId);
  }

  if (current.status !== "APPROVED" && current.status !== "SETTLEMENT_FAILED") {
    throw new BitebackError(
      "MERCHANT_APPROVAL_REQUIRED",
      "The merchant must explicitly accept the frozen settlement before payout.",
      409,
    );
  }
  const decision = current.decision;
  if (
    !decision ||
    decision.decision !== "ACCEPT" ||
    decision.evidenceHash !== current.evidenceHash ||
    decision.totalTinybar !== current.evidence.totals.payoutTinybar
  ) {
    throw new BitebackError(
      "MERCHANT_APPROVAL_REQUIRED",
      "The merchant authorization does not match this evidence and payout total.",
      409,
    );
  }
  let recoveredDecisionSigner: string;
  try {
    recoveredDecisionSigner = verifyMessage(
      settlementDecisionMessage(
        current.id,
        decision.evidenceHash,
        decision.decision,
        decision.totalTinybar,
        decision.nonce,
        decision.expiresAt,
      ),
      decision.signature,
    );
  } catch {
    throw new BitebackError(
      "INVALID_MERCHANT_SIGNATURE",
      "The stored settlement authorization is invalid.",
      409,
    );
  }
  const expectedSigner = process.env.SOURCE_MERCHANT_SIGNER;
  if (
    !expectedSigner ||
    getAddress(recoveredDecisionSigner) !== getAddress(decision.signer) ||
    getAddress(recoveredDecisionSigner) !== getAddress(expectedSigner)
  ) {
    throw new BitebackError(
      "INVALID_MERCHANT_SIGNATURE",
      "The stored settlement authorization is not from the allowlisted merchant.",
      409,
    );
  }
  if (hash(current.evidence) !== current.evidenceHash) {
    throw new BitebackError("EVIDENCE_HASH_MISMATCH", "The evidence changed after freezing.", 409);
  }

  const { hash: frozenRuleHash, ...frozenRuleFields } = current.evidence.rule;
  const frozenRule = frozenRuleFields as Rule;
  if (hash(ruleWithoutSignature(frozenRule)) !== frozenRuleHash) {
    throw new BitebackError(
      "EVIDENCE_HASH_MISMATCH",
      "The frozen rule does not match its compiled hash.",
      409,
    );
  }

  const sourcePayments = current.evidence.victims.flatMap((victim) => [
    ...(victim.withinPolicyPayments ?? [victim.withinPolicy]),
    ...victim.excessCharges,
  ]);
  await verifySourcePayments(sourcePayments);
  const recalculated = detectPolicyViolations(frozenRule, sourcePayments);
  const violationSummary = (violations: typeof recalculated) =>
    violations.map(({ id, victim, payoutTinybar, excessCharges }) => ({
      id,
      victim,
      payoutTinybar,
      excessPaymentIds: excessCharges.map(({ id: paymentId }) => paymentId).sort(),
    }));
  if (hash(violationSummary(recalculated)) !== hash(violationSummary(current.violations))) {
    throw new BitebackError(
      "EVIDENCE_HASH_MISMATCH",
      "The frozen violations no longer recalculate to the same result.",
      409,
    );
  }
  if (!current.evidenceRootHash) {
    throw new BitebackError(
      "EVIDENCE_STORAGE_FAILED",
      "Settlement requires evidence archived in 0G Storage.",
      409,
    );
  }
  const verification = await verifyArchivedEvidence(
    current.evidenceRootHash,
    current.evidenceHash,
  );
  if (!verification.ok) {
    throw new BitebackError(
      "EVIDENCE_HASH_MISMATCH",
      "The 0G Storage bytes no longer match the frozen evidence.",
      409,
    );
  }

  const recipients = current.claims.map((claim) => {
    const violation = recalculated.find(({ victim }) => victim === claim.victim);
    if (!violation) {
      throw new BitebackError("VICTIM_NOT_IN_INCIDENT", "Claim wallet disappeared.", 409);
    }
    return { accountId: claim.payoutAccountId, tinybar: violation.payoutTinybar };
  });
  if (recipients.length !== recalculated.length) {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      "Every affected wallet must have exactly one claim.",
      409,
    );
  }
  const total = recipients
    .reduce((sum, item) => sum + BigInt(item.tinybar), 0n)
    .toString();
  if (total !== current.evidence.totals.payoutTinybar) {
    throw new BitebackError("EVIDENCE_HASH_MISMATCH", "The payout total changed.", 409);
  }
  const database = store.read();
  const replay = excessPaymentIds.find((id) => database.settledPaymentIds.includes(id));
  if (replay) {
    throw new BitebackError(
      "PAYOUT_ALREADY_EXECUTED",
      `Payment ${replay} has already funded a settlement.`,
      409,
    );
  }
  const bond = await getBondStatus();
  if (BigInt(bond.allowanceTinybar) < BigInt(total)) {
    throw new BitebackError("ALLOWANCE_INSUFFICIENT", "Allowance no longer covers the payout.", 409);
  }
  if (BigInt(bond.balanceTinybar) < BigInt(total)) {
    throw new BitebackError("BOND_INSUFFICIENT", "Bond no longer covers the payout.", 409);
  }

  const attempt = createPayoutAttempt(recipients);
  await store.update((database) => {
    const incident = getIncident(database, incidentId);
    if (incident.payout) return;
    const duplicate = excessPaymentIds.find((id) => database.settledPaymentIds.includes(id));
    if (duplicate) {
      throw new BitebackError(
        "PAYOUT_ALREADY_EXECUTED",
        `Payment ${duplicate} has already funded a settlement.`,
        409,
      );
    }
    transition(incident, "SETTLING");
    incident.settlementAttempt = attempt;
  });
  return executeSettlementAttempt(incidentId, attempt, excessPaymentIds);
}

app.onError((error, context) => {
  const response = errorResponse(error);
  return context.json(response.body, response.status as 400);
});

app.get("/api/health", (context) => {
  const anomalyHeartbeat = anomalyMonitor.heartbeat();
  return context.json({
    ok: true,
    service: "BITEBACK",
    version: "1.0.0",
    integrations: {
      graph: Boolean(process.env.PINAX_JWT),
      zerog: Boolean(process.env.OG_ROUTER_BASE && process.env.OG_ROUTER_KEY),
      hedera: Boolean(process.env.HEDERA_BOND_ACCOUNT_ID && process.env.HCS_TOPIC_ID),
      anomalies: anomalyMonitoringEnabled(),
      anomalyHeartbeat: anomalyHeartbeat.status,
    },
    operatorAuth: Boolean(process.env.OPERATOR_TOKEN),
  });
});

app.get("/api/config", async (context) => {
  const rule = await victimFinder.ensureRule();
  return context.json({
    rule,
    ruleHash: hash(ruleWithoutSignature(rule)),
    demoProvider: DEMO_PROVIDER,
    hcsTopicId: process.env.HCS_TOPIC_ID ?? null,
    sourceNetwork: process.env.SOURCE_NETWORK ?? "base-sepolia",
    sourceExplorerUrl:
      process.env.SOURCE_EXPLORER_URL ?? "https://sepolia.basescan.org",
    hashscanTopicUrl: process.env.HCS_TOPIC_ID
      ? `https://hashscan.io/testnet/topic/${process.env.HCS_TOPIC_ID}`
      : null,
    mcpUrl: `${new URL(context.req.url).origin}/mcp`,
    runtime: process.env.VERCEL ? "Vercel" : "Local",
    operatorAuth: Boolean(process.env.OPERATOR_TOKEN),
    demoReady: Boolean(
      process.env.OPERATOR_TOKEN &&
        process.env.SOURCE_MERCHANT_PRIVATE_KEY &&
        process.env.SOURCE_TOKEN_ADDRESS &&
        process.env.PINAX_JWT &&
        process.env.HEDERA_BOND_ACCOUNT_ID &&
        process.env.HEDERA_SETTLEMENT_ACCOUNT_ID &&
        process.env.HCS_TOPIC_ID &&
        process.env.OG_ROUTER_KEY,
    ),
  });
});

app.get("/api/bond", async (context) => {
  if (
    process.env.VERCEL &&
    (!process.env.HEDERA_BOND_ACCOUNT_ID ||
      !process.env.HEDERA_SETTLEMENT_ACCOUNT_ID)
  ) {
    return context.json({
      accountId: "not configured",
      spenderAccountId: "not configured",
      balanceTinybar: "0",
      allowanceTinybar: "0",
      protected: false,
      checkedAt: new Date().toISOString(),
    });
  }
  return context.json(await getBondStatus());
});

app.get("/api/anomaly/chains", (context) =>
  context.json(anomalyMonitor.chainStates()),
);

app.get("/api/anomaly/heartbeat", (context) =>
  context.json(anomalyMonitor.heartbeat()),
);

app.get("/api/anomaly/benchmark", async (context) => {
  const benchmark = await readAnnualBenchmark();
  return benchmark
    ? context.json(benchmark)
    : context.json(
        {
          available: false,
          error:
            "Annual benchmark artifact unavailable. Run npm run anomaly:benchmark with Substreams credentials.",
        },
        404,
      );
});

app.get("/api/anomaly/research", async (context) => {
  const benchmark = await readAnnualBenchmark();
  return context.json({
    sources: ANOMALY_RESEARCH_INDEX,
    models: ANOMALY_MODEL_INDEX,
    benchmarkAvailable: Boolean(benchmark),
    evaluation: {
      mode: "prequential streaming",
      primaryView: "precision-recall",
      pointAdjustment: false,
      latency: "first alert inside each official incident window",
      falsePositiveReporting:
        "unmatched episodes reported separately from confirmed false positives",
    },
  });
});

app.get("/api/anomaly/chains/:id/metrics", (context) => {
  const parsed = z
    .object({
      from: z.coerce.number().int().nonnegative().optional(),
      to: z.coerce.number().int().nonnegative().optional(),
    })
    .safeParse(context.req.query());
  if (!parsed.success) {
    throw new BitebackError("INVALID_REQUEST", z.prettifyError(parsed.error));
  }
  return context.json(
    anomalyMonitor.metrics(
      context.req.param("id"),
      parsed.data.from,
      parsed.data.to,
    ),
  );
});

app.get("/api/anomalies", (context) => {
  const parsed = z
    .object({
      chainId: z.string().optional(),
      status: z.enum(["open", "acknowledged", "resolved"]).optional(),
      severity: z.enum(["warning", "critical"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .safeParse(context.req.query());
  if (!parsed.success) {
    throw new BitebackError("INVALID_REQUEST", z.prettifyError(parsed.error));
  }
  return context.json({ alerts: anomalyMonitor.alerts(parsed.data) });
});

app.get("/api/anomalies/:id", (context) => {
  const id = context.req.param("id");
  return context.json({
    ...anomalyMonitor.alert(id),
    assessment: anomalyMonitor.assessment(id),
    disputeReadiness: anomalyMonitor.disputeReadiness(
      id,
      context.req.query("wallet"),
    ),
  });
});

app.post("/api/anomaly/wallets/watch", async (context) => {
  const input = await jsonInput(
    context.req.raw,
    z.object({
      wallet: z.string(),
      chainId: z.string(),
      signature: z.string().min(130).max(132),
    }),
  );
  let wallet: string;
  let signer: string;
  try {
    wallet = getAddress(input.wallet);
    signer = getAddress(
      verifyMessage(
        anomalyWatchMessage(wallet, input.chainId),
        input.signature,
      ),
    );
  } catch {
    throw new BitebackError(
      "ANOMALY_WATCH_SIGNATURE_INVALID",
      "The wallet watch signature is invalid.",
      401,
    );
  }
  if (wallet !== signer) {
    throw new BitebackError(
      "ANOMALY_WATCH_SIGNATURE_INVALID",
      "The wallet watch signature does not match the wallet.",
      401,
    );
  }
  return context.json(
    {
      watch: await anomalyMonitor.watchWallet(wallet, input.chainId),
    },
    201,
  );
});

app.get("/api/anomaly/wallets/:address/notifications", (context) => {
  let wallet: string;
  try {
    wallet = getAddress(context.req.param("address"));
  } catch {
    throw new BitebackError("INVALID_REQUEST", "Wallet address is invalid.");
  }
  const parsed = z
    .object({
      chainId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .safeParse(context.req.query());
  if (!parsed.success) {
    throw new BitebackError("INVALID_REQUEST", z.prettifyError(parsed.error));
  }
  return context.json({
    notifications: anomalyMonitor.walletNotifications(
      wallet,
      parsed.data.chainId,
      parsed.data.limit,
    ),
  });
});

app.get("/api/anomalies/:id/dispute-readiness", (context) =>
  context.json(
    anomalyMonitor.disputeReadiness(
      context.req.param("id"),
      context.req.query("wallet"),
    ),
  ),
);

app.post("/api/anomalies/run", async (context) => {
  requireOperator(context.req.header("authorization"));
  const input = await jsonInput(
    context.req.raw,
    z.object({ chainId: z.string().optional() }),
  );
  const state = anomalyMonitor.chainStates();
  if (
    input.chainId &&
    !state.chains.some(({ id }) => id === input.chainId)
  ) {
    throw new BitebackError("ANOMALY_CHAIN_NOT_FOUND", "Chain not found.", 404);
  }
  void anomalyMonitor.run(input.chainId).catch((error: unknown) => {
    console.error("Anomaly monitor run failed:", error);
  });
  return context.json(state, 202);
});

app.post("/api/anomalies/:id/acknowledge", async (context) => {
  requireOperator(context.req.header("authorization"));
  const input = await jsonInput(
    context.req.raw,
    z.object({ note: z.string().trim().min(1).max(500).optional() }),
  );
  return context.json(
    await anomalyMonitor.acknowledge(context.req.param("id"), input.note),
  );
});

app.post("/api/anomalies/:id/resolve", async (context) => {
  requireOperator(context.req.header("authorization"));
  const input = await jsonInput(
    context.req.raw,
    z.object({
      classification: z.enum(["expected", "confirmed"]),
      note: z.string().trim().min(1).max(500),
    }),
  );
  return context.json(
    await anomalyMonitor.resolve(
      context.req.param("id"),
      input.classification,
      input.note,
    ),
  );
});

app.get("/api/demo/live", (context) =>
  context.json({
    run: liveDemoRun ?? null,
    provider: DEMO_PROVIDER,
  }),
);

app.post("/api/demo/live", async (context) => {
  requireOperator(context.req.header("authorization"));
  if (
    liveDemoRun &&
    !["complete", "failed"].includes(liveDemoRun.stage)
  ) {
    throw new BitebackError("DEMO_ALREADY_RUNNING", "A live demo is already running.", 409);
  }
  const id = cryptoRandomBytes(6).toString("hex");
  liveDemoContext = undefined;
  liveDemoRun = {
    id,
    stage: "preparing",
    message: "Preparing a fresh ByteMeter API purchase.",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider: DEMO_PROVIDER,
    charges: [],
    base: {},
    graph: {
      status: "idle",
      queryCount: 0,
      transferCount: 0,
      affectedWallets: 0,
    },
    claimsAuthorized: 0,
  };
  void executeLiveDemo(id).catch((error: unknown) => {
    updateLiveDemo(id, {
      stage: "failed",
      message: "Live demo failed.",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return context.json({ run: liveDemoRun }, 202);
});

app.post("/api/demo/live/report", async (context) => {
  requireOperator(context.req.header("authorization"));
  if (!liveDemoRun || liveDemoRun.stage !== "report") {
    throw new BitebackError("INVALID_REQUEST", "The live run is not awaiting Wallet A's report.", 409);
  }
  const id = liveDemoRun.id;
  updateLiveDemo(id, {
    stage: "reporting",
    message: "Wallet A is signing the reported transaction hash.",
  });
  void continueLiveDemoAfterReport(id).catch((error: unknown) => {
    updateLiveDemo(id, {
      stage: "failed",
      message: "The signed wallet report could not open a dispute.",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return context.json({ run: liveDemoRun }, 202);
});

app.post("/api/demo/live/authorize", async (context) => {
  requireOperator(context.req.header("authorization"));
  if (!liveDemoRun || liveDemoRun.stage !== "authorization") {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      "The live incident is not awaiting merchant authorization.",
      409,
    );
  }
  const id = liveDemoRun.id;
  updateLiveDemo(id, {
    stage: "authorizing",
    message: "Verifying ByteMeter's signed settlement authorization.",
  });
  void authorizeLiveDemoSettlement(id).catch((error: unknown) => {
    updateLiveDemo(id, {
      stage: "failed",
      message: "Merchant-authorized settlement failed.",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return context.json({ run: liveDemoRun }, 202);
});

/** 0G Compute compila os termos publicados numa regra candidata. */
app.post("/api/rules/compile", async (context) => {
  requireOperator(context.req.header("authorization"));
  const { terms } = await jsonInput(
    context.req.raw,
    z.object({ terms: z.string().min(10).max(4000) }),
  );
  const compiled = await compilePolicy(terms);
  const rule = await victimFinder.ensureRule();
  const candidate = {
    ...ruleWithoutSignature(rule),
    ...compiled.rule,
    compiledBy: "0g-compute" as const,
    compilation: {
      provider: "0g-compute" as const,
      model: compiled.model,
      endpoint: compiled.endpoint,
      termsHash: hash(terms.trim()),
      outputHash: hash(compiled.raw),
      compiledAt: new Date().toISOString(),
    },
  };
  const ruleHash = hash(candidate);
  await store.update((database) => {
    const activeIndex = database.rules.findIndex(({ id }) => id === candidate.id);
    if (activeIndex === -1) database.rules.push(candidate);
    else database.rules[activeIndex] = candidate;
    database.pendingRules = database.pendingRules.filter(
      (pending) => pending.candidate.id !== candidate.id,
    );
    database.pendingRules.push({
      ruleHash,
      candidate,
      createdAt: new Date().toISOString(),
    });
  });
  return context.json({
    candidate,
    ruleHash,
    signatureMessage: ruleSignatureMessage(rule.id, ruleHash),
    model: compiled.model,
    endpoint: compiled.endpoint,
    raw: compiled.raw,
  });
});

/** Assinatura opcional da política; não substitui a decisão sobre um incidente. */
app.post("/api/rules/sign", async (context) => {
  requireOperator(context.req.header("authorization"));
  const input = await jsonInput(
    context.req.raw,
    z.object({
      ruleHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      signature: z.string().min(130).max(132),
    }),
  );
  const database = store.read();
  const pending = database.pendingRules.find(({ ruleHash }) => ruleHash === input.ruleHash);
  const active = database.rules.find(
    (rule) => hash(ruleWithoutSignature(rule)) === input.ruleHash,
  );
  const candidate = pending?.candidate ?? (active ? ruleWithoutSignature(active) : undefined);
  if (!candidate || hash(candidate) !== input.ruleHash) {
    throw new BitebackError(
      "INVALID_RULE_SIGNATURE",
      "The signed candidate was not produced by the Policy Compiler.",
      409,
    );
  }
  let signer: string;
  try {
    signer = verifyMessage(
      ruleSignatureMessage(candidate.id, input.ruleHash),
      input.signature,
    );
  } catch {
    throw new BitebackError("INVALID_RULE_SIGNATURE", "The rule signature is invalid.", 401);
  }
  const expected = process.env.SOURCE_MERCHANT_SIGNER;
  if (!expected || getAddress(signer) !== getAddress(expected)) {
    throw new BitebackError("INVALID_RULE_SIGNATURE", "The rule signature does not verify.", 401);
  }

  const signed: Rule = {
    ...candidate,
    signer: getAddress(signer),
    signature: input.signature,
  };
  await store.update((database) => {
    const index = database.rules.findIndex(({ id }) => id === candidate.id);
    if (index === -1) database.rules.push(signed);
    else database.rules[index] = signed;
    database.pendingRules = database.pendingRules.filter(
      ({ ruleHash }) => ruleHash !== input.ruleHash,
    );
  });
  await publishAudit(store, "RULE_REGISTERED", "merchant-agent", {
    ruleId: candidate.id,
    ruleHash: input.ruleHash,
    signer: getAddress(signer),
    compiledBy: candidate.compiledBy,
    compilation: candidate.compilation,
  }, {
    dedupeKey: `rule:${input.ruleHash}`,
  });
  return context.json({ rule: signed, ruleHash: input.ruleHash });
});

app.post("/api/report", async (context) => {
  const input = await jsonInput(
    context.req.raw,
    z.object({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      signature: z.string().min(130).max(132),
    }),
  );
  const resolved = await resolveDisputeReport(input.txHash, input.signature);
  const result = await victimFinder.scanViolations(
    resolved.rule.id,
    resolved.from,
    resolved.to,
    undefined,
    resolved.report,
  );
  const existingEvents = store.read().auditEvents;
  if (
    !existingEvents.some(
      ({ event, incidentId, topicId }) =>
        event === "DISPUTE_REPORTED" &&
        incidentId === result.incident.id &&
        topicId === process.env.HCS_TOPIC_ID,
    )
  ) {
    await publishAudit(
      store,
      "DISPUTE_REPORTED",
      "affected-wallet",
      {
        reporter: resolved.report.reporter,
        reportedTxHash: resolved.report.txHash,
        merchant: resolved.report.merchant,
        token: resolved.report.token,
      },
      {
        dedupeKey: `incident:${result.incident.id}:reported`,
        incidentId: result.incident.id,
      },
    );
  }
  if (
    !store
      .read()
      .auditEvents.some(
        ({ event, incidentId, topicId }) =>
          event === "INCIDENT_OPENED" &&
          incidentId === result.incident.id &&
          topicId === process.env.HCS_TOPIC_ID,
      )
  ) {
    await publishAudit(
      store,
      "INCIDENT_OPENED",
      "biteback-watcher",
      {
        evidenceHash: result.incident.evidenceHash,
        victims: result.incident.violations.length,
        triggeredBy: resolved.report.reporter,
      },
      {
        dedupeKey: `incident:${result.incident.id}:opened`,
        incidentId: result.incident.id,
      },
    );
  }
  return context.json({ ...result, report: resolved.report });
});

app.post("/api/scan", async (context) => {
  requireOperator(context.req.header("authorization"));
  const body = await jsonInput(
    context.req.raw,
    z.object({
      ruleId: z.string().default(RULE_ID),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
      replayIncidentId: z.string().optional(),
    }),
  );
  const from = body.from ?? Number(process.env.SOURCE_WINDOW_START);
  const to = body.to ?? Number(process.env.SOURCE_WINDOW_END);
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new BitebackError("GRAPH_QUERY_FAILED", "Configure a valid source scan window.");
  }
  const result = await victimFinder.scanViolations(
    body.ruleId,
    from,
    to,
    body.replayIncidentId,
  );
  if (
    !body.replayIncidentId &&
    !store
      .read()
      .auditEvents.some(
        ({ event, incidentId, topicId }) =>
          event === "INCIDENT_OPENED" &&
          incidentId === result.incident.id &&
          topicId === process.env.HCS_TOPIC_ID,
      )
  ) {
    await publishAudit(
      store,
      "INCIDENT_OPENED",
      "biteback-watcher",
      {
        evidenceHash: result.incident.evidenceHash,
        victims: result.incident.violations.length,
      },
      {
        dedupeKey: `incident:${result.incident.id}:opened`,
        incidentId: result.incident.id,
      },
    );
  }
  return context.json(result);
});

app.get("/api/incidents", (context) => {
  const incidents = store
    .read()
    .incidents.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return context.json({ incidents });
});

app.get("/api/incidents/:id", (context) =>
  context.json(getIncident(store.read(), context.req.param("id"))),
);

app.post("/api/incidents/:id/join", async (context) => {
  const input = await jsonInput(
    context.req.raw,
    z.object({
      victim: z.string(),
      payoutAccountId: z.string(),
      nonce: z.string().min(8),
      expiresAt: z.number().int(),
      signature: z.string(),
    }),
  );
  const incident = getIncident(store.read(), context.req.param("id"));
  if (incident.status !== "CLAIMING") {
    throw new BitebackError("INCIDENT_NOT_SETTLEABLE", "Incident is not accepting claims.", 409);
  }
  const claim = await verifyAndJoinClaim(store, incident, input as JoinClaimInput);
  await publishAudit(
    store,
    "CLAIM_JOINED",
    "affected-wallet",
    {
      claimId: claim.id,
      victim: claim.victim,
      payoutAccountId: claim.payoutAccountId,
    },
    {
      dedupeKey: `claim:${claim.id}`,
      incidentId: incident.id,
    },
  );
  return context.json({ claim }, 201);
});

app.post("/api/incidents/:id/freeze", async (context) => {
  requireOperator(context.req.header("authorization"));
  const id = context.req.param("id");
  const current = getIncident(store.read(), id);

  if (
    current.status === "EVIDENCE_READY" ||
    current.status === "APPROVED" ||
    current.status === "SETTLING" ||
    current.status === "SETTLEMENT_FAILED" ||
    current.status === "SETTLED"
  ) {
    const loss = victimFinder.calculateLoss(id);
    if (current.status !== "SETTLED") {
      await publishAudit(
        store,
        "EVIDENCE_ANCHORED",
        "settlement-agent",
        {
          evidenceHash: current.evidenceHash,
          rootHash: current.evidenceRootHash ?? null,
          indexedBlock: current.evidence.source.indexedBlock,
          ...loss,
        },
        {
          dedupeKey: `evidence:${id}:${current.evidenceHash}`,
          incidentId: id,
        },
      );
    }
    return context.json({
      incidentId: id,
      evidenceHash: current.evidenceHash,
      rootHash: current.evidenceRootHash ?? null,
      payout: current.payout ?? null,
      authorizationRequired:
        current.status === "EVIDENCE_READY" && current.decision?.decision !== "ACCEPT",
      ...loss,
    });
  }
  if (current.status !== "CLAIMING" || current.claims.length !== current.violations.length) {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      "Every affected wallet must have joined before the evidence is frozen.",
      409,
    );
  }

  // O pack e demasiado grande para uma mensagem HCS (~1KB uteis), por isso o
  // conteudo vai para 0G Storage e so o root hash e ancorado na Hedera.
  const archived = await archiveEvidence(current.evidence);
  if (!archived.rootHash) {
    throw new BitebackError(
      "EVIDENCE_STORAGE_FAILED",
      archived.storageError ?? "0G Storage returned no root hash.",
      502,
    );
  }
  const rootHash = archived.rootHash;
  const verification = await verifyArchivedEvidence(
    rootHash,
    archived.evidenceHash,
  );
  if (!verification.ok) {
    throw new BitebackError(
      "EVIDENCE_HASH_MISMATCH",
      "The uploaded 0G Storage bytes do not match the canonical evidence.",
      409,
    );
  }
  await store.update((database) => {
    const incident = getIncident(database, id);
    incident.evidenceRootHash = rootHash;
    transition(incident, "EVIDENCE_READY");
  });

  const loss = victimFinder.calculateLoss(id);
  await publishAudit(
    store,
    "EVIDENCE_ANCHORED",
    "settlement-agent",
    {
      evidenceHash: archived.evidenceHash,
      rootHash: archived.rootHash,
      indexedBlock: current.evidence.source.indexedBlock,
      ...loss,
    },
    {
      dedupeKey: `evidence:${id}:${archived.evidenceHash}`,
      incidentId: id,
    },
  );
  return context.json({
    incidentId: id,
    evidenceHash: archived.evidenceHash,
    rootHash: archived.rootHash,
    storageError: archived.storageError,
    payout: null,
    authorizationRequired: true,
    ...loss,
  });
});

/** Confirma que o conteudo em 0G Storage bate certo com o hash ancorado. */
app.get("/api/incidents/:id/evidence", async (context) => {
  const id = context.req.param("id");
  const incident = getIncident(store.read(), id);
  const rootHash = incident.evidenceRootHash;
  if (!rootHash) {
    return context.json({
      evidence: incident.evidence,
      evidenceHash: incident.evidenceHash,
      rootHash: null,
      verified: null,
      note: "Served locally — this pack was not archived in 0G Storage.",
    });
  }
  const check = await verifyArchivedEvidence(rootHash, incident.evidenceHash);
  return context.json({
    evidence: incident.evidence,
    evidenceHash: incident.evidenceHash,
    rootHash,
    verified: check.ok,
    downloadedHash: check.downloadedHash,
    bytes: check.bytes,
  });
});

/** Executa apenas um settlement que o merchant aceitou depois de ver a prova. */
app.post("/api/incidents/:id/settle", async (context) => {
  requireOperator(context.req.header("authorization"));
  const id = context.req.param("id");
  const before = getIncident(store.read(), id);
  const payout = await settleIncident(id);
  return context.json({
    payout,
    merchantAuthorized: true,
    idempotent: Boolean(before.payout),
  });
});

/** O merchant aceita ou contesta o settlement depois de rever a prova congelada. */
app.post("/api/incidents/:id/decision", async (context) => {
  requireOperator(context.req.header("authorization"));
  const id = context.req.param("id");
  const current = getIncident(store.read(), id);
  const input = await jsonInput(
    context.req.raw,
    z.object({
      decision: z.enum(["ACCEPT", "REJECT"]),
      evidenceHash: z.string().optional(),
      counterEvidenceHash: z.string().optional(),
      reason: z.string().max(280).optional(),
      nonce: z.string().min(8),
      expiresAt: z.number().int(),
      signature: z.string().min(130).max(132),
    }),
  );
  if (current.decision) return context.json({ decision: current.decision, incident: current });
  if (current.status !== "EVIDENCE_READY") {
    throw new BitebackError("INCIDENT_NOT_SETTLEABLE", "The evidence is not frozen.", 409);
  }
  const evidenceHash = input.evidenceHash ?? current.evidenceHash;
  if (evidenceHash !== current.evidenceHash) {
    throw new BitebackError("EVIDENCE_HASH_MISMATCH", "Evidence hash does not match.", 409);
  }
  const totalTinybar = current.evidence.totals.payoutTinybar;
  const nonce = input.nonce;
  const expiresAt = input.expiresAt;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now || expiresAt > now + 300) {
    throw new BitebackError("INVALID_MERCHANT_SIGNATURE", "Merchant decision expired.", 401);
  }
  const message = settlementDecisionMessage(
    id,
    evidenceHash,
    input.decision,
    totalTinybar,
    nonce,
    expiresAt,
  );
  const signature = input.signature;
  let recovered: string;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    throw new BitebackError(
      "INVALID_MERCHANT_SIGNATURE",
      "Invalid merchant signature.",
      401,
    );
  }
  const expected = process.env.SOURCE_MERCHANT_SIGNER;
  if (!expected || getAddress(recovered) !== getAddress(expected)) {
    throw new BitebackError("INVALID_MERCHANT_SIGNATURE", "Invalid merchant signature.", 401);
  }
  const decision: Decision = {
    decision: input.decision,
    evidenceHash,
    totalTinybar,
    nonce,
    expiresAt,
    signer: getAddress(recovered),
    signature,
    decidedAt: new Date().toISOString(),
  };
  if (input.counterEvidenceHash) decision.counterEvidenceHash = input.counterEvidenceHash;
  if (input.reason) decision.reason = input.reason;
  await store.update((database) => {
    if (database.usedNonces.includes(`decision:${nonce}`)) {
      throw new BitebackError("INVALID_MERCHANT_SIGNATURE", "Decision nonce was already used.", 409);
    }
    const incident = getIncident(database, id);
    incident.decision = decision;
    transition(incident, decision.decision === "ACCEPT" ? "APPROVED" : "REJECTED");
    database.usedNonces.push(`decision:${nonce}`);
  });
  const accepted = decision.decision === "ACCEPT";
  await publishAudit(
    store,
    accepted ? "SETTLEMENT_AUTHORIZED" : "MERCHANT_REJECTED",
    "merchant-agent",
    {
      decision: decision.decision,
      signer: decision.signer,
      evidenceHash,
      totalTinybar,
      counterEvidenceHash: input.counterEvidenceHash,
      reason: input.reason,
    },
    {
      dedupeKey: `decision:${id}:${decision.decision.toLowerCase()}`,
      incidentId: id,
    },
  );
  return context.json({ decision, incident: getIncident(store.read(), id) });
});

app.get("/api/incidents/:id/audit", async (context) => {
  const id = context.req.param("id");
  getIncident(store.read(), id);
  const messages = await mirrorAuditMessages();
  return context.json({
    events: messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "incidentId" in message &&
        message.incidentId === id,
    ),
  });
});

app.all("/mcp", async (context) => {
  requireOperator(context.req.header("authorization"));
  return handleMcp(context.req.raw, victimFinder);
});
app.get("/", (context) => context.redirect("/index.html"));
if (!process.env.VERCEL) {
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("*", serveStatic({ path: "./public/index.html" }));
}

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? "8403");
  serve({ fetch: app.fetch, port }, ({ port: activePort }) => {
    console.log(`BITEBACK listening on http://localhost:${activePort}`);
  });
  anomalyMonitor.start();
}
