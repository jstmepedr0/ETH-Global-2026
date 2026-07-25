import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIncident,
  detectPolicyViolations,
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

test("the signed rule snapshot is part of the evidence hash", () => {
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
