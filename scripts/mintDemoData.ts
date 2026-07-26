/**
 * Cria os dados de demo em Base Sepolia: três carteiras afetadas, cada uma
 * cobrada duas vezes no mesmo dia UTC pelo mesmo merchant.
 *
 *   npm run demo:mint
 *
 * Só o MERCHANT precisa de gas. As três carteiras assinam autorizações
 * EIP-3009 off-chain e o merchant relaya-as — que é exactamente como o dataset
 * original foi criado, e é o que permite ao demo ter carteiras de que
 * controlamos as chaves sem andar a mendigar a faucets três vezes.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import {
  Contract,
  JsonRpcProvider,
  Signature,
  Wallet,
  formatEther,
  hexlify,
  randomBytes,
} from "ethers";

const RPC = process.env.SOURCE_RPC_URL ?? "https://sepolia.base.org";
const TOKEN = process.env.SOURCE_TOKEN_ADDRESS!;
const CHAIN_ID = Number(process.env.SOURCE_CHAIN_ID ?? "84532");

/** 0.001 USDC por cobrança — o mesmo valor do dataset original. */
const CHARGE = 1000n;
const CHARGES_PER_WALLET = 2;
const PER_WALLET = CHARGE * BigInt(CHARGES_PER_WALLET);

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} em falta no .env`);
  return value;
}

const provider = new JsonRpcProvider(RPC);
const merchant = new Wallet(required("SOURCE_MERCHANT_PRIVATE_KEY"), provider);
const victims = ["A", "B", "C"].map(
  (label) => new Wallet(required(`SOURCE_VICTIM_${label}_PRIVATE_KEY`), provider),
);

const token = new Contract(TOKEN, ERC20, merchant);
const needed = PER_WALLET * BigInt(victims.length);

console.log(`merchant  ${merchant.address}`);
console.log(`gas       ${formatEther(await provider.getBalance(merchant.address))} ETH`);
console.log(`USDC      ${(await token.balanceOf!(merchant.address)).toString()} unidades\n`);

const gas = await provider.getBalance(merchant.address);
if (gas === 0n) {
  console.error("O merchant não tem gas. Envia ~0.01 ETH de Base Sepolia para:");
  console.error(`  ${merchant.address}`);
  process.exit(1);
}

const merchantUsdc: bigint = await token.balanceOf!(merchant.address);
if (merchantUsdc < needed) {
  console.error(
    `USDC insuficiente: o merchant tem ${merchantUsdc} e são precisas ${needed} unidades.`,
  );
  console.error(`Pede USDC de testnet (Base Sepolia) para ${merchant.address} em faucet.circle.com`);
  process.exit(1);
}

// ── 1. distribuir USDC pelas três carteiras ────────────────────────────────
for (const [index, victim] of victims.entries()) {
  const label = "ABC"[index];
  const balance: bigint = await token.balanceOf!(victim.address);
  if (balance >= PER_WALLET) {
    console.log(`carteira ${label}: já tem ${balance} unidades, ignorada`);
    continue;
  }
  const top = PER_WALLET - balance;
  console.log(`carteira ${label}: a enviar ${top} unidades…`);
  const tx = await token.transfer!(victim.address, top);
  await tx.wait();
  console.log(`           ${tx.hash}`);
}

// ── 2. cada carteira assina duas autorizações EIP-3009 ─────────────────────
// As carteiras nunca precisam de gas: assinam off-chain e o merchant relaya.
const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN };
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

const now = Math.floor(Date.now() / 1000);
const validAfter = 0;
const validBefore = now + 3600;
const hashes: string[] = [];
let firstBlock = Number.POSITIVE_INFINITY;
let lastBlock = 0;

console.log("\na relayar as cobranças…");
for (const [index, victim] of victims.entries()) {
  const label = "ABC"[index];
  for (let charge = 0; charge < CHARGES_PER_WALLET; charge += 1) {
    const message = {
      from: victim.address,
      to: merchant.address,
      value: CHARGE,
      validAfter,
      validBefore,
      nonce: hexlify(randomBytes(32)),
    };
    const signature = Signature.from(await victim.signTypedData(domain, types, message));
    const tx = await token.transferWithAuthorization!(
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
    const receipt = await tx.wait();
    hashes.push(tx.hash);
    firstBlock = Math.min(firstBlock, receipt!.blockNumber);
    lastBlock = Math.max(lastBlock, receipt!.blockNumber);
    console.log(`  ${label}#${charge + 1}  bloco ${receipt!.blockNumber}  ${tx.hash}`);
  }
}

// ── 3. reconfigurar a janela de scan para apanhar exactamente estes eventos ─
const block = await provider.getBlock(lastBlock);
const windowEnd = (block?.timestamp ?? now) + 60;
const firstBlockData = await provider.getBlock(firstBlock);
const windowStart = (firstBlockData?.timestamp ?? now) - 60;

let env = await readFile(".env", "utf8");
const updates: Record<string, string> = {
  SOURCE_VICTIM_ADDRESSES: "",
  SOURCE_REPORTED_TX_HASH: hashes[1]!,
  SOURCE_WINDOW_START: String(windowStart),
  SOURCE_WINDOW_END: String(windowEnd),
  SOURCE_EFFECTIVE_FROM: String(windowStart),
  SOURCE_START_BLOCK: String(firstBlock),
  SOURCE_STOP_BLOCK: String(lastBlock + 1),
};
for (const [key, value] of Object.entries(updates)) {
  env = new RegExp(`^${key}=`, "m").test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${env.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(".env", env, { mode: 0o600 });
await chmod(".env", 0o600);

console.log(`\n${hashes.length} cobranças criadas.`);
console.log(`janela: blocos ${firstBlock}..${lastBlock + 1}, timestamps ${windowStart}..${windowEnd}`);
console.log("\n.env reconfigurado. Agora:");
console.log("  1. reinicia o servidor  (npm run dev)");
console.log("  2. usa Run live proof no dashboard, depois npm run claims:join");
