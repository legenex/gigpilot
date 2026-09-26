"use client";

import { useState } from "react";
import { Ban, Check, MoreHorizontal, PenLine, Archive } from "lucide-react";
import { Button, Callout, Field, Menu, MenuContent, MenuItem, MenuTrigger, Textarea, formatUsd } from "@gigpilot/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { approveDeliveryAction, cancelJobAction, closeJobAction, requestRevisionAction } from "@/lib/actions/jobs";
import { useAction } from "@/lib/use-action";

export function JobActions({
  jobId,
  status,
  deliveryStatus,
  fileCount,
  qaSummary,
  priceUsd,
  repairsLeft,
}: {
  jobId: string;
  status: string;
  deliveryStatus: string | null;
  fileCount: number;
  qaSummary: string | null;
  priceUsd: number;
  repairsLeft: number;
}) {
  const { run, pending } = useAction();
  const [dialog, setDialog] = useState<"approve" | "revise" | "close" | "cancel" | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const canApprove = status === "awaiting_final_approval" && deliveryStatus === "prepared";
  const canRevise = ["executing", "qa", "awaiting_final_approval", "delivered"].includes(status);
  const canClose = status === "delivered";
  const canCancel = !["delivered", "closed", "cancelled"].includes(status);
  const done = () => setDialog(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canApprove ? (
        <Button variant="primary" onClick={() => setDialog("approve")} data-testid="job-approve-delivery">
          <Check className="size-3.5" strokeWidth={2} />
          Approve final delivery
        </Button>
      ) : null}
      {canRevise ? (
        <Button variant="outline" onClick={() => setDialog("revise")} data-testid="job-request-changes">
          <PenLine className="size-3.5" strokeWidth={1.75} />
          Request changes
        </Button>
      ) : null}
      {canClose ? (
        <Button variant="secondary" onClick={() => setDialog("close")} data-testid="job-close">
          <Archive className="size-3.5" strokeWidth={1.75} />
          Close job
        </Button>
      ) : null}
      {canCancel ? (
        <Menu>
          <MenuTrigger className="grid size-8 place-items-center rounded-sm text-fg-3 ring-1 ring-inset ring-line-strong hover:bg-surface-1 hover:text-fg" aria-label="More job actions">
            <MoreHorizontal className="size-4" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<Ban />} danger onSelect={() => setDialog("cancel")} testId="job-cancel">
              Cancel job…
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}

      <ConfirmDialog
        open={dialog === "approve"}
        onOpenChange={(v) => !v && done()}
        title="Approve final delivery"
        description="This is the final-delivery gate: the package is released and the job moves to Delivered."
        confirmLabel="Approve & release"
        tone="primary"
        loading={pending}
        onConfirm={() => run(() => approveDeliveryAction(jobId), { onSuccess: done })}
      >
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line ring-1 ring-inset ring-line">
          <div className="bg-surface-1 px-3 py-2">
            <dt className="text-[11px] text-fg-3">Files in package</dt>
            <dd className="font-mono text-[15px] font-semibold text-fg">{fileCount}</dd>
          </div>
          <div className="bg-surface-1 px-3 py-2">
            <dt className="text-[11px] text-fg-3">Contract value</dt>
            <dd className="font-mono text-[15px] font-semibold text-fg">{formatUsd(priceUsd)}</dd>
          </div>
        </dl>
        {qaSummary ? (
          <Callout tone="profit" icon={<Check />} className="mt-3">
            {qaSummary}
          </Callout>
        ) : null}
        <p className="mt-3 text-xs leading-5 text-fg-3">Client messages are never sent automatically unless you enabled that in Settings → Autonomy.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "revise"}
        onOpenChange={(v) => {
          if (!v) {
            done();
            setNoteError(null);
          }
        }}
        title="Request changes"
        description={`The Recovery Agent reopens the affected steps within the job’s spend limit (${repairsLeft} repair${repairsLeft === 1 ? "" : "s"} left).`}
        confirmLabel="Send to Recovery Agent"
        loading={pending}
        onConfirm={() => {
          if (note.trim().length < 3) {
            setNoteError("Describe what should change (at least 3 characters).");
            return;
          }
          run(() => requestRevisionAction(jobId, note.trim()), {
            onSuccess: () => {
              done();
              setNote("");
              setNoteError(null);
            },
          });
        }}
      >
        <Field id="revision-note" label="What should change?" error={noteError} hint="Be specific — this becomes the repair brief and a revision record.">
          <Textarea id="revision-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} aria-invalid={!!noteError} data-testid="job-revision-note" />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "close"}
        onOpenChange={(v) => !v && done()}
        title="Close this job?"
        description="Closing archives it from active production. Ledger and assets are kept."
        confirmLabel="Close job"
        loading={pending}
        onConfirm={() => run(() => closeJobAction(jobId), { onSuccess: done })}
      />

      <ConfirmDialog
        open={dialog === "cancel"}
        onOpenChange={(v) => !v && done()}
        title="Cancel this job?"
        description="Stops all pending steps. This can’t be undone; spend so far stays in the ledger."
        confirmLabel="Cancel job"
        tone="danger"
        loading={pending}
        onConfirm={() => run(() => cancelJobAction(jobId), { onSuccess: done })}
      />
    </div>
  );
}
