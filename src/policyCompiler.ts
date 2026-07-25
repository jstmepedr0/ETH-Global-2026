/**
 * Policy Compiler — inferência em 0G Compute.
 *
 * Converte os termos publicados de um merchant, em linguagem natural, numa
 * regra determinística que o merchant depois assina.
 *
 * A LINHA VERMELHA: o modelo escreve a REGRA, nunca o resultado. Não vê
 * pagamentos, não conta cobranças, não calcula montantes e não escolhe
 * destinatários. Assim que a regra é assinada, o modelo está fora do circuito
 * e a deteção é 100% determinística e reproduzível por terceiros.
 *
 * É por isto que não devolvemos nada parecido com "claim válido, 4 HBAR,
 * confiança 97%": um merchant não deve pagar com base num palpite
 * probabilístico. Aqui ele assina exatamente a regra que vai ser aplicada.
 */

import { z } from "zod";
import { BitebackError } from "./domain.js";

/**
 * O output do modelo é validado contra isto antes de chegar ao merchant.
 * Um LLM a devolver JSON inválido não pode partir o servidor nem produzir uma
 * regra que pague o que não deve.
 */
export const compiledRuleSchema = z.object({
  maxChargesPerDay: z.number().int().min(1).max(100),
  bucketSeconds: z.literal(86400),
  sameAmountRequired: z.boolean(),
  compensationBps: z.number().int().min(0).max(10000),
}).strict();

export type CompiledRule = z.infer<typeof compiledRuleSchema>;

export interface CompileResult {
  rule: CompiledRule;
  model: string;
  endpoint: string;
  /** o texto exacto que o modelo devolveu, para auditoria */
  raw: string;
}

const SYSTEM_PROMPT = [
  "You compile a merchant's published billing policy into a strict JSON rule.",
  "",
  "Return ONLY a JSON object with exactly these keys:",
  '  "maxChargesPerDay": integer >= 1  — how many charges per payer per UTC day the policy allows',
  '  "bucketSeconds": always 86400',
  '  "sameAmountRequired": boolean — true if the policy only concerns repeated charges of the same amount',
  '  "compensationBps": integer 0..10000 — refund share in basis points (10000 = full refund)',
  "",
  "Rules:",
  "- Output raw JSON only. No prose, no markdown, no code fences.",
  "- Never invent obligations the text does not state.",
  '- If the text has no explicit daily limit or refund share, return {"error":"unsupported policy"}.',
].join("\n");

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new BitebackError("POLICY_COMPILE_FAILED", "The model returned no JSON object.", 502);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new BitebackError("POLICY_COMPILE_FAILED", "The model returned malformed JSON.", 502);
  }
}

/**
 * Chama o 0G Compute através do router OpenAI-compatible do 0G Foundation.
 *
 * O SDK oficial (`@0gfoundation/0g-compute-ts-sdk`) exige financiar um ledger
 * on-chain antes da primeira chamada; o router é o mesmo 0G Compute sem esse
 * passo. Ambos satisfazem o requisito de inferência da track — este é o que
 * corre sem setup adicional.
 */
async function callCompute(terms: string): Promise<{ text: string; model: string; endpoint: string }> {
  const base = process.env.OG_ROUTER_BASE;
  const key = process.env.OG_ROUTER_KEY;
  const model = process.env.OG_MODEL ?? "qwen2.5-omni";
  if (!base || !key) {
    throw new BitebackError(
      "POLICY_COMPILE_FAILED",
      "0G Compute is not configured — set OG_ROUTER_BASE and OG_ROUTER_KEY.",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: terms },
        ],
      }),
      signal: AbortSignal.timeout(Number(process.env.OG_COMPUTE_TIMEOUT_MS ?? "30000")),
    });
  } catch (error) {
    throw new BitebackError(
      "POLICY_COMPILE_FAILED",
      `0G Compute request failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new BitebackError(
      "POLICY_COMPILE_FAILED",
      `0G Compute returned ${response.status}: ${detail.slice(0, 200)}`,
      502,
    );
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (!text) {
    throw new BitebackError("POLICY_COMPILE_FAILED", "0G Compute returned no content.", 502);
  }
  return { text, model, endpoint: base };
}

export async function compilePolicy(terms: string): Promise<CompileResult> {
  if (terms.trim().length < 10) {
    throw new BitebackError("POLICY_COMPILE_FAILED", "The policy text is too short to compile.");
  }

  const { text, model, endpoint } = await callCompute(terms);
  const parsed = compiledRuleSchema.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new BitebackError(
      "INVALID_COMPILED_RULE",
      `The compiled rule failed validation: ${z.prettifyError(parsed.error)}`,
      502,
    );
  }

  return { rule: parsed.data, model, endpoint, raw: text };
}

/** A mensagem que o merchant assina. Prende a regra ao seu conteúdo exacto. */
export function ruleSignatureMessage(ruleId: string, ruleHash: string): string {
  return ["BITEBACK_RULE_V1", `ruleId=${ruleId}`, `ruleHash=${ruleHash}`].join("\n");
}
