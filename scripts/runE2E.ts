/**
 * Fluxo completo, de ponta a ponta, num comando.
 *
 *   npm run demo:run
 *
 *   0G Compute compila a política
 *   → merchant assina a regra          (consentimento, antes de haver incidente)
 *   → The Graph deteta as violações
 *   → cada carteira afetada assina a delegação
 *   → Evidence Pack sobe para 0G Storage e o root hash ancora no HCS
 *   → Hedera paga sozinha               (sem ACCEPT: a licença já tinha sido dada)
 *
 * É idempotente até ao ponto onde já chegou: correr duas vezes não paga duas.
 */

import { randomBytes } from "node:crypto";
import { Wallet } from "ethers";

const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8403}`;
const operator = process.env.OPERATOR_TOKEN;

const TERMS =
  process.env.DEMO_POLICY_TERMS ??
  "Subscribers are billed once per calendar day. Any charge beyond the first in a UTC day is refunded in full.";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} em falta no .env`);
  return value;
}

async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(operator ? { authorization: `Bearer ${operator}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} → ${payload?.error?.code ?? response.status}: ${payload?.error?.message ?? ""}`);
  }
  return payload;
}

function step(n: number, title: string): void {
  console.log(`\n${"─".repeat(64)}\n${n}. ${title}\n${"─".repeat(64)}`);
}

// ── 1. 0G Compute compila a política publicada ─────────────────────────────
step(1, "0G Compute compila a política publicada");
console.log(`termos: "${TERMS.slice(0, 70)}…"`);
const compiled = await api("/api/rules/compile", { terms: TERMS });
console.log("regra :", JSON.stringify(compiled.candidate ?? compiled.rule));
console.log("modelo:", compiled.model, "via", compiled.endpoint);
console.log("hash  :", compiled.ruleHash);

// ── 2. o merchant assina — é aqui que o consentimento acontece ──────────────
step(2, "O merchant assina a regra (consentimento, antes de haver incidente)");
const merchant = new Wallet(required("SOURCE_MERCHANT_PRIVATE_KEY"));
const signature = await merchant.signMessage(compiled.signatureMessage);
const signed = await api("/api/rules/sign", { ruleHash: compiled.ruleHash, signature });
console.log("assinada por:", signed.rule.signer);

// ── 3. The Graph deteta ────────────────────────────────────────────────────
step(3, "The Graph deteta as violações em dados live");
const scan = await api("/api/scan", {});
const incident = scan.incident;
console.log("live:", scan.live, "| bloco indexado:", scan.indexedBlock);
console.log("carteiras afetadas:", incident.violations.length);
console.log("total a compensar :", incident.evidence.totals.payoutTinybar, "tinybar");
console.log("incidente:", incident.id);

// Se este incidente ja foi liquidado, nao ha nada a repetir: relata e sai.
if (incident.payout) {
  step(4, "Incidente ja liquidado");
  console.log("transacao :", incident.payout.transactionId);
  console.log("total     :", incident.payout.totalTinybar, "tinybar");
  console.log("HashScan  :", incident.payout.explorerUrl);
  console.log(
    "\nPara uma nova demonstracao precisas de carteiras novas:" +
      "\n  a regra e diaria, por isso as mesmas carteiras no mesmo dia UTC" +
      "\n  produzem o mesmo incidente, que so pode ser liquidado uma vez." +
      "\n  corre  npm run demo:mint  depois de gerar carteiras novas.",
  );
  process.exit(0);
}

// ── 4. cada carteira afetada assina a delegação ────────────────────────────
step(4, "Cada carteira afetada assina a sua delegação");
const expiresAt = Math.floor(Date.now() / 1000) + 1800;
for (const [index, violation] of incident.violations.entries()) {
  const label = "ABC"[index];
  if (!label) break;
  const victimKey = process.env[`SOURCE_VICTIM_${label}_PRIVATE_KEY`];
  const payoutAccountId = process.env[`HEDERA_VICTIM_${label}_ACCOUNT_ID`];
  if (!victimKey || !payoutAccountId) {
    console.log(`  ${label}: configuração em falta, ignorada`);
    continue;
  }
  const wallet = new Wallet(victimKey);
  if (wallet.address.toLowerCase() !== violation.victim.toLowerCase()) {
    console.log(`  ${label}: chave não corresponde a ${violation.victim}, ignorada`);
    continue;
  }
  const nonce = randomBytes(16).toString("hex");
  const message = [
    "BITEBACK_DELEGATION_V1",
    `incidentId=${incident.id}`,
    `victim=${violation.victim.toLowerCase()}`,
    `payout=${payoutAccountId}`,
    `nonce=${nonce}`,
    `expiresAt=${expiresAt}`,
  ].join("\n");
  try {
    await api(`/api/incidents/${incident.id}/join`, {
      victim: violation.victim,
      payoutAccountId,
      nonce,
      expiresAt,
      signature: await wallet.signMessage(message),
    });
    console.log(`  ${label}: ${violation.victim} → ${payoutAccountId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("CLAIM_ALREADY_JOINED")) throw error;
    console.log(`  ${label}: já tinha aderido`);
  }
}

// ── 5. congelar e arquivar em 0G Storage ───────────────────────────────────
step(5, "Evidence Pack → 0G Storage, root hash → HCS");
const frozen = await api(`/api/incidents/${incident.id}/freeze`, {});
console.log("evidenceHash:", frozen.evidenceHash);
console.log("rootHash 0G :", frozen.rootHash ?? `— (${frozen.storageError ?? "não arquivado"})`);

// ── 6. pagar, sem pedir licença ────────────────────────────────────────────
step(6, "Hedera paga automaticamente (sem ACCEPT)");
const settled = await api(`/api/incidents/${incident.id}/settle`, {});
const payout = settled.payout;
console.log("transação :", payout.transactionId);
console.log("total     :", payout.totalTinybar, "tinybar");
for (const recipient of payout.recipients) {
  console.log(`  → ${recipient.accountId}  ${recipient.tinybar} tinybar`);
}
console.log("\nHashScan  :", payout.explorerUrl);
if (settled.idempotent) console.log("(já estava liquidado — devolveu o mesmo payout)");

console.log(`\n${"═".repeat(64)}\nFLUXO COMPLETO\n${"═".repeat(64)}`);
