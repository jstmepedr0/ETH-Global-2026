import {
  AccountBalanceQuery,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  Status,
  TopicMessageSubmitTransaction,
  TransactionId,
  TransferTransaction,
} from "@hashgraph/sdk";
import {
  BitebackError,
  hash,
  type AuditEvent,
  type Payout,
  type SettlementAttempt,
  type Store,
} from "./domain.js";

const mirrorUrl = () =>
  process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";

export interface BondStatus {
  accountId: string;
  spenderAccountId: string;
  balanceTinybar: string;
  allowanceTinybar: string;
  protected: boolean;
  checkedAt: string;
}

export function parseHederaPrivateKey(value: string): PrivateKey {
  for (const parse of [
    PrivateKey.fromStringECDSA,
    PrivateKey.fromStringED25519,
    PrivateKey.fromString,
  ]) {
    try {
      return parse(value);
    } catch {
      continue;
    }
  }
  throw new Error("Invalid Hedera private key.");
}

export function hederaClient(accountId: string, privateKey: string): Client {
  const client =
    (process.env.HEDERA_NETWORK ?? "testnet") === "mainnet"
      ? Client.forMainnet()
      : Client.forTestnet();
  return client.setOperator(AccountId.fromString(accountId), parseHederaPrivateKey(privateKey));
}

function settlementClient(): Client {
  const accountId = process.env.HEDERA_SETTLEMENT_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_SETTLEMENT_PRIVATE_KEY;
  if (!accountId || !privateKey) {
    throw new BitebackError(
      "HEDERA_TRANSACTION_FAILED",
      "Settlement Agent Hedera credentials are missing.",
      503,
    );
  }
  return hederaClient(accountId, privateKey);
}

export async function getBondStatus(): Promise<BondStatus> {
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID;
  const spenderAccountId = process.env.HEDERA_SETTLEMENT_ACCOUNT_ID;
  if (!bondAccountId || !spenderAccountId) {
    throw new BitebackError(
      "BOND_INSUFFICIENT",
      "Consumer Bond accounts are not configured.",
      503,
    );
  }
  const client = settlementClient();
  try {
    const balance = await new AccountBalanceQuery()
      .setAccountId(bondAccountId)
      .execute(client);
    const allowanceResponse = await fetch(
      `${mirrorUrl()}/api/v1/accounts/${bondAccountId}/allowances/crypto?spender.id=${spenderAccountId}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!allowanceResponse.ok) throw new Error(`Mirror Node ${allowanceResponse.status}`);
    const allowanceBody = (await allowanceResponse.json()) as {
      allowances?: Array<{ amount: number; spender: string }>;
    };
    const allowance = (allowanceBody.allowances ?? []).find(
      ({ spender }) => spender === spenderAccountId,
    );
    const balanceTinybar = balance.hbars.toTinybars().toString();
    const allowanceTinybar = String(allowance?.amount ?? 0);
    const target = BigInt(process.env.BOND_TARGET_TINYBAR ?? "10000000000");
    return {
      accountId: bondAccountId,
      spenderAccountId,
      balanceTinybar,
      allowanceTinybar,
      protected:
        BigInt(balanceTinybar) >= target && BigInt(allowanceTinybar) >= target,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    client.close();
  }
}

export async function publishAudit(
  store: Store,
  event: string,
  actor: string,
  payload: unknown,
  options: {
    dedupeKey: string;
    incidentId?: string;
    hederaTransactionId?: string;
  },
): Promise<AuditEvent> {
  const topicId = process.env.HCS_TOPIC_ID;
  if (!topicId) {
    throw new BitebackError("HEDERA_TRANSACTION_FAILED", "HCS_TOPIC_ID is missing.", 503);
  }
  const local = store
    .read()
    .auditEvents.find(
      ({ dedupeKey, topicId: eventTopicId }) =>
        dedupeKey === options.dedupeKey && eventTopicId === topicId,
    );
  if (local) return local;

  const mirrorResponse = await fetch(
    `${mirrorUrl()}/api/v1/topics/${topicId}/messages?limit=100&order=desc`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const mirrorBody = mirrorResponse.ok
    ? ((await mirrorResponse.json()) as {
        messages?: Array<{
          message: string;
          sequence_number: number;
          consensus_timestamp: string;
        }>;
      })
    : { messages: [] };
  const decoded = (mirrorBody.messages ?? []).flatMap((message) => {
    try {
      return [{
        value: JSON.parse(Buffer.from(message.message, "base64").toString("utf8")) as Record<string, unknown>,
        sequenceNumber: String(message.sequence_number),
      }];
    } catch {
      return [];
    }
  });
  const mirrored = decoded.find(({ value }) => value.dedupeKey === options.dedupeKey);
  if (mirrored) {
    const existing = {
      ...mirrored.value,
      topicId,
      sequenceNumber: mirrored.sequenceNumber,
      messageHash: hash(mirrored.value),
    } as unknown as AuditEvent;
    await store.update((database) => {
      if (
        !database.auditEvents.some(
          ({ dedupeKey, topicId: eventTopicId }) =>
            dedupeKey === options.dedupeKey && eventTopicId === topicId,
        )
      ) {
        database.auditEvents.push(existing);
      }
    });
    return existing;
  }
  const previous = store
    .read()
    .auditEvents.findLast(({ topicId: eventTopicId }) => eventTopicId === topicId);
  if (!mirrorResponse.ok && !previous?.messageHash) {
    throw new BitebackError(
      "HEDERA_TRANSACTION_FAILED",
      `Mirror Node returned ${mirrorResponse.status}; refusing to fork the audit chain.`,
      502,
    );
  }
  const previousEventHash =
    decoded[0] ? hash(decoded[0].value) : previous?.messageHash ?? null;
  const envelope: AuditEvent = {
    event,
    timestamp: new Date().toISOString(),
    topicId,
    dedupeKey: options.dedupeKey,
    payload,
    payloadHash: hash(payload),
    previousEventHash,
    actor,
  };
  if (options.incidentId) envelope.incidentId = options.incidentId;
  if (options.hederaTransactionId) {
    envelope.hederaTransactionId = options.hederaTransactionId;
  }
  const message = {
    schema: "biteback.audit.v1",
    event: envelope.event,
    timestamp: envelope.timestamp,
    topicId,
    dedupeKey: envelope.dedupeKey,
    payload: envelope.payload,
    payloadHash: envelope.payloadHash,
    previousEventHash: envelope.previousEventHash,
    actor: envelope.actor,
    ...(envelope.incidentId ? { incidentId: envelope.incidentId } : {}),
    ...(envelope.hederaTransactionId
      ? { hederaTransactionId: envelope.hederaTransactionId }
      : {}),
  };
  const client = settlementClient();
  try {
    const response = await new TopicMessageSubmitTransaction({
      topicId,
      message: JSON.stringify(message),
    }).execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status !== Status.Success) {
      throw new Error(`HCS receipt ${receipt.status.toString()}`);
    }
    const sequence = receipt.topicSequenceNumber?.toString();
    if (sequence) envelope.sequenceNumber = sequence;
    envelope.messageHash = hash(message);
  } catch (error) {
    throw new BitebackError(
      "HEDERA_TRANSACTION_FAILED",
      `HCS publish failed: ${String(error)}`,
      502,
    );
  } finally {
    client.close();
  }
  await store.update((database) => {
    database.auditEvents.push(envelope);
  });
  return envelope;
}

export async function executePayout(
  attempt: SettlementAttempt,
  incidentId: string,
): Promise<Payout> {
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID;
  if (!bondAccountId) {
    throw new BitebackError("BOND_INSUFFICIENT", "HEDERA_BOND_ACCOUNT_ID is missing.", 503);
  }
  const total = attempt.recipients.reduce(
    (sum, recipient) => sum + BigInt(recipient.tinybar),
    0n,
  );
  if (total.toString() !== attempt.totalTinybar) {
    throw new BitebackError("EVIDENCE_HASH_MISMATCH", "Settlement attempt total changed.", 409);
  }
  const bond = await getBondStatus();
  if (BigInt(bond.balanceTinybar) < total) {
    throw new BitebackError("BOND_INSUFFICIENT", "Consumer Bond balance is insufficient.", 409);
  }
  if (BigInt(bond.allowanceTinybar) < total) {
    throw new BitebackError(
      "ALLOWANCE_INSUFFICIENT",
      "Consumer Bond allowance is insufficient.",
      409,
    );
  }
  const transaction = new TransferTransaction()
    .setTransactionId(TransactionId.fromString(attempt.transactionId))
    .setTransactionMemo(`BITEBACK:${incidentId}`)
    .addApprovedHbarTransfer(
      bondAccountId,
      Hbar.fromTinybars((-total).toString()),
    );
  for (const recipient of attempt.recipients) {
    transaction.addHbarTransfer(
      AccountId.fromString(recipient.accountId),
      Hbar.fromTinybars(recipient.tinybar),
    );
  }
  const client = settlementClient();
  try {
    const response = await transaction.execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status !== Status.Success) {
      throw new Error(`Payout receipt ${receipt.status.toString()}`);
    }
    return {
      transactionId: attempt.transactionId,
      explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(attempt.transactionId)}`,
      recipients: attempt.recipients,
      totalTinybar: total.toString(),
      settledAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new BitebackError(
      "HEDERA_TRANSACTION_FAILED",
      `Atomic payout failed: ${String(error)}`,
      502,
    );
  } finally {
    client.close();
  }
}

export function createPayoutAttempt(
  recipients: Array<{ accountId: string; tinybar: string }>,
): SettlementAttempt {
  const settlementAccountId = process.env.HEDERA_SETTLEMENT_ACCOUNT_ID;
  if (!settlementAccountId) {
    throw new BitebackError(
      "HEDERA_TRANSACTION_FAILED",
      "HEDERA_SETTLEMENT_ACCOUNT_ID is missing.",
      503,
    );
  }
  return {
    transactionId: TransactionId.generate(
      AccountId.fromString(settlementAccountId),
    ).toString(),
    recipients,
    totalTinybar: recipients
      .reduce((total, recipient) => total + BigInt(recipient.tinybar), 0n)
      .toString(),
    createdAt: new Date().toISOString(),
  };
}

export async function reconcilePayout(
  attempt: SettlementAttempt,
): Promise<{ status: "SUCCESS"; payout: Payout } | { status: "FAILED" | "PENDING" }> {
  const [accountId, validStart] = attempt.transactionId.split("@");
  if (!accountId || !validStart) {
    throw new BitebackError(
      "HEDERA_RECONCILIATION_FAILED",
      "Stored Hedera transaction ID is invalid.",
      500,
    );
  }
  const mirrorId = `${accountId}-${validStart.replace(".", "-")}`;
  let response: Response;
  try {
    response = await fetch(`${mirrorUrl()}/api/v1/transactions/${mirrorId}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new BitebackError(
      "HEDERA_RECONCILIATION_FAILED",
      `Mirror Node reconciliation failed: ${String(error)}`,
      502,
    );
  }
  if (response.status === 404) return { status: "PENDING" };
  if (!response.ok) {
    throw new BitebackError(
      "HEDERA_RECONCILIATION_FAILED",
      `Mirror Node returned ${response.status}.`,
      502,
    );
  }
  const body = (await response.json()) as {
    transactions?: Array<{ result: string; consensus_timestamp?: string }>;
  };
  const transaction = body.transactions?.[0];
  if (!transaction) return { status: "PENDING" };
  if (transaction.result !== "SUCCESS") return { status: "FAILED" };
  return {
    status: "SUCCESS",
    payout: {
      transactionId: attempt.transactionId,
      explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(attempt.transactionId)}`,
      recipients: attempt.recipients,
      totalTinybar: attempt.totalTinybar,
      settledAt: transaction.consensus_timestamp ?? new Date().toISOString(),
    },
  };
}

export async function mirrorAuditMessages(): Promise<unknown[]> {
  const topicId = process.env.HCS_TOPIC_ID;
  if (!topicId) return [];
  const response = await fetch(
    `${mirrorUrl()}/api/v1/topics/${topicId}/messages?limit=100&order=asc`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) {
    throw new BitebackError(
      "HEDERA_TRANSACTION_FAILED",
      `Mirror Node returned ${response.status}.`,
      502,
    );
  }
  const body = (await response.json()) as {
    messages?: Array<{ message: string; sequence_number: number; consensus_timestamp: string }>;
  };
  return (body.messages ?? []).map((message) => {
    const decoded = Buffer.from(message.message, "base64").toString("utf8");
    try {
      return {
        ...JSON.parse(decoded),
        mirrorSequenceNumber: message.sequence_number,
        consensusTimestamp: message.consensus_timestamp,
      };
    } catch {
      return {
        message: decoded,
        mirrorSequenceNumber: message.sequence_number,
        consensusTimestamp: message.consensus_timestamp,
      };
    }
  });
}
