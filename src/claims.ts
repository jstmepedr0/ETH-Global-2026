/**
 * Adesão de uma carteira afetada a um incidente.
 *
 * Uma só coisa precisa de ser provada aqui: que quem reclama controla a
 * carteira que a chain diz ter sido cobrada acima da política. Uma assinatura
 * EIP-191 chega.
 *
 * O que NÃO fazemos, e não precisamos: provar que existe uma pessoa única por
 * trás do claim. A elegibilidade não vem da identidade — vem da evidência.
 * Ninguém se inscreve como vítima; o detector deriva o conjunto de carteiras
 * afetadas a partir de dados on-chain. Criar mil carteiras não cria dano,
 * porque para reclamar é preciso ter sido cobrado a mais, e essa cobrança
 * custou dinheiro real.
 */

import { AccountId } from "@hashgraph/sdk";
import { verifyMessage } from "ethers";
import {
  BitebackError,
  hash,
  type Claim,
  type Incident,
  type Store,
} from "./domain.js";

export interface JoinClaimInput {
  victim: string;
  payoutAccountId: string;
  nonce: string;
  expiresAt: number;
  /** assinatura EIP-191 da carteira afetada */
  signature: string;
}

export function delegationMessage(
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

export async function verifyAndJoinClaim(
  store: Store,
  incident: Incident,
  input: JoinClaimInput,
): Promise<Claim> {
  const now = Math.floor(Date.now() / 1000);
  if (input.expiresAt <= now) {
    throw new BitebackError("DELEGATION_EXPIRED", "The victim delegation expired.", 401);
  }
  const maxLifetime = Number(process.env.DELEGATION_MAX_LIFETIME_SECONDS ?? "3600");
  if (!Number.isSafeInteger(maxLifetime) || maxLifetime < 1 || input.expiresAt > now + maxLifetime) {
    throw new BitebackError(
      "INVALID_DELEGATION",
      `Delegation expiry must be within ${maxLifetime} seconds.`,
      401,
    );
  }

  try {
    AccountId.fromString(input.payoutAccountId);
  } catch {
    throw new BitebackError("INVALID_DELEGATION", "Invalid Hedera payout account.");
  }

  const victim = input.victim.toLowerCase();

  // A elegibilidade é derivada da evidência, nunca declarada: só entra quem o
  // detector já tinha encontrado nos dados on-chain.
  if (!incident.violations.some((violation) => violation.victim === victim)) {
    throw new BitebackError(
      "VICTIM_NOT_IN_INCIDENT",
      "The delegating wallet is not an affected wallet in this incident.",
      403,
    );
  }

  const message = delegationMessage(
    incident.id,
    victim,
    input.payoutAccountId,
    input.nonce,
    input.expiresAt,
  );

  let signer: string;
  try {
    signer = verifyMessage(message, input.signature).toLowerCase();
  } catch {
    throw new BitebackError("INVALID_DELEGATION", "Invalid EIP-191 delegation.", 401);
  }
  if (signer !== victim) {
    throw new BitebackError(
      "INVALID_DELEGATION",
      "Delegation signer does not match the affected wallet.",
      401,
    );
  }

  const claim: Claim = {
    id: hash(`${incident.id}|${victim}`),
    victim,
    payoutAccountId: input.payoutAccountId,
    delegationHash: hash(message),
    joinedAt: new Date().toISOString(),
  };

  await store.update((next) => {
    const target = next.incidents.find(({ id }) => id === incident.id);
    if (!target) throw new BitebackError("VICTIM_NOT_IN_INCIDENT", "Incident disappeared.", 404);
    if (target.claims.some((existing) => existing.victim === victim)) {
      throw new BitebackError("CLAIM_ALREADY_JOINED", "This wallet already joined.", 409);
    }
    const nonceKey = `delegation:${input.nonce}`;
    if (next.usedNonces.includes(nonceKey)) {
      throw new BitebackError("INVALID_DELEGATION", "A claim nonce was already used.", 409);
    }
    target.claims.push(claim);
    target.updatedAt = new Date().toISOString();
    next.usedNonces.push(nonceKey);
  });

  return claim;
}
