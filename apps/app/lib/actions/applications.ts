"use server";

import { markApplicationSubmitted, recordApplicationOutcome } from "@gigpilot/agents";
import { runAction } from "./run";

const PATHS = ["/", "/applications", "/radar", "/radar/[id]", "/jobs"];

export async function markSubmittedAction(applicationId: string, externalRef?: string) {
  const ref = externalRef?.trim().slice(0, 300) || undefined;
  return runAction("app.submitted", (ctx) => markApplicationSubmitted(ctx, applicationId, ref), { revalidate: PATHS, message: "Marked as submitted" });
}

export async function recordOutcomeAction(applicationId: string, outcome: "client_response" | "negotiating" | "won" | "lost") {
  if (!["client_response", "negotiating", "won", "lost"].includes(outcome)) return { ok: false as const, error: "Unknown outcome" };
  return runAction("app.outcome", (ctx) => recordApplicationOutcome(ctx, applicationId, outcome), {
    revalidate: PATHS,
    message: outcome === "won" ? "Marked won — job created, planning queued" : "Outcome recorded",
  });
}
