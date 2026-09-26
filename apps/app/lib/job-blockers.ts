/** Serializable view of `jobBlockers()` for client components (no internal ids beyond step keys). */
export interface JobBlockerView {
  awaitingInputs: boolean;
  canConfirmInputs: boolean;
  /** What the analysis said the client still has to supply. */
  missingInputs: string[];
  blockedSteps: { key: string; name: string; reason: string | null; attempts: number; maxAttempts: number }[];
  repairLimitReached: boolean;
  budgetBlocked: boolean;
  deliveryFailed: boolean;
  canResume: boolean;
  canRequestRevision: boolean;
  /** Highest spend limit the owner may set for this job (operator ceiling). */
  spendCeilingUsd: number;
}

export const BLOCK_REASON_COPY: Record<string, string> = {
  budget: "would exceed the job’s spend limit",
  attempts_exhausted: "used every allowed attempt",
  repair_limit: "hit the repair limit",
  ambiguous_submission: "outcome unclear at the provider — verify before retrying",
};

export function blockReasonText(reason: string | null | undefined): string {
  return (reason && BLOCK_REASON_COPY[reason]) || "is waiting for you";
}

export function hasBlockers(b: JobBlockerView): boolean {
  return b.awaitingInputs || b.blockedSteps.length > 0 || b.repairLimitReached || b.budgetBlocked || b.deliveryFailed;
}

const SHORT_REASON: Record<string, string> = {
  budget: "over the spend limit",
  attempts_exhausted: "out of attempts",
  repair_limit: "at the repair limit",
  ambiguous_submission: "outcome unclear",
};

/** "2 steps paused — out of attempts · over the spend limit" */
export function pausedStepsSummary(count: number, reasons: string[]): string {
  const parts = Array.from(new Set(reasons)).map((r) => SHORT_REASON[r] ?? "waiting for you");
  return `${count} step${count === 1 ? "" : "s"} paused${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}
