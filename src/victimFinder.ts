import {
  BitebackError,
  RULE_ID,
  buildIncident,
  detectPolicyViolations,
  transition,
  type DisputeReport,
  type EvidencePack,
  type GraphSource,
  type Incident,
  type Rule,
  type Store,
} from "./domain.js";
import { queryPayments } from "./graph.js";

export interface ScanResult {
  source: "the-graph";
  live: true;
  indexedBlock: number;
  ruleId: string;
  verification: Pick<GraphSource, "provider" | "network" | "indexedBlock" | "queriedAt"> & {
    transferCount: number;
  };
  incident: Incident;
}

export class VictimFinder {
  constructor(private readonly store: Store) {}

  async ensureRule(): Promise<Rule> {
    const existing = this.store.read().rules.find(({ id }) => id === RULE_ID);
    if (existing) return existing;
    const merchant = process.env.SOURCE_MERCHANT_ADDRESS;
    const token = process.env.SOURCE_TOKEN_ADDRESS;
    if (!merchant || !token) {
      throw new BitebackError(
        "RULE_NOT_FOUND",
        "Configure SOURCE_MERCHANT_ADDRESS and SOURCE_TOKEN_ADDRESS.",
        503,
      );
    }
    const rule: Rule = {
      id: RULE_ID,
      version: 1,
      merchant: merchant.toLowerCase(),
      token: token.toLowerCase(),
      sourceChain: `eip155:${process.env.SOURCE_CHAIN_ID ?? "84532"}`,
      maxChargesPerDay: 1,
      bucketSeconds: 86400,
      sameAmountRequired: true,
      effectiveFrom: Number(process.env.SOURCE_EFFECTIVE_FROM ?? "0"),
      compensationBps: 10000,
      refundPerExcessTinybar:
        process.env.REFUND_PER_EXCESS_TINYBAR ?? "200000000",
    };
    await this.store.update((database) => {
      if (!database.rules.some(({ id }) => id === rule.id)) database.rules.push(rule);
    });
    return rule;
  }

  async scanViolations(
    ruleId: string,
    from: number,
    to: number,
    replayIncidentId?: string,
    trigger?: DisputeReport,
  ): Promise<ScanResult> {
    const rule = await this.ensureRule();
    if (rule.id !== ruleId) {
      throw new BitebackError("RULE_NOT_FOUND", `Rule ${ruleId} does not exist.`, 404);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) {
      throw new BitebackError("GRAPH_QUERY_FAILED", "The scan window is invalid.");
    }
    const { payments, source } = await queryPayments(from, to);
    const configuredVictims = (process.env.SOURCE_VICTIM_ADDRESSES ?? "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean);
    const eligiblePayments =
      configuredVictims.length === 0
        ? payments
        : payments.filter(({ payer }) => configuredVictims.includes(payer.toLowerCase()));
    const violations = detectPolicyViolations(rule, eligiblePayments);
    const candidate = buildIncident(rule, source, violations, trigger);
    const verification = {
      provider: source.provider,
      network: source.network,
      indexedBlock: source.indexedBlock,
      queriedAt: source.queriedAt,
      transferCount: eligiblePayments.length,
    };
    const existing = this.store.read().incidents.find(({ id }) => id === candidate.id);
    if (existing) {
      if (replayIncidentId && replayIncidentId !== existing.id) {
        throw new BitebackError("REPLAY_CASE_NOT_FOUND", "The live result does not match this case.", 409);
      }
      return {
        source: "the-graph",
        live: true,
        indexedBlock: source.indexedBlock,
        ruleId,
        verification,
        incident: existing,
      };
    }
    if (replayIncidentId) {
      throw new BitebackError("REPLAY_CASE_NOT_FOUND", "The live result does not match this case.", 409);
    }
    const candidateExcessIds = new Set(
      candidate.violations.flatMap(({ excessCharges }) =>
        excessCharges.map(({ id }) => id),
      ),
    );
    const reusedPayment = this.store
      .read()
      .incidents.flatMap(({ violations }) => violations)
      .flatMap(({ excessCharges }) => excessCharges)
      .find(({ id }) => candidateExcessIds.has(id));
    if (reusedPayment) {
      throw new BitebackError(
        "PAYMENT_ALREADY_PROCESSED",
        `Payment ${reusedPayment.id} already belongs to another incident.`,
        409,
      );
    }
    transition(candidate, "CLAIMING");
    await this.store.update((database) => {
      if (database.incidents.some(({ id }) => id === candidate.id)) return;
      const usedExcessIds = new Set(
        database.incidents
          .flatMap(({ violations }) => violations)
          .flatMap(({ excessCharges }) => excessCharges)
          .map(({ id }) => id),
      );
      const duplicate = [...candidateExcessIds].find((id) => usedExcessIds.has(id));
      if (duplicate) {
        throw new BitebackError(
          "PAYMENT_ALREADY_PROCESSED",
          `Payment ${duplicate} already belongs to another incident.`,
          409,
        );
      }
      database.incidents.push(candidate);
      database.paymentsSeen.push(
        ...eligiblePayments
          .map(({ id }) => id)
          .filter((id) => !database.paymentsSeen.includes(id)),
      );
    });
    return {
      source: "the-graph",
      live: true,
      indexedBlock: source.indexedBlock,
      ruleId,
      verification,
      incident: candidate,
    };
  }

  findVictims(incidentId: string): Array<{
    sourceWallet: string;
    lossSourceUnits: string;
    payoutTinybar: string;
  }> {
    const incident = this.getIncident(incidentId);
    return incident.violations.map(({ victim, lossSourceUnits, payoutTinybar }) => ({
      sourceWallet: victim,
      lossSourceUnits,
      payoutTinybar,
    }));
  }

  calculateLoss(incidentId: string): {
    victimCount: number;
    excessCharges: number;
    payoutTinybar: string;
  } {
    const incident = this.getIncident(incidentId);
    // Recalculado sempre a partir das violacoes: nunca aceitamos um montante
    // enviado pelo cliente.
    return incident.violations.reduce(
      (totals, violation) => ({
        victimCount: totals.victimCount + 1,
        excessCharges: totals.excessCharges + violation.excessCharges.length,
        payoutTinybar: (
          BigInt(totals.payoutTinybar) + BigInt(violation.payoutTinybar)
        ).toString(),
      }),
      { victimCount: 0, excessCharges: 0, payoutTinybar: "0" },
    );
  }

  buildEvidencePack(incidentId: string): {
    evidence: EvidencePack;
    evidenceHash: string;
  } {
    const incident = this.getIncident(incidentId);
    return {
      evidence: incident.evidence,
      evidenceHash: incident.evidenceHash,
    };
  }

  getIncident(incidentId: string): Incident {
    const incident = this.store.read().incidents.find(({ id }) => id === incidentId);
    if (!incident) {
      throw new BitebackError("VICTIM_NOT_IN_INCIDENT", "Incident was not found.", 404);
    }
    return incident;
  }
}
