"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, Pencil, RotateCcw, Send, ShieldCheck, X } from "lucide-react";
import { Button, Callout, Dialog, DialogContent, Field, Input, StatusDot, Textarea, cn, formatUsd } from "@gigpilot/ui";
import { approveProposalAction, rejectProposalAction, requestProposalAction, updateProposalAction } from "@/lib/actions/opportunities";
import { useAction } from "@/lib/use-action";

export interface ProposalView {
  id: string;
  status: string;
  headline: string;
  coverLetter: string;
  scope: { item: string; detail?: string }[];
  priceUsd: number;
  timelineDays: number;
  assumptions: string[];
  questions: string[];
  provider: string;
  model: string;
  version: number;
  approvedAt: string | null;
}

const STATUS_LABEL: Record<string, { label: string; tone: "accent" | "profit" | "risk" | "neutral" }> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting your approval", tone: "accent" },
  approved: { label: "Approved", tone: "profit" },
  rejected: { label: "Rejected", tone: "risk" },
  superseded: { label: "Superseded", tone: "neutral" },
};

/**
 * Proposal draft + commercial-commitment gate. Editable until approved;
 * approval shows exactly what is being committed and how it will be submitted.
 */
export function ProposalPanel({
  proposal,
  oppId,
  oppStatus,
  sourceName,
  autoSubmit,
  compliance,
  compact,
}: {
  proposal: ProposalView | null;
  oppId: string;
  oppStatus: string;
  sourceName: string;
  autoSubmit: boolean;
  compliance: string | null;
  compact?: boolean;
}) {
  const { run, pending } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => ({
    headline: proposal?.headline ?? "",
    coverLetter: proposal?.coverLetter ?? "",
    priceUsd: String(proposal?.priceUsd ?? ""),
    timelineDays: String(proposal?.timelineDays ?? ""),
    assumptions: (proposal?.assumptions ?? []).join("\n"),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!proposal) {
    const drafting = oppStatus === "pursuing";
    return (
      <div data-testid="proposal-panel" data-status="none" className="rounded-md p-3 ring-1 ring-inset ring-line">
        <p className="flex items-center gap-2 text-[13px] text-fg-2">
          <StatusDot tone={drafting ? "info" : "neutral"} live={drafting} />
          {drafting ? "Proposal Agent is drafting a tailored proposal…" : "No proposal yet. Approve pursuit and the Proposal Agent drafts one for your review."}
        </p>
        {drafting ? (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            loading={pending}
            onClick={() => run(() => requestProposalAction(oppId))}
          >
            <RotateCcw className="size-3.5" /> Request again
          </Button>
        ) : null}
      </div>
    );
  }

  const editable = proposal.status === "draft" || proposal.status === "awaiting_approval";
  const canApprove = proposal.status === "awaiting_approval";
  const st = STATUS_LABEL[proposal.status] ?? STATUS_LABEL.draft!;

  const save = () => {
    const e: Record<string, string> = {};
    const price = Number(draft.priceUsd);
    const days = Number(draft.timelineDays);
    if (draft.headline.trim().length < 3) e.headline = "Add a headline (3+ characters).";
    if (draft.coverLetter.trim().length < 40) e.coverLetter = "Cover letter needs at least 40 characters.";
    if (!Number.isFinite(price) || price < 1) e.priceUsd = "Enter a price of at least $1.";
    if (!Number.isInteger(days) || days < 1 || days > 365) e.timelineDays = "Whole days between 1 and 365.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy("save");
    run(
      () =>
        updateProposalAction(proposal.id, {
          headline: draft.headline.trim(),
          coverLetter: draft.coverLetter.trim(),
          priceUsd: price,
          timelineDays: days,
          assumptions: draft.assumptions
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      {
        onSuccess: () => {
          setBusy(null);
          setEditing(false);
        },
        onError: () => setBusy(null),
      },
    );
  };

  return (
    <div data-testid="proposal-panel" data-status={proposal.status} className={cn("rounded-md ring-1 ring-inset", canApprove ? "ring-accent-line" : "ring-line")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3.5 py-2.5">
        <span className={cn("flex items-center gap-1.5 text-xs font-medium", st.tone === "accent" ? "text-accent-hi" : st.tone === "profit" ? "text-profit" : st.tone === "risk" ? "text-risk" : "text-fg-2")}>
          <StatusDot tone={st.tone} />
          {st.label}
        </span>
        <span className="font-mono text-[11px] text-fg-3">
          v{proposal.version} · {proposal.provider}/{proposal.model}
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <span data-testid="proposal-price" className="font-mono text-[15px] font-semibold tabular text-fg">
            {formatUsd(proposal.priceUsd)}
          </span>
          <span className="font-mono text-xs text-fg-3">{proposal.timelineDays}d</span>
        </span>
      </div>

      {editing ? (
        <div className="grid gap-3 p-3.5 sm:grid-cols-[1fr_120px_110px]">
          <Field id="p-headline" label="Headline" error={errors.headline} className="sm:col-span-3">
            <Input id="p-headline" value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} maxLength={300} aria-invalid={!!errors.headline} />
          </Field>
          <Field id="p-cover" label="Cover letter" error={errors.coverLetter} className="sm:col-span-3">
            <Textarea id="p-cover" rows={9} value={draft.coverLetter} onChange={(e) => setDraft({ ...draft, coverLetter: e.target.value })} maxLength={12000} aria-invalid={!!errors.coverLetter} />
          </Field>
          <Field id="p-assumptions" label="Assumptions (one per line)" className="sm:col-span-1">
            <Textarea id="p-assumptions" rows={4} value={draft.assumptions} onChange={(e) => setDraft({ ...draft, assumptions: e.target.value })} />
          </Field>
          <Field id="p-price" label="Price" error={errors.priceUsd}>
            <Input id="p-price" type="number" min={1} prefix="$" value={draft.priceUsd} onChange={(e) => setDraft({ ...draft, priceUsd: e.target.value })} aria-invalid={!!errors.priceUsd} />
          </Field>
          <Field id="p-days" label="Timeline" error={errors.timelineDays}>
            <Input id="p-days" type="number" min={1} max={365} suffix="days" value={draft.timelineDays} onChange={(e) => setDraft({ ...draft, timelineDays: e.target.value })} aria-invalid={!!errors.timelineDays} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-3">
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={save} loading={pending && busy === "save"}>
              Save draft
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-3.5">
          <p className="text-[13px] font-medium text-fg">{proposal.headline}</p>
          <p className={cn("mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-fg-2", compact && "line-clamp-4")}>{proposal.coverLetter}</p>
          {!compact ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-fg-3">Scope</p>
                <ul className="space-y-0.5 text-[13px] text-fg-2">
                  {proposal.scope.map((s, i) => (
                    <li key={i}>
                      {s.item}
                      {s.detail ? <span className="ml-1.5 font-mono text-[11px] text-fg-3">{s.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-xs text-fg-3">Assumptions</p>
                <ul className="space-y-0.5 text-[13px] text-fg-2">
                  {proposal.assumptions.length ? proposal.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li className="text-fg-3">None stated</li>}
                </ul>
                {proposal.questions.length ? (
                  <>
                    <p className="mb-1 mt-3 text-xs text-fg-3">Questions for the client</p>
                    <ul className="space-y-0.5 text-[13px] text-fg-2">
                      {proposal.questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {editable || canApprove ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {canApprove ? (
                <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={pending} data-testid="proposal-approve">
                  <Check className="size-3.5" strokeWidth={2} />
                  Approve proposal
                </Button>
              ) : null}
              {canApprove ? (
                <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={pending} data-testid="proposal-reject">
                  <X className="size-3.5" strokeWidth={1.75} />
                  Reject
                </Button>
              ) : null}
              {editable ? (
                compact ? (
                  <Button asChild variant="ghost">
                    <Link href={`/radar/${oppId}#proposal`}>
                      <Pencil className="size-3.5" strokeWidth={1.75} /> Edit draft
                    </Link>
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => setEditing(true)} disabled={pending} data-testid="proposal-edit">
                    <Pencil className="size-3.5" strokeWidth={1.75} /> Edit draft
                  </Button>
                )
              ) : null}
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-3">
                {autoSubmit ? <Send className="size-3" /> : <ShieldCheck className="size-3" />}
                {autoSubmit ? `Auto-submits to ${sourceName} after approval` : `Manual submission on ${sourceName}`}
              </span>
            </div>
          ) : proposal.status === "rejected" ? (
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
              <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => requestProposalAction(oppId))}>
                <RotateCcw className="size-3.5" /> Request new draft
              </Button>
            </div>
          ) : proposal.status === "approved" ? (
            <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 text-xs text-fg-3">
              <Check className="size-3.5 text-profit" /> Commitment approved{proposal.approvedAt ? ` ${new Date(proposal.approvedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}.{" "}
              <Link href="/applications" className="inline-flex items-center gap-0.5 text-fg-2 hover:text-fg">
                Track in Applications <ArrowRight className="size-3" />
              </Link>
            </p>
          ) : null}
        </div>
      )}

      {/* Commercial commitment confirmation */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent
          size="md"
          title="Approve commercial commitment"
          description="You are approving the price, scope and assumptions below. GigPilot never submits or commits without this approval."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={pending && busy === "approve"}
                onClick={() => {
                  setBusy("approve");
                  run(() => approveProposalAction(proposal.id), {
                    onSuccess: () => {
                      setBusy(null);
                      setConfirmOpen(false);
                    },
                    onError: () => setBusy(null),
                  });
                }}
                data-testid="proposal-approve-confirm"
              >
                Approve &amp; commit at {formatUsd(proposal.priceUsd)}
              </Button>
            </>
          }
        >
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line ring-1 ring-inset ring-line">
            <div className="bg-surface-1 px-3 py-2.5">
              <dt className="text-[11px] text-fg-3">Price</dt>
              <dd className="font-mono text-[18px] font-semibold tabular text-fg">{formatUsd(proposal.priceUsd)}</dd>
            </div>
            <div className="bg-surface-1 px-3 py-2.5">
              <dt className="text-[11px] text-fg-3">Timeline</dt>
              <dd className="font-mono text-[18px] font-semibold tabular text-fg">{proposal.timelineDays} days</dd>
            </div>
          </dl>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-fg-3">Scope</p>
              <ul className="space-y-0.5 text-[13px] text-fg">
                {proposal.scope.map((s, i) => (
                  <li key={i}>{s.item}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs text-fg-3">Assumptions</p>
              <ul className="space-y-0.5 text-[13px] text-fg-2">
                {proposal.assumptions.length ? proposal.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li className="text-fg-3">None</li>}
              </ul>
            </div>
          </div>
          <Callout tone={autoSubmit ? "info" : "neutral"} icon={autoSubmit ? <Send /> : <ShieldCheck />} title={autoSubmit ? "Submission: automatic" : "Submission: manual"} className="mt-4">
            {autoSubmit
              ? `${sourceName} officially permits programmatic submission, and your autonomy settings allow it. GigPilot submits right after approval (idempotent — never twice).`
              : `${sourceName} doesn’t permit automated proposals${compliance ? ` (${compliance})` : ""}. GigPilot prepares the text; you paste it on ${sourceName} and mark it submitted in Applications.`}
          </Callout>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent
          size="sm"
          title="Reject this proposal?"
          description="Nothing is sent. You can request a new draft afterwards."
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
                  run(() => rejectProposalAction(proposal.id, reason.trim() || undefined), {
                    onSuccess: () => {
                      setBusy(null);
                      setRejectOpen(false);
                    },
                    onError: () => setBusy(null),
                  });
                }}
                data-testid="proposal-reject-confirm"
              >
                Reject proposal
              </Button>
            </>
          }
        >
          <Field id="proposal-reject-reason" label="What should change? (optional)">
            <Textarea id="proposal-reject-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </DialogContent>
      </Dialog>
    </div>
  );
}
