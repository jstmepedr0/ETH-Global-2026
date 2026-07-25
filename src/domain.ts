import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const RULE_ID = "rule_max_daily_charge_v1";

export type IncidentStatus =
  | "DETECTED"
  | "CLAIMING"
  | "EVIDENCE_READY"
  | "REJECTED"
  | "SETTLING"
  | "SETTLED"
  | "SETTLEMENT_FAILED";

export interface Rule {
  id: string;
  version: 1;
  merchant: string;
  token: string;
  sourceChain: string;
  maxChargesPerDay: number;
  bucketSeconds: number;
  sameAmountRequired: boolean;
  effectiveFrom: number;
  compensationBps: number;
  refundPerExcessTinybar: string;
  compiledBy?: "0g-compute";
  compilation?: {
    provider: "0g-compute";
    model: string;
    endpoint: string;
    termsHash: string;
    outputHash: string;
    compiledAt: string;
  };
  signer?: string;
  signature?: string;
}

interface PendingRule {
  ruleHash: string;
  candidate: Omit<Rule, "signer" | "signature">;
  createdAt: string;
}

export interface Payment {
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  token: string;
  payer: string;
  merchant: string;
  amount: string;
}

export interface Violation {
  id: string;
  victim: string;
  bucket: number;
  withinPolicy: Payment;
  withinPolicyPayments: Payment[];
  excessCharges: Payment[];
  lossSourceUnits: string;
  payoutTinybar: string;
}

export interface GraphSource {
  provider: "the-graph-token-api" | "the-graph-substreams";
  endpoint: string;
  network: string;
  indexedBlock: number;
  queriedAt: string;
}

export interface EvidencePack {
  schema: "biteback.evidence.v1";
  incidentId: string;
  rule: Rule & { hash: string };
  source: GraphSource;
  victims: Array<{
    sourceWallet: string;
    withinPolicy: Payment;
    withinPolicyPayments: Payment[];
    excessCharges: Payment[];
    lossSourceUnits: string;
    payoutTinybar: string;
  }>;
  totals: {
    victims: number;
    excessCharges: number;
    payoutTinybar: string;
  };
}

export interface Claim {
  id: string;
  victim: string;
  payoutAccountId: string;
  delegationHash: string;
  joinedAt: string;
}

/**
 * Recibo de contestacao da via de disputa, onde nao ha regra assinada nem bond.
 * Na via integrada, o merchant ja consentiu ao assinar a regra e a allowance.
 */
export interface Decision {
  decision: "REJECT";
  evidenceHash: string;
  totalTinybar: string;
  counterEvidenceHash?: string;
  reason?: string;
  nonce: string;
  signature: string;
  decidedAt: string;
}

export interface Payout {
  transactionId: string;
  explorerUrl: string;
  recipients: Array<{ accountId: string; tinybar: string }>;
  totalTinybar: string;
  settledAt: string;
  auditPending?: boolean;
}

export interface AuditEvent {
  event: string;
  timestamp: string;
  topicId?: string;
  incidentId?: string;
  dedupeKey?: string;
  payload?: unknown;
  payloadHash: string;
  previousEventHash: string | null;
  hederaTransactionId?: string;
  sequenceNumber?: string;
  messageHash?: string;
  actor: string;
}

export interface SettlementAttempt {
  transactionId: string;
  recipients: Array<{ accountId: string; tinybar: string }>;
  totalTinybar: string;
  createdAt: string;
}

export interface Incident {
  id: string;
  status: IncidentStatus;
  bucket: number;
  ruleId: string;
  createdAt: string;
  updatedAt: string;
  violations: Violation[];
  evidence: EvidencePack;
  evidenceHash: string;
  /** root hash em 0G Storage; ausente se o arquivo falhou e servimos localmente */
  evidenceRootHash?: string;
  claims: Claim[];
  decision?: Decision;
  settlementAttempt?: SettlementAttempt;
  payout?: Payout;
}

export interface Database {
  rules: Rule[];
  pendingRules: PendingRule[];
  incidents: Incident[];
  paymentsSeen: string[];
  settledPaymentIds: string[];
  usedNonces: string[];
  auditEvents: AuditEvent[];
}

const emptyDatabase = (): Database => ({
  rules: [],
  pendingRules: [],
  incidents: [],
  paymentsSeen: [],
  settledPaymentIds: [],
  usedNonces: [],
  auditEvents: [],
});

export class BitebackError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export class Store {
  private database: Database = emptyDatabase();
  private writeQueue = Promise.resolve();

  constructor(private readonly file = process.env.DATA_FILE ?? "data/biteback.json") {}

  async load(): Promise<void> {
    try {
      const database = JSON.parse(await readFile(this.file, "utf8")) as Database;
      database.rules ??= [];
      database.pendingRules ??= [];
      database.incidents ??= [];
      database.paymentsSeen ??= [];
      database.usedNonces ??= [];
      database.auditEvents ??= [];
      const currentTopicId = process.env.HCS_TOPIC_ID;
      if (currentTopicId) {
        for (const event of database.auditEvents) {
          event.topicId ??= currentTopicId;
        }
      }
      database.settledPaymentIds ??= database.incidents
        .filter(({ payout }) => Boolean(payout))
        .flatMap(({ violations }) =>
          violations.flatMap(({ excessCharges }) => excessCharges.map(({ id }) => id)),
        );
      this.database = database;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
  }

  read(): Database {
    return structuredClone(this.database);
  }

  async update(change: (database: Database) => void): Promise<Database> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const next = structuredClone(this.database);
      change(next);
      this.database = next;
      await this.save();
    });
    await this.writeQueue;
    return this.read();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.database, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.file);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hash(value: unknown): string {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function sortPayments(left: Payment, right: Payment): number {
  return (
    left.timestamp - right.timestamp ||
    left.blockNumber - right.blockNumber ||
    left.logIndex - right.logIndex ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Deteta cobrancas ACIMA da politica diaria do merchant.
 *
 * Nao e deteccao de "pagamento duplicado": sem um requestId no pagamento, duas
 * cobrancas iguais no mesmo dia podem ser duas compras legitimas. O que medimos
 * e a violacao de uma regra que o proprio merchant publicou e assinou.
 */
/**
 * A regra sem assinatura — e sobre isto que o hash assinado pelo merchant e
 * calculado, para que a assinatura nao dependa de si propria.
 */
export function ruleWithoutSignature(rule: Rule): Omit<Rule, "signer" | "signature"> {
  const { signer: _signer, signature: _signature, ...rest } = rule;
  return rest;
}

export function detectPolicyViolations(
  rule: Rule,
  sourcePayments: Payment[],
): Violation[] {
  const unique = new Map(sourcePayments.map((payment) => [payment.id, payment]));
  const groups = new Map<string, Payment[]>();

  for (const payment of unique.values()) {
    if (
      payment.merchant.toLowerCase() !== rule.merchant.toLowerCase() ||
      payment.token.toLowerCase() !== rule.token.toLowerCase() ||
      payment.timestamp < rule.effectiveFrom
    ) {
      continue;
    }
    const bucket = Math.floor(payment.timestamp / rule.bucketSeconds);
    // `sameAmountRequired` vem da politica compilada: se a politica so fala de
    // cobrancas repetidas do mesmo valor, o montante entra na chave; se fala de
    // um limite de cobrancas por dia seja qual for o valor, nao entra.
    const key = [
      payment.payer.toLowerCase(),
      payment.merchant.toLowerCase(),
      payment.token.toLowerCase(),
      bucket,
      rule.sameAmountRequired ? payment.amount : "*",
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(payment);
    groups.set(key, group);
  }

  const violations: Violation[] = [];
  for (const group of groups.values()) {
    group.sort(sortPayments);
    if (group.length <= rule.maxChargesPerDay) continue;
    const withinPolicyPayments = group.slice(0, rule.maxChargesPerDay);
    const withinPolicy = withinPolicyPayments[0];
    if (!withinPolicy) continue;
    const excessCharges = group.slice(rule.maxChargesPerDay);
    const lossSourceUnits = excessCharges
      .reduce((total, payment) => total + BigInt(payment.amount), 0n)
      .toString();
    const payoutTinybar = (
      (BigInt(rule.refundPerExcessTinybar) *
        BigInt(excessCharges.length) *
        BigInt(rule.compensationBps)) /
      10_000n
    ).toString();
    const bucket = Math.floor(withinPolicy.timestamp / rule.bucketSeconds);
    const excessIds = excessCharges.map(({ id }) => id).sort();
    violations.push({
      id: hash(`${rule.id}|${withinPolicy.payer.toLowerCase()}|${bucket}|${excessIds.join(",")}`),
      victim: withinPolicy.payer.toLowerCase(),
      bucket,
      withinPolicy,
      withinPolicyPayments,
      excessCharges,
      lossSourceUnits,
      payoutTinybar,
    });
  }

  const byVictim = new Map<string, Violation>();
  for (const violation of violations) {
    const key = `${violation.victim}|${violation.bucket}`;
    const existing = byVictim.get(key);
    if (!existing) {
      byVictim.set(key, violation);
      continue;
    }
    existing.withinPolicyPayments.push(...violation.withinPolicyPayments);
    existing.withinPolicyPayments.sort(sortPayments);
    existing.withinPolicy = existing.withinPolicyPayments[0]!;
    existing.excessCharges.push(...violation.excessCharges);
    existing.excessCharges.sort(sortPayments);
    existing.lossSourceUnits = (
      BigInt(existing.lossSourceUnits) + BigInt(violation.lossSourceUnits)
    ).toString();
    existing.payoutTinybar = (
      BigInt(existing.payoutTinybar) + BigInt(violation.payoutTinybar)
    ).toString();
    const excessIds = existing.excessCharges.map(({ id }) => id).sort();
    existing.id = hash(
      `${rule.id}|${existing.victim}|${existing.bucket}|${excessIds.join(",")}`,
    );
  }

  return [...byVictim.values()].sort((left, right) =>
    left.victim.localeCompare(right.victim),
  );
}

export function buildIncident(
  rule: Rule,
  source: GraphSource,
  violations: Violation[],
): Incident {
  if (violations.length === 0) {
    throw new BitebackError("NO_VIOLATIONS", "No deterministic violations were found.", 404);
  }
  const bucket = violations[0]?.bucket;
  if (bucket === undefined || violations.some((violation) => violation.bucket !== bucket)) {
    throw new BitebackError("GRAPH_QUERY_FAILED", "Violations span more than one UTC bucket.");
  }
  const incidentId = hash(
    `${rule.id}|${rule.merchant.toLowerCase()}|${bucket}|${violations
      .map(({ id }) => id)
      .sort()
      .join(",")}`,
  );
  const ruleHash = hash(ruleWithoutSignature(rule));
  const victims = violations
    .map((violation) => ({
      sourceWallet: violation.victim,
      withinPolicy: violation.withinPolicy,
      withinPolicyPayments: violation.withinPolicyPayments,
      excessCharges: [...violation.excessCharges].sort(sortPayments),
      lossSourceUnits: violation.lossSourceUnits,
      payoutTinybar: violation.payoutTinybar,
    }))
    .sort((left, right) => left.sourceWallet.localeCompare(right.sourceWallet));
  const evidence: EvidencePack = {
    schema: "biteback.evidence.v1",
    incidentId,
    rule: { ...rule, hash: ruleHash },
    source,
    victims,
    totals: {
      victims: victims.length,
      excessCharges: victims.reduce(
        (total, victim) => total + victim.excessCharges.length,
        0,
      ),
      payoutTinybar: victims
        .reduce((total, victim) => total + BigInt(victim.payoutTinybar), 0n)
        .toString(),
    },
  };
  const now = new Date().toISOString();
  return {
    id: incidentId,
    status: "DETECTED",
    bucket,
    ruleId: rule.id,
    createdAt: now,
    updatedAt: now,
    violations,
    evidence,
    evidenceHash: hash(evidence),
    claims: [],
  };
}

/**
 * Nao existe estado ACCEPTED. Um merchant integrado consente UMA vez, antes de
 * existir qualquer incidente: assina a regra e aprova a allowance. Pedir um
 * ACCEPT depois seria pedir permissao para executar uma permissao ja concedida.
 *
 * REJECTED so e alcancavel na via de disputa, onde nao ha regra assinada.
 */
const transitions: Record<IncidentStatus, IncidentStatus[]> = {
  DETECTED: ["CLAIMING"],
  CLAIMING: ["EVIDENCE_READY"],
  EVIDENCE_READY: ["SETTLING", "REJECTED"],
  REJECTED: [],
  SETTLING: ["SETTLED", "SETTLEMENT_FAILED"],
  SETTLED: [],
  SETTLEMENT_FAILED: ["SETTLING"],
};

export function transition(incident: Incident, status: IncidentStatus): void {
  if (!transitions[incident.status].includes(status)) {
    throw new BitebackError(
      "INCIDENT_NOT_SETTLEABLE",
      `Invalid incident transition ${incident.status} → ${status}.`,
      409,
    );
  }
  incident.status = status;
  incident.updatedAt = new Date().toISOString();
}
