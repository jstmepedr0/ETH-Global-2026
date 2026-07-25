/**
 * Evidence Pack — canonicalização e arquivo em 0G Storage.
 *
 * Porque é que o 0G Storage é indispensável aqui, e não decorativo:
 * uma mensagem HCS carrega ~1KB antes de precisar de chunking, e um pack com
 * três carteiras e seis cobranças tem vários KB. Logo o conteúdo vai para o 0G
 * Storage e só o `rootHash` é ancorado na Hedera. Qualquer pessoa descarrega
 * pelo root hash, recalcula o sha256 e compara com o que está no HCS — sem
 * precisar de confiar em nós.
 *
 * O hash é calculado sobre JSON canónico (chaves ordenadas), por isso duas
 * execuções sobre o mesmo incidente produzem o mesmo hash mesmo que o Graph
 * devolva os eventos noutra ordem.
 */

import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { Wallet, JsonRpcProvider } from "ethers";
import { BitebackError, canonicalJson, hash, type EvidencePack } from "./domain.js";

export interface ArchivedEvidence {
  evidenceHash: string;
  /** null quando o 0G Storage não está configurado ou falhou — ver storageError */
  rootHash: string | null;
  txHash?: string;
  storageError?: string;
}

const INDEXER_URL = () =>
  process.env.OG_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai";
const EVM_RPC = () => process.env.OG_EVM_RPC ?? "https://evmrpc-testnet.0g.ai";

/** Bytes canónicos do pack. É sobre estes que o sha256 é calculado. */
export function canonicalBytes(evidence: EvidencePack): Uint8Array {
  return new TextEncoder().encode(canonicalJson(evidence));
}

export function evidenceHashOf(evidence: EvidencePack): string {
  return hash(evidence);
}

/**
 * Sobe o pack para 0G Storage e devolve o root hash.
 *
 * Nunca atira: um incidente não deve ficar preso porque o arquivo falhou. O
 * chamador decide — no MVP, o dashboard mostra o pack servido localmente e o
 * README documenta o fallback.
 */
export async function archiveEvidence(evidence: EvidencePack): Promise<ArchivedEvidence> {
  const evidenceHash = evidenceHashOf(evidence);
  const privateKey = process.env.OG_PRIVATE_KEY;

  if (!privateKey) {
    return { evidenceHash, rootHash: null, storageError: "OG_PRIVATE_KEY is not configured." };
  }

  try {
    const provider = new JsonRpcProvider(EVM_RPC());
    const signer = new Wallet(privateKey, provider);
    const indexer = new Indexer(INDEXER_URL());
    const file = new MemData(canonicalBytes(evidence));

    // O SDK tipa o signer contra a build CommonJS do ethers; e o mesmo objecto
    // em runtime, mas os dois conjuntos de tipos nao unificam.
    const [result, error] = await indexer.upload(
      file,
      EVM_RPC(),
      signer as unknown as Parameters<Indexer["upload"]>[2],
    );
    if (error) throw error;

    const rootHash = "rootHash" in result ? result.rootHash : result.rootHashes[0];
    const txHash = "txHash" in result ? result.txHash : result.txHashes[0];
    if (!rootHash) throw new Error("0G Storage returned no root hash.");

    return txHash ? { evidenceHash, rootHash, txHash } : { evidenceHash, rootHash };
  } catch (error) {
    return {
      evidenceHash,
      rootHash: null,
      storageError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Descarrega pelo root hash e confirma que o conteúdo bate certo com o hash
 * ancorado. É esta função que torna a afirmação verificável em vez de retórica.
 */
export async function verifyArchivedEvidence(
  rootHash: string,
  expectedHash: string,
): Promise<{ ok: boolean; downloadedHash: string; bytes: number }> {
  const indexer = new Indexer(INDEXER_URL());
  const [blob, error] = await indexer.downloadToBlob(rootHash);
  if (error) {
    throw new BitebackError("EVIDENCE_STORAGE_FAILED", `0G Storage download failed: ${error.message}`, 502);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const downloadedHash = hash(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return { ok: downloadedHash === expectedHash, downloadedHash, bytes: bytes.byteLength };
}
