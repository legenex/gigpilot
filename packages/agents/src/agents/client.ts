import { z } from "zod";
import type { OpportunityAnalysis } from "@gigpilot/contracts";
import { wrapUntrusted } from "@gigpilot/providers";
import { familyLabel } from "../lib/util";
import { callIntelligence, type JobRow, type RunContext } from "../runtime";

/**
 * Client Agent. Drafts client-facing messages (delivery notes, progress
 * updates, questions). Drafts only — GigPilot never sends anything to a
 * client unless the tenant explicitly enables autoSendClientMessages, and
 * there is no external send path in V1.
 */

export const clientMessageSchema = z.object({ subject: z.string().min(3), message: z.string().min(40) });
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** What QA actually established — the only quality facts delivery notes may state. */
export interface DeliveryVerification {
  /** Checked deterministically (file headers, counts, sections, feature evidence …). */
  verified: string[];
  /** Model review passes: "<step>: <provider/model> — <independence label>". */
  reviewed: string[];
  /** Explicitly NOT verified (tests not executed, no web research, quality targets …). */
  notVerified: string[];
  /** A simulated demo defect was injected and repaired (demo workspaces only). */
  demoDefectRepaired: boolean;
}

/** Deterministic "what was checked" block appended to delivery notes (never rewritten by a model). */
export function verificationBlock(v: DeliveryVerification): string {
  const lines = ["What was checked", ""];
  lines.push("Verified deterministically:", ...(v.verified.length ? v.verified.slice(0, 12).map((x) => `- ${x}`) : ["- (nothing could be verified deterministically)"]));
  lines.push("", "Checked by model review:", ...(v.reviewed.length ? v.reviewed.slice(0, 12).map((x) => `- ${x}`) : ["- none (no model reviewed this delivery)"]));
  lines.push("", "Not verified:", ...(v.notVerified.length ? [...new Set(v.notVerified)].slice(0, 12).map((x) => `- ${x}`) : ["- nothing else outstanding"]));
  if (v.demoDefectRepaired) lines.push("", "Demo note: a simulated defect was injected (demo mode) and repaired before packaging.");
  return lines.join("\n");
}

/** Claims a delivery note may never make unless verified (tests are never executed here). */
const UNVERIFIED_CLAIM = /\b\d+\s*(?:\/\s*\d+\s*)?(tests?|checks?)\s+(are\s+)?(pass|passing|passed|green)\b|\ball\s+tests\s+(pass|passed|are passing)\b|\bfully tested\b|\btests?\s+(are\s+)?passing\b|\bindependent(ly)?\s+(verified|checked|reviewed|tested)\b|\bguarantee/i;

export function hasUnverifiedClaim(text: string): boolean {
  return UNVERIFIED_CLAIM.test(text);
}

export function deterministicDeliveryNotes(input: {
  job: Pick<JobRow, "title" | "serviceFamily">;
  clientName: string | null;
  files: { filename: string; description?: string }[];
  qaSummary: string;
  repairs: number;
  analysis: OpportunityAnalysis | null;
  verification?: DeliveryVerification;
}): ClientMessage {
  const greeting = input.clientName ? `Hi ${input.clientName} team,` : "Hi,";
  const list = input.files
    .filter((f) => !/^(MANIFEST|DELIVERY-NOTES|QA-SUMMARY)/.test(f.filename))
    .slice(0, 12)
    .map((f) => `- ${f.filename}${f.description ? ` — ${f.description}` : ""}`);
  const extra = input.files.length > 12 ? [`- …and ${input.files.length - 12} more (see MANIFEST.md)`] : [];
  const next =
    input.job.serviceFamily === "ai-automation" || input.job.serviceFamily === "web-app-builds"
      ? "Setup takes about 15 minutes with the README; I'm happy to walk your team through it on a short call."
      : "Send any feedback in one consolidated round and I'll turn it around quickly.";
  return {
    subject: `Delivery: ${input.job.title}`.slice(0, 180),
    message: [
      greeting,
      "",
      `Your ${familyLabel(input.job.serviceFamily).toLowerCase()} delivery for “${input.job.title}” is ready. The package contains:`,
      ...list,
      ...extra,
      "",
      `Quality checks: ${input.qaSummary}. What was and was not verified is listed below and in QA-SUMMARY.md.`,
      input.verification?.demoDefectRepaired
        ? "Demo note: a simulated defect was injected (demo mode) and repaired before packaging."
        : input.repairs > 0
          ? `During production ${input.repairs} issue${input.repairs === 1 ? " was" : "s were"} caught by QA and fixed before delivery.`
          : "",
      "",
      next,
      "",
      "Thanks!",
    ]
      .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
      .join("\n"),
  };
}

export async function draftDeliveryNotes(ctx: RunContext, input: Parameters<typeof deterministicDeliveryNotes>[0]): Promise<ClientMessage & { provider: string; model: string }> {
  const fallback = deterministicDeliveryNotes(input);
  const res = await callIntelligence(ctx, {
    task: "client_message",
    schema: clientMessageSchema,
    schemaName: "client_message",
    maxOutputTokens: 700,
    messages: [
      {
        role: "system",
        content:
          "Draft a concise, friendly delivery note to a freelance client. Mention what is included. State ONLY the quality facts in the draft, exactly as written — never claim tests passed, never call a review independent unless the draft does, never add guarantees. Return JSON {subject, message}.",
      },
      { role: "user", content: `Rewrite this draft:\n${wrapUntrusted("draft delivery note", fallback.message)}` },
    ],
    mockResult: () => fallback,
  });
  // A rewrite that adds unverified claims is discarded in favour of the deterministic draft.
  const rewritten = res.data && !hasUnverifiedClaim(res.data.message) ? res.data : fallback;
  const message = input.verification ? `${rewritten.message}\n\n${verificationBlock(input.verification)}` : rewritten.message;
  return { ...rewritten, message, provider: res.family, model: res.model };
}

export function deterministicQuestions(analysis: OpportunityAnalysis | null, title: string): ClientMessage | null {
  if (!analysis || analysis.missingInputs.length === 0) return null;
  return {
    subject: `Quick questions before we start: ${title}`.slice(0, 180),
    message: ["Hi,", "", "To start production on schedule we need:", ...analysis.missingInputs.map((m) => `- ${m}`), "", "Thanks — as soon as these land, work begins."].join("\n"),
  };
}
