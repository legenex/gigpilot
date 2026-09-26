import type { workflowStep } from "@gigpilot/db";

type StepLike = Pick<typeof workflowStep.$inferSelect, "status" | "output">;

/**
 * Step output `blockedReason`s that keep a blocked step parked until the
 * OWNER acts (resumeJob / setJobSpendLimit). Any other blocked step (e.g.
 * waiting for an upstream repair) is unblocked automatically by the engine.
 */
export const OWNER_BLOCK_REASONS = ["budget", "ambiguous_submission", "attempts_exhausted", "repair_limit"] as const;
export type OwnerBlockReason = (typeof OWNER_BLOCK_REASONS)[number];

export function blockedReasonOf(step: Pick<StepLike, "output">): string | null {
  const r = (step.output as Record<string, unknown> | null)?.blockedReason;
  return typeof r === "string" ? r : null;
}

export function isOwnerBlocked(step: StepLike): boolean {
  return step.status === "blocked" && (OWNER_BLOCK_REASONS as readonly string[]).includes(blockedReasonOf(step) ?? "");
}

/** Copy of a step output without the owner-block markers and retry backoff (used when the owner resumes / retries). */
export function clearBlockMarkers(output: unknown): Record<string, unknown> {
  const { blockedReason: _r, blockedAt: _a, resumeRequestedAt: _q, retryBackoffSeconds: _b, ...rest } = (output ?? {}) as Record<string, unknown>;
  return rest;
}
