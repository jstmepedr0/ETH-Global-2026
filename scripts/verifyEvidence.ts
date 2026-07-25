/**
 * Prova que o arquivo em 0G Storage é verificável, e não uma afirmação.
 *
 *   npm run evidence:verify
 *
 * Sobe o Evidence Pack do incidente aberto, descarrega-o de volta pelo root
 * hash e confirma que o sha256 do conteúdo recuperado é exactamente o hash
 * ancorado no HCS. É este round-trip que sustenta a frase do README.
 */

import { archiveEvidence, canonicalBytes, verifyArchivedEvidence } from "../src/evidence.js";
import type { EvidencePack } from "../src/domain.js";

const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8403}`;

const response = await fetch(`${baseUrl}/api/incidents`);
if (!response.ok) throw new Error(`${baseUrl}/api/incidents devolveu ${response.status}`);
const { incidents } = (await response.json()) as { incidents: Array<{ evidence: EvidencePack }> };
const pack = incidents[0]?.evidence;
if (!pack) throw new Error('Nenhum incidente — corre "POST /api/scan" primeiro');

const size = canonicalBytes(pack).length;
console.log(`pack canónico: ${size} bytes`);
console.log(`limite útil de uma mensagem HCS: ~1024 bytes → ${size > 1024 ? "não cabe" : "caberia"}`);
console.log("\na subir para 0G Storage…");

const archived = await archiveEvidence(pack);
console.log(`evidenceHash: ${archived.evidenceHash}`);
console.log(`rootHash    : ${archived.rootHash ?? "—"}`);
if (archived.txHash) console.log(`txHash      : ${archived.txHash}`);

if (!archived.rootHash) {
  console.error(`\n0G Storage falhou: ${archived.storageError}`);
  console.error("O fallback local (GET /api/incidents/:id/evidence) continua a servir o pack.");
  process.exit(1);
}

console.log("\na descarregar pelo root hash e a recalcular o sha256…");
const check = await verifyArchivedEvidence(archived.rootHash, archived.evidenceHash);
console.log(`bytes recuperados: ${check.bytes}`);
console.log(`hash recalculado : ${check.downloadedHash}`);
console.log(`\n${check.ok ? "✅ bate certo com o hash ancorado" : "❌ NÃO bate certo"}`);
if (!check.ok) process.exit(1);
