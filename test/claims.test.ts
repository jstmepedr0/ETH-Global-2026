import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet } from "ethers";
import { delegationMessage, verifyAndJoinClaim } from "../src/claims.js";
import {
  BitebackError,
  Store,
  buildIncident,
  detectPolicyViolations,
  transition,
  type Payment,
  type Rule,
} from "../src/domain.js";

const rule: Rule = {
  id: "rule_max_daily_charge_v1",
  version: 1,
  merchant: "0x0000000000000000000000000000000000000001",
  token: "0x0000000000000000000000000000000000000002",
  sourceChain: "eip155:84532",
  maxChargesPerDay: 1,
  bucketSeconds: 86400,
  sameAmountRequired: true,
  effectiveFrom: 0,
  compensationBps: 10000,
  refundPerExcessTinybar: "200000000",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "biteback-claims-"));
  const wallet = Wallet.createRandom();
  const payment = (id: string, timestamp: number): Payment => ({
    id,
    txHash: `0x${id.padStart(64, "0")}`,
    logIndex: Number(id),
    blockNumber: Number(id),
    timestamp,
    token: rule.token,
    payer: wallet.address.toLowerCase(),
    merchant: rule.merchant,
    amount: "1000",
  });
  const payments = [payment("1", 100), payment("2", 200)];
  const incident = buildIncident(
    rule,
    {
      provider: "the-graph-substreams",
      endpoint: "https://example.test",
      network: "base-sepolia",
      indexedBlock: 2,
      queriedAt: "2026-07-25T00:00:00.000Z",
    },
    detectPolicyViolations(rule, payments),
  );
  transition(incident, "CLAIMING");
  const store = new Store(join(directory, "data.json"));
  await store.load();
  await store.update((database) => database.incidents.push(incident));
  return { directory, incident, store, wallet };
}

test("only the affected wallet can join and it can join once", async () => {
  const { directory, incident, store, wallet } = await fixture();
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const input = {
      victim: wallet.address,
      payoutAccountId: "0.0.1234",
      nonce: "claim-nonce-1",
      expiresAt,
      signature: await wallet.signMessage(
        delegationMessage(
          incident.id,
          wallet.address,
          "0.0.1234",
          "claim-nonce-1",
          expiresAt,
        ),
      ),
    };
    const claim = await verifyAndJoinClaim(store, incident, input);
    assert.equal(claim.victim, wallet.address.toLowerCase());
    await assert.rejects(
      verifyAndJoinClaim(store, incident, input),
      (error) => error instanceof BitebackError && error.code === "CLAIM_ALREADY_JOINED",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("forged and overlong delegations are rejected", async () => {
  const { directory, incident, store, wallet } = await fixture();
  try {
    const attacker = Wallet.createRandom();
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const message = delegationMessage(
      incident.id,
      wallet.address,
      "0.0.1234",
      "claim-nonce-2",
      expiresAt,
    );
    await assert.rejects(
      verifyAndJoinClaim(store, incident, {
        victim: wallet.address,
        payoutAccountId: "0.0.1234",
        nonce: "claim-nonce-2",
        expiresAt,
        signature: await attacker.signMessage(message),
      }),
      (error) => error instanceof BitebackError && error.code === "INVALID_DELEGATION",
    );
    await assert.rejects(
      verifyAndJoinClaim(store, incident, {
        victim: wallet.address,
        payoutAccountId: "0.0.1234",
        nonce: "claim-nonce-3",
        expiresAt: Math.floor(Date.now() / 1000) + 7200,
        signature: "0x",
      }),
      (error) => error instanceof BitebackError && error.code === "INVALID_DELEGATION",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
