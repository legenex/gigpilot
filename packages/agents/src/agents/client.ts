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

export function deterministicDeliveryNotes(input: {
  job: Pick<JobRow, "title" | "serviceFamily">;
  clientName: string | null;
  files: { filename: string; description?: string }[];
  qaSummary: string;
  repairs: number;
  analysis: OpportunityAnalysis | null;
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
      `Quality: every file was checked independently against the brief before packaging (${input.qaSummary}).`,
      input.repairs > 0 ? `During production ${input.repairs} issue${input.repairs === 1 ? " was" : "s were"} caught by QA and fixed before delivery.` : "",
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
          "Draft a concise, friendly delivery note to a freelance client. Mention what is included and how quality was checked. No invented facts; keep every fact (file names, QA results, test status) exactly as in the draft. Return JSON {subject, message}.",
      },
      { role: "user", content: `Rewrite this draft:\n${wrapUntrusted("draft delivery note", fallback.message)}` },
    ],
    mockResult: () => fallback,
  });
  const out = res.data ?? fallback;
  return { ...out, provider: res.family, model: res.model };
}

export function deterministicQuestions(analysis: OpportunityAnalysis | null, title: string): ClientMessage | null {
  if (!analysis || analysis.missingInputs.length === 0) return null;
  return {
    subject: `Quick questions before we start: ${title}`.slice(0, 180),
    message: ["Hi,", "", "To start production on schedule we need:", ...analysis.missingInputs.map((m) => `- ${m}`), "", "Thanks — as soon as these land, work begins."].join("\n"),
  };
}
