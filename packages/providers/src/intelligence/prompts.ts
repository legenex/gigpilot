import type { z } from "zod";
import {
  capabilitySchema,
  inferenceEstimateSchema,
  marketInsightSchema,
  opportunityAnalysisSchema,
  proposalDraftSchema,
  qaVerdictSchema,
  riskSchema,
  workflowStepPlanSchema,
} from "@gigpilot/contracts";

/**
 * Prompt text used by the intelligence adapters. Kept in one readable file so
 * prompt tuning never requires touching transport code.
 *
 * Adapters add STRUCTURED_OUTPUT_RULES + the JSON Schema (derived from the
 * zod schema) + a schema-specific guide (below) to the system prompt whenever
 * a request carries `schema`. Enumerations are read from @gigpilot/contracts
 * so prompts can never drift from validation.
 */

const CAPABILITIES = capabilitySchema.options.join(", ");
const STEP_KINDS = workflowStepPlanSchema.shape.kind.options.join(", ");
const RISK_KINDS = riskSchema.shape.kind.options.join(", ");
const FAMILIES = inferenceEstimateSchema.shape.family.options.join(", ");

export const STRUCTURED_OUTPUT_RULES = [
  "OUTPUT FORMAT — mandatory:",
  "- Reply with exactly ONE JSON object that validates against the JSON Schema below.",
  "- No markdown fences, no prose before or after, no comments inside the JSON.",
  "- Include every property listed in the schema's `required` arrays; use [] for empty lists and null only where the schema allows null.",
  "- Numbers must be JSON numbers (not strings). Enum fields must use one of the listed values verbatim.",
  "- Keep strings concise and factual. Never include chain-of-thought; rationale fields are short user-facing reasons.",
].join("\n");

export const OPPORTUNITY_ANALYSIS_GUIDE = [
  "You are GigPilot's Opportunity Analyst. You read one freelance opportunity and estimate what delivering it would take.",
  "GigPilot prices work deterministically from YOUR QUANTITIES — so never output prices, rates or money amounts anywhere.",
  "",
  "Field guidance:",
  "- summary: one sentence. clientRequest: what the client literally asked for. serviceFamily: short slug such as ugc_video, product_photos, ai_automation, web_app, copywriting, translation, research.",
  "- deliverables: one entry per distinct output; quantity is a count; format e.g. \"9:16 MP4, 15s\".",
  "- suppliedAssets = what the client provides; requiredAssets = what the work needs; missingInputs = required but not supplied yet.",
  `- risks[].kind ∈ {${RISK_KINDS}}; severity ∈ {low, medium, high}; note ≤ 20 words.`,
  "- deadlineDays: days until delivery if stated or clearly implied, else null.",
  "",
  "productionEstimates — one entry per generated/produced unit type:",
  `- capability ∈ {${CAPABILITIES}}.`,
  "- Use image.* / video.* only for AI-generated media; text.copy for scripts/captions/copy; code.build / code.automation for software; media.finishing for editing, captions, music, assembly; qa.review for checking.",
  "- units = number of deliverable units (images, clips, pages, scripts). For VIDEO only, put the clip length in seconds in the label, e.g. \"9:16 UGC video 15s\" (GigPilot reads the \"15s\"). Never add a seconds suffix to images or other outputs (\"Product photo 2000x2000\", not \"… 2000s\").",
  "- One entry per deliverable type: never split a stated range into several entries — use the upper bound (\"3 videos of 15–20s\" → ONE entry, units 3, label \"… 20s\").",
  "- attemptsPerUnit ≥ 1 = expected generations per usable result (typical: images 1.3–2, AI video 2–3, copy/code 1–1.5).",
  "- Do not add entries for QA/review (covered by the workflow) and add image.upscale only when the client explicitly needs a higher resolution than generation provides.",
  "- providerHint: leave the key OUT entirely unless the brief names a specific tool (e.g. \"n8n\"). Never write \"\", \"n/a\", \"none\" or an intelligence family (gx/factory/grok).",
  "",
  "inferenceEstimates — LLM calls GigPilot will make (planning, scripts, code, QA):",
  `- family ∈ {${FAMILIES}}: gx = cheap local model (extraction, triage, captions, first-pass QA); factory = strong reasoning/coding; grok = live web/market research only.`,
  "- kTokensIn / kTokensOut are THOUSANDS of tokens PER CALL (typical: kTokensIn 2–15, kTokensOut 0.5–4). calls = number of calls.",
  "",
  "- humanHours: owner time for review and client communication (typically 0.5–4). billableHours: hours to price HOURLY jobs, else null.",
  "",
  "proposedWorkflow — ordered execution steps (3–8 steps):",
  "- key: unique, lowercase [a-z0-9_-] only, e.g. brief, scripts, gen_video, assemble, qa, deliver.",
  `- kind ∈ {${STEP_KINDS}}. Use generate only for AI image/video/audio generation; software work uses code and test; writing uses copy.`,
  "- agent: who runs it — one of planner, researcher, copywriter, creative, editor, engineer, qa, owner.",
  "- capability (optional) uses the same list as productionEstimates; estimateLabel repeats the matching productionEstimates label exactly.",
  "- dependsOn: keys of EARLIER steps only. acceptance: 1–3 checkable criteria.",
  "- Always include a qa step before finalize/deliver.",
  "",
  "Scores are numbers in [0,1]: fitScore (how well AI-assisted production fits), complexity, revisionRisk, deadlineRisk, confidence (in this analysis).",
  "rationale: 2–5 short user-visible reasons. buyerPriorities: what the client cares about most (2–4 items).",
].join("\n");

export const PROPOSAL_GUIDE = [
  "You draft a freelance proposal for the owner to review (it is never sent automatically).",
  "- headline: ≤ 12 words. coverLetter: 120–250 words, specific to the brief, plain text, no placeholders like [Name], no contact details, no links.",
  "- scope: concrete items the price covers. priceUsd and timelineDays: use the values supplied by GigPilot in the prompt — do not invent your own numbers.",
  "- assumptions: what the price assumes. questions: 1–3 clarifying questions for the client.",
].join("\n");

export const QA_GUIDE = [
  "You are an independent QA reviewer. Judge the deliverable strictly against the acceptance criteria provided.",
  "- verdict is \"pass\" only if no major or critical finding exists. score in [0,1].",
  "- findings[].code: short snake_case id; severity ∈ {minor, major, critical}; criterion names the acceptance criterion; repairHint says how to fix it.",
  "- summary: one or two sentences.",
].join("\n");

export const MARKET_INSIGHT_GUIDE = [
  "You analyse freelance market signals for GigPilot's Market Lab.",
  "- recommendations[].marketKey must be one of the market keys provided in the prompt; action ∈ {increase, decrease, hold, enable, disable}; fromPct/toPct are allocation percentages 0–100.",
  "- signals: short label/value pairs with an optional trend (up, down, flat). Cite only facts present in the provided data or your search results.",
].join("\n");

const GUIDES = new Map<z.ZodType, { name: string; guide: string }>([
  [opportunityAnalysisSchema, { name: "OpportunityAnalysis", guide: OPPORTUNITY_ANALYSIS_GUIDE }],
  [proposalDraftSchema, { name: "ProposalDraft", guide: PROPOSAL_GUIDE }],
  [qaVerdictSchema, { name: "QAVerdict", guide: QA_GUIDE }],
  [marketInsightSchema, { name: "MarketInsight", guide: MARKET_INSIGHT_GUIDE }],
]);

const GUIDES_BY_NAME = new Map<string, string>([...GUIDES.values()].map((g) => [g.name.toLowerCase(), g.guide]));

/** Schema-specific guidance, matched by schema identity first, then by schemaName. */
export function schemaGuide(schema: z.ZodType | undefined, schemaName: string | undefined): string | undefined {
  if (schema) {
    const g = GUIDES.get(schema);
    if (g) return g.guide;
  }
  if (schemaName) return GUIDES_BY_NAME.get(schemaName.toLowerCase().replace(/[^a-z]/g, ""));
  return undefined;
}

/** Canonical schema name for logging / structured output naming. */
export function schemaNameFor(schema: z.ZodType | undefined, schemaName: string | undefined): string {
  if (schemaName) return schemaName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "Result";
  if (schema) {
    const g = GUIDES.get(schema);
    if (g) return g.name;
  }
  return "Result";
}

const EMPTY_HINT = /^(|n\/?a|none|null|unknown|any|gx|factory|grok|-)$/i;

/**
 * Schema-specific clean-up applied to parsed JSON BEFORE zod validation.
 * Only removes obviously-empty optional values models like to emit; never
 * invents data.
 */
export function normalizeStructured(schema: z.ZodType | undefined, value: unknown): unknown {
  if (schema !== opportunityAnalysisSchema || !value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const cleanOptionalString = (o: Record<string, unknown>, key: string, re: RegExp) => {
    if (key in o && (o[key] === null || (typeof o[key] === "string" && re.test((o[key] as string).trim())))) delete o[key];
  };
  if (Array.isArray(v.productionEstimates)) for (const e of v.productionEstimates) if (e && typeof e === "object") cleanOptionalString(e as Record<string, unknown>, "providerHint", EMPTY_HINT);
  if (Array.isArray(v.deliverables)) for (const d of v.deliverables) if (d && typeof d === "object") cleanOptionalString(d as Record<string, unknown>, "format", /^(|n\/?a|none|null)$/i);
  if (Array.isArray(v.proposedWorkflow)) {
    for (const st of v.proposedWorkflow) {
      if (!st || typeof st !== "object") continue;
      const step = st as Record<string, unknown>;
      cleanOptionalString(step, "capability", /^(|n\/?a|none|null)$/i);
      cleanOptionalString(step, "estimateLabel", /^(|n\/?a|none|null)$/i);
    }
  }
  return v;
}

/** System prompt block appended for structured requests. */
export function structuredSystemPrompt(schemaName: string, jsonSchema: Record<string, unknown>, guide?: string): string {
  return [guide, STRUCTURED_OUTPUT_RULES, `JSON Schema for ${schemaName}:`, JSON.stringify(jsonSchema)].filter(Boolean).join("\n\n");
}

/**
 * Convenience user message for opportunity analysis. The Opportunity Analyst
 * agent may use this or build its own; the adapter adds the guide either way.
 */
export function opportunityAnalysisUserPrompt(opp: {
  title: string;
  description: string;
  budgetType?: string;
  budgetMinUsd?: number;
  budgetMaxUsd?: number;
  skills?: string[];
  clientCountry?: string;
  postedAt?: string;
  deadlineAt?: string;
  sourceKey?: string;
}): string {
  const budget =
    opp.budgetMinUsd !== undefined || opp.budgetMaxUsd !== undefined
      ? `${opp.budgetType ?? "unknown"} ${opp.budgetMinUsd ?? "?"}–${opp.budgetMaxUsd ?? "?"} USD`
      : `${opp.budgetType ?? "unknown"} (no amount stated)`;
  return [
    "Analyse this opportunity.",
    `Source: ${opp.sourceKey ?? "unknown"}`,
    `Title: ${opp.title}`,
    `Budget: ${budget}`,
    opp.skills?.length ? `Skills: ${opp.skills.join(", ")}` : undefined,
    opp.clientCountry ? `Client country: ${opp.clientCountry}` : undefined,
    opp.postedAt ? `Posted: ${opp.postedAt}` : undefined,
    opp.deadlineAt ? `Deadline: ${opp.deadlineAt}` : undefined,
    "Description:",
    opp.description.slice(0, 12_000),
  ]
    .filter(Boolean)
    .join("\n");
}
