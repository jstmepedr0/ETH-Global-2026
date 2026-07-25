/**
 * Faz cada carteira afetada assinar a delegação e aderir ao incidente.
 *
 * É a peça que fecha o E2E: sem claims a evidência não pode ser congelada.
 *
 *   npm run claims:join
 *
 * Uma assinatura EIP-191 por carteira. Não dá elegibilidade — a elegibilidade
 * vem de a carteira aparecer nas violações detectadas a partir de dados
 * on-chain. A assinatura só prova que quem reclama controla a carteira.
 */

import { randomBytes } from "node:crypto";
import { Wallet } from "ethers";

const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8403}`;

function delegationMessage(
  incidentId: string,
  victim: string,
  payoutAccountId: string,
  nonce: string,
  expiresAt: number,
): string {
  return [
    "BITEBACK_DELEGATION_V1",
    `incidentId=${incidentId}`,
    `victim=${victim.toLowerCase()}`,
    `payout=${payoutAccountId}`,
    `nonce=${nonce}`,
    `expiresAt=${expiresAt}`,
  ].join("\n");
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body?.error?.code ?? response.status;
    throw new Error(`${path} → ${code}: ${body?.error?.message ?? "erro desconhecido"}`);
  }
  return body;
}

const { incidents } = await api("/api/incidents");
const incident = incidents.find((candidate: any) => candidate.status === "CLAIMING");
if (!incident) {
  throw new Error('Nenhum incidente em CLAIMING — corre "POST /api/scan" primeiro');
}

console.log(`incidente ${incident.id}`);
console.log(`vítimas   ${incident.violations.length}\n`);

const expiresAt = Math.floor(Date.now() / 1000) + 3600;
let joined = 0;

for (const [index, violation] of incident.violations.entries()) {
  const label = ["A", "B", "C"][index];
  if (!label) break;

  const victimKey = process.env[`SOURCE_VICTIM_${label}_PRIVATE_KEY`];
  const payoutAccountId = process.env[`HEDERA_VICTIM_${label}_ACCOUNT_ID`];
  if (incident.claims.some((claim: { victim: string }) => claim.victim === violation.victim)) {
    console.log(`carteira ${label}: claim já registado — ignorada`);
    continue;
  }

  if (!victimKey || !payoutAccountId) {
    console.log(
      `carteira ${label}: falta SOURCE_VICTIM_${label}_PRIVATE_KEY ou HEDERA_VICTIM_${label}_ACCOUNT_ID — ignorada`,
    );
    continue;
  }

  const victimWallet = new Wallet(victimKey);

  // A chave tem de corresponder à carteira que foi mesmo cobrada acima da
  // política — caso contrário o servidor devolve VICTIM_NOT_IN_INCIDENT, e é
  // isso que queremos: a elegibilidade vem da evidência, não do pedido.
  if (victimWallet.address.toLowerCase() !== violation.victim.toLowerCase()) {
    console.log(
      `carteira ${label}: SOURCE_VICTIM_${label}_PRIVATE_KEY é ${victimWallet.address}, mas a violação é de ${violation.victim} — ignorada`,
    );
    continue;
  }

  const nonce = randomBytes(16).toString("hex");
  const message = delegationMessage(
    incident.id,
    violation.victim,
    payoutAccountId,
    nonce,
    expiresAt,
  );

  const { claim } = await api(`/api/incidents/${incident.id}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      victim: violation.victim,
      payoutAccountId,
      nonce,
      expiresAt,
      signature: await victimWallet.signMessage(message),
    }),
  });

  console.log(`carteira ${label}: ${violation.victim} → payout ${payoutAccountId}`);
  console.log(`           claim ${claim.id}`);
  joined += 1;
}

console.log(`\n${joined} claims registados.`);
if (joined > 0) console.log("próximo: clica Freeze evidence no dashboard");
