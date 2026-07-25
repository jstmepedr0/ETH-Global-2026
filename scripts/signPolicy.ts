import { Wallet } from "ethers";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:8403";
const headers = {
  authorization: `Bearer ${required("OPERATOR_TOKEN")}`,
  "content-type": "application/json",
};
const terms =
  process.argv.slice(2).join(" ").trim() ||
  "A payer may be charged no more than once per UTC day for the same amount. Every charge above that limit receives 100% of the fixed compensation amount.";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(result.error?.message ?? `${path} returned ${response.status}.`);
  }
  return result;
}

const compiled = await post<{
  ruleHash: string;
  signatureMessage: string;
  model: string;
}>("/api/rules/compile", { terms });
const wallet = new Wallet(required("SOURCE_MERCHANT_PRIVATE_KEY"));
const signature = await wallet.signMessage(compiled.signatureMessage);
await post("/api/rules/sign", { ruleHash: compiled.ruleHash, signature });

console.log(`Signed ${compiled.ruleHash} with ${wallet.address} via ${compiled.model}.`);
