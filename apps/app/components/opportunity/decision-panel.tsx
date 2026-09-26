"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Bookmark, Check, RotateCcw, X } from "lucide-react";
import { Button, Dialog, DialogContent, Field, StatusDot, Textarea } from "@gigpilot/ui";
import { approvePursuitAction, reanalyseAction, rejectOpportunityAction, shortlistAction } from "@/lib/actions/opportunities";
import type { ActionResult } from "@/lib/actions/types";
import { useAction } from "@/lib/use-action";

export interface DecisionProps {
  oppId: string;
  status: string;
  recommendation: "pursue" | "consider" | "skip" | null;
  estimateComplete: boolean | null;
  proposalStatus: string | null;
  applicationStatus: string | null;
  jobId: string | null;
  layout?: "rail" | "pane";
}

/**
 * Pursuit controls. Available actions follow the opportunity state machine;
 * "Approve pursuit" is the owner gate that lets the Proposal Agent draft.
 */
export function DecisionPanel(p: DecisionProps) {
  const { run, pending } = useAction();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  const s = p.status;
  const canShortlist = s === "analysed" || s === "rejected";
  const canApprove = s === "analysed" || s === "shortlisted";
  const canReject = ["new", "analysed", "shortlisted", "pursuing"].includes(s);
  const canReanalyse = ["new", "analysed", "shortlisted", "rejected"].includes(s);
  const primaryApprove = canApprove && p.recommendation !== "skip";

  const go = <T,>(key: string, fn: () => Promise<ActionResult<T>>) => {
    setBusy(key);
    run(fn, { onSuccess: () => setBusy(null), onError: () => setBusy(null) });
  };

  const stateNote = (() => {
    if (s === "analysing") return { live: true, text: "Opportunity Analyst is working — pricing and gates appear when it finishes." };
    if (s === "new") return { live: false, text: "Queued for analysis." };
    if (s === "pursuing" && !p.proposalStatus) return { live: true, text: "Pursuit approved — the Proposal Agent is drafting." };
    if (s === "pursuing" && p.proposalStatus === "awaiting_approval") return { live: false, text: "Proposal ready — review price, scope and assumptions below." };
    if (s === "pursuing" && p.applicationStatus === "approved") return { live: false, text: "Approved — waiting for submission." };
    if (s === "applied") return { live: false, text: `Application ${p.applicationStatus?.replace(/_/g, " ") ?? "submitted"}.` };
    if (s === "won") return { live: false, text: "Won — production is running as a job." };
    if (s === "lost") return { live: false, text: "Lost. Kept for win-rate learning." };
    if (s === "rejected") return { live: false, text: "Rejected. Shortlist it to reconsider." };
    if (s === "expired") return { live: false, text: "Expired — past the source’s listing window." };
    if (p.recommendation === "skip") return { live: false, text: "Below your business gates — you can still pursue it manually." };
    if (p.estimateComplete === false) return { live: false, text: "Estimate incomplete — decide with caution or re-analyse." };
    return null;
  })();

  return (
    <div className="flex flex-col gap-3">
      {stateNote ? (
        <p className="flex items-start gap-2 text-xs leading-5 text-fg-2">
          <StatusDot tone={stateNote.live ? "info" : "neutral"} live={stateNote.live} className="mt-[7px]" />
          {stateNote.text}
        </p>
      ) : null}

      <div className={p.layout === "pane" ? "flex flex-wrap gap-2" : "grid grid-cols-2 gap-2"}>
        {canApprove ? (
          <Button
            variant={primaryApprove ? "primary" : "secondary"}
            className={p.layout === "pane" ? "" : "col-span-2 h-9"}
            loading={pending && busy === "approve"}
            disabled={pending && busy !== "approve"}
            onClick={() => go("approve", () => approvePursuitAction(p.oppId))}
            data-testid="opp-approve-pursuit"
          >
            <Check className="size-3.5" strokeWidth={2} />
            Approve pursuit
          </Button>
        ) : null}
        {canShortlist ? (
          <Button variant="outline" loading={pending && busy === "shortlist"} disabled={pending && busy !== "shortlist"} onClick={() => go("shortlist", () => shortlistAction(p.oppId))} data-testid="opp-shortlist">
            <Bookmark className="size-3.5" strokeWidth={1.75} />
            {s === "rejected" ? "Restore" : "Shortlist"}
          </Button>
        ) : null}
        {canReject ? (
          <Button variant="outline" disabled={pending} onClick={() => setRejectOpen(true)} data-testid="opp-reject">
            <X className="size-3.5" strokeWidth={1.75} />
            Reject
          </Button>
        ) : null}
        {canReanalyse ? (
          <Button variant="ghost" loading={pending && busy === "reanalyse"} disabled={pending && busy !== "reanalyse"} onClick={() => go("reanalyse", () => reanalyseAction(p.oppId))} data-testid="opp-reanalyse">
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
            Re-analyse
          </Button>
        ) : null}
        {p.jobId ? (
          <Button asChild variant="secondary" className={p.layout === "pane" ? "" : "col-span-2"}>
            <Link href={`/jobs/${p.jobId}`}>
              Open job <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        ) : null}
        {p.applicationStatus && !p.jobId ? (
          <Button asChild variant="ghost" className={p.layout === "pane" ? "" : "col-span-2"}>
            <Link href="/applications">
              View application <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        ) : null}
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent
          size="sm"
          title="Reject this opportunity?"
          description="It leaves the Radar queues. Reasons help the scoring learn what you don’t want."
          footer={
            <>
              <Button variant="ghost" onClick={() => setRejectOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={pending && busy === "reject"}
                onClick={() => {
                  setBusy("reject");
                  run(() => rejectOpportunityAction(p.oppId, reason.trim() || undefined), {
                    onSuccess: () => {
                      setBusy(null);
                      setRejectOpen(false);
                      setReason("");
                    },
                    onError: () => setBusy(null),
                  });
                }}
                data-testid="opp-reject-confirm"
              >
                Reject
              </Button>
            </>
          }
        >
          <Field id="reject-reason" label="Reason (optional)">
            <Textarea id="reject-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not our niche, client history, unrealistic deadline" maxLength={500} />
          </Field>
        </DialogContent>
      </Dialog>
    </div>
  );
}
