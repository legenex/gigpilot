import { z } from "zod";

/**
 * Structured opportunity analysis. Produced by the Opportunity Analyst (LLM or
 * deterministic mock) and validated with this schema. LLMs estimate
 * QUANTITIES only — prices come from the deterministic price catalog.
 */

export const capabilitySchema = z.enum([
  "image.generate",
  "image.edit",
  "image.upscale",
  "video.generate",
  "video.image_to_video",
  "audio.voiceover",
  "audio.dub",
  "text.copy",
  "text.translate",
  "text.research",
  "code.build",
  "code.automation",
  "media.finishing",
  "qa.review",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const productionEstimateSchema = z.object({
  /** What a unit of output is, e.g. "9:16 UGC video (15s)". */
  label: z.string().min(1),
  capability: capabilitySchema,
  /** Deliverable units required. */
  units: z.number().min(0),
  /** Expected attempts per usable unit (>= 1). */
  attemptsPerUnit: z.number().min(1).max(20),
  /** Optional preferred provider/model hint; the broker decides the route. */
  providerHint: z.string().optional(),
});
export type ProductionEstimate = z.infer<typeof productionEstimateSchema>;

export const inferenceEstimateSchema = z.object({
  task: z.string(),
  family: z.enum(["factory", "gx", "grok"]),
  /** Approximate input/output tokens in thousands. */
  kTokensIn: z.number().min(0),
  kTokensOut: z.number().min(0),
  calls: z.number().min(0),
});
export type InferenceEstimate = z.infer<typeof inferenceEstimateSchema>;

export const workflowStepPlanSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  kind: z.enum([
    "brief",
    "research",
    "concepts",
    "copy",
    "generate",
    "assemble",
    "translate",
    "code",
    "test",
    "review",
    "qa",
    "finalize",
    "deliver",
  ]),
  agent: z.string(),
  capability: capabilitySchema.optional(),
  dependsOn: z.array(z.string()).default([]),
  /** Estimate index this step consumes (links to productionEstimates). */
  estimateLabel: z.string().optional(),
  acceptance: z.array(z.string()).default([]),
});
export type WorkflowStepPlan = z.infer<typeof workflowStepPlanSchema>;

export const riskSchema = z.object({
  kind: z.enum(["scope", "revision", "deadline", "client", "technical", "compliance", "payment", "input"]),
  severity: z.enum(["low", "medium", "high"]),
  note: z.string(),
});

export const opportunityAnalysisSchema = z.object({
  summary: z.string().min(1),
  clientRequest: z.string(),
  serviceFamily: z.string(),
  deliverables: z.array(z.object({ item: z.string(), quantity: z.number().min(0).default(1), format: z.string().optional() })),
  suppliedAssets: z.array(z.string()).default([]),
  requiredAssets: z.array(z.string()).default([]),
  missingInputs: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  risks: z.array(riskSchema).default([]),
  deadlineDays: z.number().min(0).nullable().default(null),
  productionEstimates: z.array(productionEstimateSchema).default([]),
  inferenceEstimates: z.array(inferenceEstimateSchema).default([]),
  /** Owner/operator hours (review, client comms) — valued at shadow rate. */
  humanHours: z.number().min(0).default(1),
  /** Hours used to price hourly opportunities. */
  billableHours: z.number().min(0).nullable().default(null),
  proposedWorkflow: z.array(workflowStepPlanSchema).default([]),
  fitScore: z.number().min(0).max(1),
  complexity: z.number().min(0).max(1),
  revisionRisk: z.number().min(0).max(1),
  deadlineRisk: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  /** Concise, user-visible decision rationale (never chain-of-thought). */
  rationale: z.array(z.string()).default([]),
  buyerPriorities: z.array(z.string()).default([]),
});
export type OpportunityAnalysis = z.infer<typeof opportunityAnalysisSchema>;

export const proposalDraftSchema = z.object({
  headline: z.string(),
  coverLetter: z.string().min(40),
  scope: z.array(z.object({ item: z.string(), detail: z.string().optional() })),
  priceUsd: z.number().min(0),
  timelineDays: z.number().min(0),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
});
export type ProposalDraft = z.infer<typeof proposalDraftSchema>;

export const qaFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["minor", "major", "critical"]),
  message: z.string(),
  criterion: z.string().optional(),
  repairHint: z.string().optional(),
});
export type QAFinding = z.infer<typeof qaFindingSchema>;

export const qaVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  score: z.number().min(0).max(1),
  findings: z.array(qaFindingSchema).default([]),
  summary: z.string(),
});
export type QAVerdict = z.infer<typeof qaVerdictSchema>;

export const marketInsightSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  recommendations: z.array(
    z.object({
      marketKey: z.string(),
      action: z.enum(["increase", "decrease", "hold", "enable", "disable"]),
      fromPct: z.number().min(0).max(100).optional(),
      toPct: z.number().min(0).max(100).optional(),
      reason: z.string(),
    }),
  ),
  signals: z.array(z.object({ label: z.string(), value: z.string(), trend: z.enum(["up", "down", "flat"]).optional() })).default([]),
});
export type MarketInsight = z.infer<typeof marketInsightSchema>;
