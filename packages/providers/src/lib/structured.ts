import { z } from "zod";
import type { IntelligenceMessage } from "@gigpilot/contracts";

/**
 * Structured-output helpers shared by the GX, Factory and Grok adapters:
 * JSON Schema derivation (zod 4 `z.toJSONSchema`), tolerant JSON extraction
 * (fences, <think> blocks, leading prose), validation with compact issue
 * summaries, and the single repair round-trip prompt.
 */

const schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

/**
 * JSON Schema for the model. Uses the schema's OUTPUT shape so defaulted
 * fields are required — this makes models fill every field instead of
 * skipping arrays (zod applies defaults again on parse anyway).
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const hit = schemaCache.get(schema);
  if (hit) return hit;
  let js: Record<string, unknown>;
  try {
    js = z.toJSONSchema(schema, { io: "output", unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>;
  } catch {
    js = { type: "object" };
  }
  delete js.$schema;
  schemaCache.set(schema, js);
  return js;
}

export class StructuredParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "StructuredParseError";
  }
}

/** Remove reasoning blocks and markdown fences; return the JSON substring. */
export function extractJsonText(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(t);
  if (fence?.[1]) t = fence[1].trim();
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start = -1;
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) start = firstObj;
  else if (firstArr >= 0) start = firstArr;
  if (start < 0) return t;
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  // Walk to the matching bracket, respecting strings.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return t.slice(start); // unterminated — JSON.parse will report truncation
}

export function parseJsonLoose(text: string): unknown {
  const candidate = extractJsonText(text);
  if (!candidate) throw new StructuredParseError("model returned an empty response", text);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new StructuredParseError(`response is not valid JSON (${msg})`, text);
  }
}

/** Compact, model-readable list of validation issues (capped). */
export function formatIssues(error: z.ZodError, max = 25): string[] {
  return error.issues.slice(0, max).map((i) => {
    const path = i.path.length ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : String(p))).join(".").replace(/\.\[/g, "[") : "(root)";
    return `${path}: ${i.message}`;
  });
}

export type ValidationOutcome<T> = { ok: true; data: T } | { ok: false; issues: string[]; raw: string };

export function parseAndValidate<T>(schema: z.ZodType<T>, text: string, normalize?: (value: unknown) => unknown): ValidationOutcome<T> {
  let value: unknown;
  try {
    value = parseJsonLoose(text);
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)], raw: text };
  }
  if (normalize) value = normalize(value);
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, issues: formatIssues(r.error), raw: text };
}

/**
 * Normalise a message list for chat templates that require exactly one
 * leading system message: all system content is merged (plus `extraSystem`)
 * and placed first; other messages keep their order.
 */
export function mergeSystemMessages(messages: IntelligenceMessage[], extraSystem?: string): IntelligenceMessage[] {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content.trim()).filter(Boolean);
  if (extraSystem) sys.push(extraSystem.trim());
  const rest = messages.filter((m) => m.role !== "system");
  const out: IntelligenceMessage[] = [];
  if (sys.length) out.push({ role: "system", content: sys.join("\n\n") });
  out.push(...rest);
  if (!rest.length) out.push({ role: "user", content: "Produce the JSON object now." });
  return out;
}

/** The single repair turn appended after an invalid structured response. */
export function repairMessages(previous: IntelligenceMessage[], badOutput: string, issues: string[], schemaName: string): IntelligenceMessage[] {
  const trimmed = badOutput.length > 12_000 ? `${badOutput.slice(0, 12_000)}\n…[truncated]` : badOutput;
  return [
    ...previous,
    { role: "assistant", content: trimmed || "(empty response)" },
    {
      role: "user",
      content: [
        `Your previous reply did not match the ${schemaName} JSON Schema. Fix it to match the schema exactly.`,
        "Validation errors:",
        ...issues.map((i) => `- ${i}`),
        "Return ONLY the corrected JSON object — no markdown fences, no commentary. Keep all correct content; change only what is needed.",
      ].join("\n"),
    },
  ];
}

/** ~4 chars per token heuristic used for cost estimates when usage is unavailable. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messagesText(messages: IntelligenceMessage[]): string {
  return messages.map((m) => m.content).join("\n");
}
