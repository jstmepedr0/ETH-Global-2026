import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import {
  AccountAllowanceApproveTransaction,
  AccountBalanceQuery,
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  Status,
  TopicCreateTransaction,
  TopicInfoQuery,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { Wallet } from "ethers";
import { hash } from "../src/domain.js";
import { hederaClient } from "../src/hedera.js";

const envFile = ".env";
const sourceConfig = {
  PORT: "8403",
  PUBLIC_BASE_URL: "http://localhost:8403",
  SOURCE_PROVIDER: "substreams",
  SOURCE_NETWORK: "base-sepolia",
  SOURCE_CHAIN_ID: "84532",
  SOURCE_TOKEN_ADDRESS: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  SOURCE_EXPLORER_URL: "https://sepolia.basescan.org",
  SOURCE_SUBSTREAMS_ENDPOINT: "https://basesepolia.substreams.pinax.network",
  SOURCE_SUBSTREAMS_PACKAGE:
    "https://spkg.io/hashirpm/erc20-transfer-events-v0.1.2.spkg",
  SOURCE_SUBSTREAMS_MODULE: "map_tranfers",
  SOURCE_RPC_URL: "https://sepolia.base.org",
  REFUND_PER_EXCESS_TINYBAR: "200000000",
  SOURCE_MIN_CONFIRMATIONS: "20",
  BOND_TARGET_TINYBAR: "10000000000",
  HEDERA_NETWORK: "testnet",
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  OG_EVM_RPC: "https://evmrpc-testnet.0g.ai",
  OG_INDEXER: "https://indexer-storage-testnet-turbo.0g.ai",
};

async function updateEnv(values: Record<string, string>): Promise<void> {
  const current = await readFile(envFile, "utf8").catch(() => "");
  const lines = current.split(/\r?\n/);
  const updated = new Set<string>();
  const next = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match?.[1] || !(match[1] in values)) return line;
    updated.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!updated.has(key)) next.push(`${key}=${value}`);
  }
  await writeFile(envFile, `${next.filter((line, index) => line || index < next.length - 1).join("\n")}\n`, {
    mode: 0o600,
  });
  await chmod(envFile, 0o600);
}

async function createAccount(
  initialBalance: Hbar,
): Promise<{ accountId: string; privateKey: string }> {
  const key = PrivateKey.generateECDSA();
  const transaction = await new AccountCreateTransaction()
    .setKey(key.publicKey)
    .setInitialBalance(initialBalance)
    .execute(operatorClient);
  const receipt = await transaction.getReceipt(operatorClient);
  if (receipt.status !== Status.Success || !receipt.accountId) {
    throw new Error(`Account creation failed: ${receipt.status.toString()}`);
  }
  return { accountId: receipt.accountId.toString(), privateKey: key.toStringRaw() };
}

const operatorAccountId = process.env.HEDERA_ACCOUNT_ID;
const operatorPrivateKey = process.env.HEDERA_PRIVATE_KEY;
if (!operatorAccountId || !operatorPrivateKey) {
  throw new Error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required.");
}
const operatorClient = hederaClient(operatorAccountId, operatorPrivateKey);

try {
  let bond =
    process.env.HEDERA_BOND_ACCOUNT_ID && process.env.HEDERA_BOND_PRIVATE_KEY
      ? {
          accountId: process.env.HEDERA_BOND_ACCOUNT_ID,
          privateKey: process.env.HEDERA_BOND_PRIVATE_KEY,
        }
      : undefined;
  if (!bond) {
    console.log("Creating 100 HBAR settlement reserve account...");
    bond = await createAccount(new Hbar(101));
  }

  let settlement =
    process.env.HEDERA_SETTLEMENT_ACCOUNT_ID &&
    process.env.HEDERA_SETTLEMENT_PRIVATE_KEY
      ? {
          accountId: process.env.HEDERA_SETTLEMENT_ACCOUNT_ID,
          privateKey: process.env.HEDERA_SETTLEMENT_PRIVATE_KEY,
        }
      : undefined;
  if (!settlement) {
    console.log("Creating Hedera Settlement Agent account...");
    settlement = await createAccount(new Hbar(1));
  }
  const settlementAccountId = settlement.accountId;
  const settlementPrivateKey = settlement.privateKey;

  const victims: Array<{ accountId: string; privateKey: string }> = [];
  for (const suffix of ["A", "B", "C"]) {
    const accountId = process.env[`HEDERA_VICTIM_${suffix}_ACCOUNT_ID`];
    const privateKey = process.env[`HEDERA_VICTIM_${suffix}_PRIVATE_KEY`];
    if (accountId && privateKey) victims.push({ accountId, privateKey });
    else {
      console.log(`Creating Hedera victim ${suffix} account...`);
      victims.push(await createAccount(new Hbar(0.1)));
    }
  }

  let topicId = process.env.RESET_HCS_TOPIC === "1" ? undefined : process.env.HCS_TOPIC_ID;
  let topicCreated = false;
  if (topicId) {
    try {
      const info = await new TopicInfoQuery().setTopicId(topicId).execute(operatorClient);
      if (info.topicMemo !== "BITEBACK_AUDIT_V1") topicId = undefined;
    } catch {
      topicId = undefined;
    }
  }
  if (!topicId) {
    console.log("Creating BITEBACK HCS audit topic...");
    const response = await new TopicCreateTransaction()
      .setTopicMemo("BITEBACK_AUDIT_V1")
      .execute(operatorClient);
    const receipt = await response.getReceipt(operatorClient);
    if (receipt.status !== Status.Success || !receipt.topicId) {
      throw new Error(`Topic creation failed: ${receipt.status.toString()}`);
    }
    topicId = receipt.topicId.toString();
    topicCreated = true;
  }

  console.log("Approving 100 HBAR allowance for the Settlement Agent...");
  const bondClient = hederaClient(bond.accountId, bond.privateKey);
  try {
    const response = await new AccountAllowanceApproveTransaction()
      .approveHbarAllowance(bond.accountId, settlementAccountId, new Hbar(100))
      .execute(bondClient);
    const receipt = await response.getReceipt(bondClient);
    if (receipt.status !== Status.Success) {
      throw new Error(`Allowance failed: ${receipt.status.toString()}`);
    }
  } finally {
    bondClient.close();
  }
  const bondBalance = await new AccountBalanceQuery()
    .setAccountId(bond.accountId)
    .execute(operatorClient);
  const bondFundingTarget = 10_100_000_000n;
  const topUp = bondFundingTarget - BigInt(bondBalance.hbars.toTinybars().toString());
  if (topUp > 0n) {
    console.log("Restoring settlement reserve funding after allowance fees...");
    const response = await new TransferTransaction()
      .addHbarTransfer(operatorAccountId, Hbar.fromTinybars((-topUp).toString()))
      .addHbarTransfer(bond.accountId, Hbar.fromTinybars(topUp.toString()))
      .execute(operatorClient);
    const receipt = await response.getReceipt(operatorClient);
    if (receipt.status !== Status.Success) {
      throw new Error(`Bond top-up failed: ${receipt.status.toString()}`);
    }
  }

  const merchantWallet = process.env.SOURCE_MERCHANT_PRIVATE_KEY
    ? new Wallet(process.env.SOURCE_MERCHANT_PRIVATE_KEY)
    : Wallet.createRandom();
  const sourceVictims = ["A", "B", "C"].map((suffix) => {
    const key = process.env[`SOURCE_VICTIM_${suffix}_PRIVATE_KEY`];
    return key ? new Wallet(key) : Wallet.createRandom();
  });
  const values: Record<string, string> = {
    ...sourceConfig,
    OPERATOR_TOKEN: process.env.OPERATOR_TOKEN || randomBytes(32).toString("hex"),
    HEDERA_OPERATOR_ACCOUNT_ID: operatorAccountId,
    HEDERA_OPERATOR_PRIVATE_KEY: operatorPrivateKey,
    HEDERA_BOND_ACCOUNT_ID: bond.accountId,
    HEDERA_BOND_PRIVATE_KEY: bond.privateKey,
    HEDERA_SETTLEMENT_ACCOUNT_ID: settlementAccountId,
    HEDERA_SETTLEMENT_PRIVATE_KEY: settlementPrivateKey,
    HEDERA_VICTIM_A_ACCOUNT_ID: victims[0]!.accountId,
    HEDERA_VICTIM_A_PRIVATE_KEY: victims[0]!.privateKey,
    HEDERA_VICTIM_B_ACCOUNT_ID: victims[1]!.accountId,
    HEDERA_VICTIM_B_PRIVATE_KEY: victims[1]!.privateKey,
    HEDERA_VICTIM_C_ACCOUNT_ID: victims[2]!.accountId,
    HEDERA_VICTIM_C_PRIVATE_KEY: victims[2]!.privateKey,
    HCS_TOPIC_ID: topicId,
    RESET_HCS_TOPIC: "0",
    SOURCE_MERCHANT_PRIVATE_KEY: merchantWallet.privateKey,
    SOURCE_MERCHANT_ADDRESS: merchantWallet.address.toLowerCase(),
    SOURCE_MERCHANT_SIGNER: merchantWallet.address,
    SOURCE_VICTIM_ADDRESSES: sourceVictims
      .map(({ address }) => address.toLowerCase())
      .join(","),
    SOURCE_VICTIM_A_PRIVATE_KEY: sourceVictims[0]!.privateKey,
    SOURCE_VICTIM_B_PRIVATE_KEY: sourceVictims[1]!.privateKey,
    SOURCE_VICTIM_C_PRIVATE_KEY: sourceVictims[2]!.privateKey,
  };
  if (topicCreated && process.env.HCS_TOPIC_ID) {
    const dataFile = process.env.DATA_FILE ?? "data/biteback.json";
    const persisted = await readFile(dataFile, "utf8")
      .then((value) => JSON.parse(value) as { auditEvents?: Array<{ topicId?: string }> })
      .catch(() => undefined);
    if (persisted?.auditEvents) {
      for (const event of persisted.auditEvents) {
        event.topicId ??= process.env.HCS_TOPIC_ID;
      }
      await writeFile(dataFile, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      await chmod(dataFile, 0o600);
    }
  }
  await updateEnv(values);

  if (topicCreated) {
    const settlementClient = hederaClient(settlementAccountId, settlementPrivateKey);
    try {
      let previousEventHash: string | null = null;
      for (const [event, payload] of [
        [
          "BOND_STATUS",
          {
            bondAccountId: bond.accountId,
            spenderAccountId: settlementAccountId,
            balanceTinybar: bondFundingTarget.toString(),
            allowanceTinybar: "10000000000",
          },
        ],
      ] as const) {
        const message = {
          schema: "biteback.audit.v1",
          event,
          timestamp: new Date().toISOString(),
          topicId,
          dedupeKey: `setup:${event.toLowerCase()}`,
          payload,
          payloadHash: hash(payload),
          previousEventHash,
          actor: "biteback-setup",
        };
        const response = await new TopicMessageSubmitTransaction({
          topicId,
          message: JSON.stringify(message),
        }).execute(settlementClient);
        const receipt = await response.getReceipt(settlementClient);
        if (receipt.status !== Status.Success) {
          throw new Error(`HCS initialization failed: ${receipt.status.toString()}`);
        }
        previousEventHash = hash(message);
      }
    } finally {
      settlementClient.close();
    }
  }

  console.log("\nBITEBACK demo infrastructure is ready.");
  console.log(`Bond: ${bond.accountId} (101 HBAR, 100 HBAR allowance)`);
  console.log(`Settlement Agent: ${settlementAccountId}`);
  console.log(`HCS topic: ${topicId}`);
  console.log(`Victim payouts: ${victims.map(({ accountId }) => accountId).join(", ")}`);
  console.log(`Source wallets: ${sourceVictims.map(({ address }) => address).join(", ")}`);
} finally {
  operatorClient.close();
}
