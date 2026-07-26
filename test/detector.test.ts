import assert from "node:assert/strict";
import test from "node:test";
import {
  BitebackError,
  buildIncident,
  detectPolicyViolations,
  disputeReportMessage,
  settlementDecisionMessage,
  transition,
  type GraphSource,
  type Payment,
  type Rule,
} from "../src/domain.js";

const rule: Rule = {
  id: "rule_max_daily_charge_v1",
  version: 1,
  merchant: "0xmerchant",
  token: "0xtoken",
  sourceChain: "eip155:8453",
  maxChargesPerDay: 1,
  bucketSeconds: 86400,
  sameAmountRequired: true,
  effectiveFrom: 0,
  compensationBps: 10000,
  refundPerExcessTinybar: "200000000",
};

function payment(
  id: string,
  timestamp: number,
  overrides: Partial<Payment> = {},
): Payment {
  return {
    id,
    txHash: `0x${id}`,
    logIndex: Number(id.replace(/\D/g, "") || 0),
    blockNumber: timestamp,
    timestamp,
    token: rule.token,
    payer: "0xvictim",
    merchant: rule.merchant,
    amount: "2000000",
    ...overrides,
  };
}

test("zero or one payment produces no violations", () => {
  assert.deepEqual(detectPolicyViolations(rule, []), []);
  assert.deepEqual(detectPolicyViolations(rule, [payment("1", 100)]), []);
});

test("two equal payments in one UTC bucket produce one excess charge", () => {
  const result = detectPolicyViolations(rule, [payment("1", 100), payment("2", 200)]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.withinPolicy.id, "1");
  assert.deepEqual(result[0]?.withinPolicyPayments.map(({ id }) => id), ["1"]);
  assert.deepEqual(result[0]?.excessCharges.map(({ id }: { id: string }) => id), ["2"]);
  assert.equal(result[0]?.lossSourceUnits, "2000000");
  assert.equal(result[0]?.payoutTinybar, "200000000");
});

test("three equal payments produce two excess charges", () => {
  const result = detectPolicyViolations(rule, [
    payment("3", 300),
    payment("1", 100),
    payment("2", 200),
  ]);
  assert.equal(result[0]?.excessCharges.length, 2);
  assert.equal(result[0]?.lossSourceUnits, "4000000");
  assert.equal(result[0]?.payoutTinybar, "400000000");
});

test("different amounts do not collide", () => {
  const result = detectPolicyViolations(rule, [
    payment("1", 100),
    payment("2", 200, { amount: "3000000" }),
  ]);
  assert.equal(result.length, 0);
});

test("different merchants, tokens, victims and UTC buckets do not collide", () => {
  const result = detectPolicyViolations(rule, [
    payment("1", 100),
    payment("2", 200, { merchant: "0xother" }),
    payment("3", 300, { token: "0xother" }),
    payment("4", 400, { payer: "0xother" }),
    payment("5", 86500),
  ]);
  assert.equal(result.length, 0);
});

test("the same payment id is processed once", () => {
  const first = payment("1", 100);
  assert.equal(detectPolicyViolations(rule, [first, first]).length, 0);
});

test("Graph ordering does not change incident or evidence hash", () => {
  const payments = [payment("3", 300), payment("1", 100), payment("2", 200)];
  const source: GraphSource = {
    provider: "the-graph-token-api",
    endpoint: "https://api.pinax.network/v1",
    network: "base",
    indexedBlock: 300,
    queriedAt: "2026-07-25T00:00:00.000Z",
  };
  const forward = buildIncident(rule, source, detectPolicyViolations(rule, payments));
  const reverse = buildIncident(
    rule,
    source,
    detectPolicyViolations(rule, [...payments].reverse()),
  );
  assert.equal(forward.id, reverse.id);
  assert.equal(forward.evidenceHash, reverse.evidenceHash);
});

test("sameAmountRequired=false groups charges regardless of amount", () => {
  const anyAmount: Rule = { ...rule, sameAmountRequired: false };
  const result = detectPolicyViolations(anyAmount, [
    payment("1", 100),
    payment("2", 200, { amount: "3000000" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.excessCharges.length, 1);
});

test("maxChargesPerDay preserves every allowed payment", () => {
  const twoAllowed: Rule = { ...rule, maxChargesPerDay: 2 };
  const result = detectPolicyViolations(twoAllowed, [
    payment("1", 100),
    payment("2", 200),
    payment("3", 300),
  ]);
  assert.deepEqual(result[0]?.withinPolicyPayments.map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(result[0]?.excessCharges.map(({ id }) => id), ["3"]);
});

test("compensationBps scales the deterministic refund", () => {
  const halfRefund: Rule = { ...rule, compensationBps: 5000 };
  const result = detectPolicyViolations(halfRefund, [
    payment("1", 100),
    payment("2", 200),
    payment("3", 300),
  ]);
  assert.equal(result[0]?.payoutTinybar, "200000000");
});

test("one wallet with multiple repeated amounts produces one aggregate claim", () => {
  const result = detectPolicyViolations(rule, [
    payment("1", 100, { amount: "1000" }),
    payment("2", 200, { amount: "1000" }),
    payment("3", 300, { amount: "2000" }),
    payment("4", 400, { amount: "2000" }),
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.withinPolicyPayments.map(({ id }) => id), ["1", "3"]);
  assert.deepEqual(result[0]?.excessCharges.map(({ id }) => id), ["2", "4"]);
  assert.equal(result[0]?.lossSourceUnits, "3000");
  assert.equal(result[0]?.payoutTinybar, "400000000");
});

test("the exact rule snapshot is part of the evidence hash", () => {
  const payments = [payment("1", 100), payment("2", 200)];
  const source: GraphSource = {
    provider: "the-graph-token-api",
    endpoint: "https://api.pinax.network/v1",
    network: "base",
    indexedBlock: 200,
    queriedAt: "2026-07-25T00:00:00.000Z",
  };
  const first = buildIncident(rule, source, detectPolicyViolations(rule, payments));
  const changedRule = { ...rule, compensationBps: 5000 };
  const changed = buildIncident(
    changedRule,
    source,
    detectPolicyViolations(changedRule, payments),
  );
  assert.notEqual(first.evidenceHash, changed.evidenceHash);
  assert.equal(first.evidence.rule.hash.startsWith("sha256:"), true);
});

test("an unsigned compiled rule creates collective evidence but no financial consent", () => {
  const unsignedRule: Rule = {
    ...rule,
    compiledBy: "0g-compute",
    compilation: {
      provider: "0g-compute",
      model: "test-model",
      endpoint: "https://compute.test",
      termsHash: "sha256:terms",
      outputHash: "sha256:output",
      compiledAt: "2026-07-25T00:00:00.000Z",
    },
  };
  const payments = [
    payment("1", 100),
    payment("2", 200),
    payment("3", 300, { payer: "0xsecond-victim" }),
    payment("4", 400, { payer: "0xsecond-victim" }),
  ];
  const violations = detectPolicyViolations(unsignedRule, payments);
  const incident = buildIncident(
    unsignedRule,
    {
      provider: "the-graph-substreams",
      endpoint: "https://graph.test",
      network: "base-sepolia",
      indexedBlock: 400,
      queriedAt: "2026-07-25T00:00:00.000Z",
    },
    violations,
  );

  assert.equal(incident.evidence.totals.victims, 2);
  assert.equal(incident.evidence.rule.signature, undefined);
  assert.equal(incident.evidence.rule.compilation?.termsHash, "sha256:terms");

  transition(incident, "CLAIMING");
  transition(incident, "EVIDENCE_READY");
  transition(incident, "REJECTED");
  assert.throws(
    () => transition(incident, "SETTLING"),
    (error) => error instanceof BitebackError && error.code === "INCIDENT_NOT_SETTLEABLE",
  );
});

test("settlement requires an explicit post-evidence merchant approval", () => {
  const payments = [payment("1", 100), payment("2", 200)];
  const incident = buildIncident(
    rule,
    {
      provider: "the-graph-substreams",
      endpoint: "https://graph.test",
      network: "base-sepolia",
      indexedBlock: 200,
      queriedAt: "2026-07-25T00:00:00.000Z",
    },
    detectPolicyViolations(rule, payments),
  );
  transition(incident, "CLAIMING");
  transition(incident, "EVIDENCE_READY");
  assert.throws(
    () => transition(incident, "SETTLING"),
    (error) => error instanceof BitebackError && error.code === "INCIDENT_NOT_SETTLEABLE",
  );
  transition(incident, "APPROVED");
  transition(incident, "SETTLING");
  assert.equal(incident.status, "SETTLING");
});

test("merchant decision signs the exact incident, evidence and payout", () => {
  const message = settlementDecisionMessage(
    "incident-1",
    "sha256:evidence",
    "ACCEPT",
    "600000000",
    "nonce-1",
    123,
  );
  assert.equal(
    message,
    [
      "BITEBACK_DECISION_V1",
      "incidentId=incident-1",
      "evidenceHash=sha256:evidence",
      "decision=ACCEPT",
      "totalTinybar=600000000",
      "nonce=nonce-1",
      "expiresAt=123",
    ].join("\n"),
  );
});

test("one signed transaction report is preserved as the collective search trigger", () => {
  const payments = [payment("report-1", 100), payment("report-2", 101)];
  const violations = detectPolicyViolations(rule, payments);
  const graphSource: GraphSource = {
    provider: "the-graph-substreams",
    endpoint: "https://graph.test",
    network: "base-sepolia",
    indexedBlock: 101,
    queriedAt: "2026-07-25T00:00:00.000Z",
  };
  const trigger = {
    version: 1 as const,
    reporter: "0xvictim",
    txHash: payments[1]!.txHash,
    merchant: rule.merchant,
    token: rule.token,
    timestamp: payments[1]!.timestamp,
    signature: "0xsigned",
    signedAt: "2026-07-25T00:00:00.000Z",
  };
  const incident = buildIncident(rule, graphSource, violations, trigger);
  const withoutTrigger = buildIncident(rule, graphSource, violations);

  assert.equal(
    disputeReportMessage(trigger.txHash),
    `BITEBACK_REPORT_V1\ntxHash=${trigger.txHash}`,
  );
  assert.deepEqual(incident.evidence.trigger, trigger);
  assert.equal(incident.id, withoutTrigger.id);
  assert.notEqual(incident.evidenceHash, withoutTrigger.evidenceHash);
});

test("zero deterministic violations cannot create a public dispute", () => {
  assert.throws(
    () =>
      buildIncident(
        rule,
        {
          provider: "the-graph-substreams",
          endpoint: "https://graph.test",
          network: "base-sepolia",
          indexedBlock: 1,
          queriedAt: "2026-07-25T00:00:00.000Z",
        },
        [],
      ),
    (error) => error instanceof BitebackError && error.code === "NO_VIOLATIONS",
  );
});
