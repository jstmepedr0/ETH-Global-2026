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
  randomBytes as ethersRandomBytes,
  verifyMessage,
} from "ethers";
import { z } from "zod";
import {
  BitebackError,
  RULE_ID,
  Store,
  detectPolicyViolations,
  hash,
  ruleWithoutSignature,
  transition,
  type Decision,
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

const store = new Store();
await store.load();
const victimFinder = new VictimFinder(store);
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
  | "graph"
  | "claims"
  | "evidence"
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
  process.env.SOURCE_VICTIM_ADDRESSES = victims
    .map(({ wallet }) => wallet.address.toLowerCase())
    .join(",");
  process.env.SOURCE_WINDOW_START = String(windowStart);
  process.env.SOURCE_WINDOW_END = String(windowEnd);
  process.env.SOURCE_START_BLOCK = String(firstBlock);
  process.env.SOURCE_STOP_BLOCK = String(requiredBlock + 1);

  updateLiveDemo(id, {
    stage: "graph",
    message: "Base confirmed all six charges. Waiting for The Graph to index them.",
    base: { latestBlock, firstChargeBlock: firstBlock, requiredBlock },
    graph: {
      status: "querying",
      queryCount: 0,
      transferCount: 0,
      affectedWallets: 0,
    },
  });

  const rule = await victimFinder.ensureRule();
  let scan:
    | {
        incident: Incident;
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
      const result = await queryPayments(windowStart, windowEnd);
      const watched = new Set(victims.map(({ wallet }) => wallet.address.toLowerCase()));
      const payments = result.payments.filter(({ payer }) =>
        watched.has(payer.toLowerCase()),
      );
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
        scan = await localApi("/api/scan", {
          method: "POST",
          body: JSON.stringify({ ruleId: rule.id, from: windowStart, to: windowEnd }),
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
    message: "The affected wallets are authorizing their Hedera recipients.",
    incidentId: scan.incident.id,
    claimsAuthorized: 0,
  });

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  for (const victim of victims) {
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
  }>(`/api/incidents/${scan.incident.id}/freeze?settle=false`, {
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
    stage: "refund",
    message: "Hedera is executing one atomic payout from the Consumer Bond.",
  });
  const { payout } = await localApi<{ payout: Payout }>(
    `/api/incidents/${scan.incident.id}/settle`,
    { method: "POST", body: "{}" },
  );
  updateLiveDemo(id, {
    stage: "complete",
    message: "Live incident settled successfully.",
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

function decisionMessage(
  incidentId: string,
  evidenceHash: string,
  decision: "REJECT",
  totalTinybar: string,
  nonce: string,
  expiresAt: number,
): string {
  return [
    "BITEBACK_DECISION_V1",
    `incidentId=${incidentId}`,
    `evidenceHash=${evidenceHash}`,
    `decision=${decision}`,
    `totalTinybar=${totalTinybar}`,
    `nonce=${nonce}`,
    `expiresAt=${expiresAt}`,
  ].join("\n");
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
        autonomous: true,
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
      autonomous: true,
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

  if (current.status !== "EVIDENCE_READY" && current.status !== "SETTLEMENT_FAILED") {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      "The evidence must be frozen before settlement.",
      409,
    );
  }
  if (hash(current.evidence) !== current.evidenceHash) {
    throw new BitebackError("EVIDENCE_HASH_MISMATCH", "The evidence changed after freezing.", 409);
  }

  const { hash: frozenRuleHash, ...frozenRuleFields } = current.evidence.rule;
  const frozenRule = frozenRuleFields as Rule;
  if (!frozenRule.signature || !frozenRule.signer) {
    throw new BitebackError(
      "RULE_NOT_SIGNED",
      "This merchant has not signed the frozen policy rule.",
      409,
    );
  }
  if (hash(ruleWithoutSignature(frozenRule)) !== frozenRuleHash) {
    throw new BitebackError(
      "EVIDENCE_HASH_MISMATCH",
      "The frozen rule does not match its signed hash.",
      409,
    );
  }
  let recoveredRuleSigner: string;
  try {
    recoveredRuleSigner = verifyMessage(
      ruleSignatureMessage(frozenRule.id, frozenRuleHash),
      frozenRule.signature,
    );
  } catch {
    throw new BitebackError("INVALID_RULE_SIGNATURE", "The frozen rule signature is invalid.", 409);
  }
  const expectedSigner = process.env.SOURCE_MERCHANT_SIGNER;
  if (
    !expectedSigner ||
    getAddress(recoveredRuleSigner) !== getAddress(frozenRule.signer) ||
    getAddress(recoveredRuleSigner) !== getAddress(expectedSigner)
  ) {
    throw new BitebackError(
      "INVALID_RULE_SIGNATURE",
      "The frozen rule signer is not the allowlisted merchant.",
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
      "Autonomous settlement requires evidence archived in 0G Storage.",
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

app.get("/api/health", (context) =>
  context.json({
    ok: true,
    service: "BITEBACK",
    version: "1.0.0",
    integrations: {
      graph: Boolean(process.env.PINAX_JWT),
      zerog: Boolean(process.env.OG_ROUTER_BASE && process.env.OG_ROUTER_KEY),
      hedera: Boolean(process.env.HEDERA_BOND_ACCOUNT_ID && process.env.HCS_TOPIC_ID),
    },
    operatorAuth: Boolean(process.env.OPERATOR_TOKEN),
  }),
);

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
  });
});

app.get("/api/bond", async (context) => context.json(await getBondStatus()));

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

/**
 * O merchant assina a regra. E este o consentimento que torna o settlement
 * automatico: acontece antes de existir qualquer incidente.
 */
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
  const shouldSettle = context.req.query("settle") !== "false";

  if (
    current.status === "EVIDENCE_READY" ||
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
    const payout =
      shouldSettle && current.evidence.rule.signature && current.status !== "SETTLED"
        ? await settleIncident(id)
        : current.payout;
    return context.json({
      incidentId: id,
      evidenceHash: current.evidenceHash,
      rootHash: current.evidenceRootHash ?? null,
      payout: payout ?? null,
      autonomous: Boolean(payout),
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
  const payout = shouldSettle && current.evidence.rule.signature
    ? await settleIncident(id)
    : undefined;

  return context.json({
    incidentId: id,
    evidenceHash: archived.evidenceHash,
    rootHash: archived.rootHash,
    storageError: archived.storageError,
    payout: payout ?? null,
    autonomous: Boolean(payout),
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

/**
 * Settlement automatico.
 *
 * Nao ha ACCEPT. O merchant integrado ja consentiu duas vezes, antes de existir
 * qualquer incidente: assinou a regra e aprovou a allowance. Aqui apenas
 * verificamos que esse consentimento continua valido e que os numeros batem —
 * e pagamos. Nenhuma destas verificacoes e um clique humano.
 */
app.post("/api/incidents/:id/settle", async (context) => {
  requireOperator(context.req.header("authorization"));
  const id = context.req.param("id");
  const before = getIncident(store.read(), id);
  const payout = await settleIncident(id);
  return context.json({
    payout,
    autonomous: true,
    idempotent: Boolean(before.payout),
  });
});

/**
 * So existe para o modo NAO integrado, onde nao ha regra assinada nem bond:
 * o merchant pode recusar, e a recusa fica no registo publico.
 */
app.post("/api/incidents/:id/decision", async (context) => {
  requireOperator(context.req.header("authorization"));
  const id = context.req.param("id");
  const current = getIncident(store.read(), id);
  const input = await jsonInput(
    context.req.raw,
    z.object({
      decision: z.literal("REJECT"),
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
  if (current.evidence.rule.signature || current.evidence.rule.signer) {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      "An integrated merchant cannot reject a pre-authorized settlement.",
      409,
    );
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
  const message = decisionMessage(id, evidenceHash, "REJECT", totalTinybar, nonce, expiresAt);
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
    decision: "REJECT",
    evidenceHash,
    totalTinybar,
    nonce,
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
    transition(incident, "REJECTED");
    database.usedNonces.push(`decision:${nonce}`);
  });
  await publishAudit(
    store,
    "MERCHANT_REJECTED",
    "merchant-agent",
    { evidenceHash, totalTinybar, counterEvidenceHash: input.counterEvidenceHash, reason: input.reason },
    {
      dedupeKey: `decision:${id}:reject`,
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
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

const port = Number(process.env.PORT ?? "8403");
serve({ fetch: app.fetch, port }, ({ port: activePort }) => {
  console.log(`BITEBACK listening on http://localhost:${activePort}`);
});
