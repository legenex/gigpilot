"use client";

import { useState } from "react";
import { CirclePause, ClipboardCheck, Play } from "lucide-react";
import { Button, Field, Textarea, formatUsd } from "@gigpilot/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { confirmInputsAction, resumeJobAction } from "@/lib/actions/jobs";
import { blockReasonText, hasBlockers, type JobBlockerView } from "@/lib/job-blockers";
import { useAction } from "@/lib/use-action";

/**
 * Owner controls for dead-end job states: awaiting inputs, owner-blocked
 * steps (attempts exhausted / ambiguous outcome / budget) and the repair
 * limit. The single accent moment on the job page when present.
 */
export function JobBlockers({ jobId, blockers, canManage, spendLimitUsd, actualCostUsd }: { jobId: string; blockers: JobBlockerView; canManage: boolean; spendLimitUsd: number; actualCostUsd: number }) {
  const { run, pending } = useAction();
  const [dialog, setDialog] = useState<"inputs" | "resume" | null>(null);
  const [note, setNote] = useState("");
  if (!hasBlockers(blockers)) return null;

  // One more attempt per reopened step; one more repair when the repair limit stopped QA.
  const grant = { extraAttempts: 1, extraRepairs: blockers.repairLimitReached ? 1 : 0 };

  return (
    <section aria-labelledby="job-blockers-title" className="relative mb-5 overflow-hidden rounded-md bg-[linear-gradient(90deg,rgba(255,107,44,0.075),rgba(255,107,44,0.015)_38%,transparent_70%)] ring-1 ring-inset ring-line" data-testid="job-blockers">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
        <h2 id="job-blockers-title" className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <CirclePause className="size-4 text-accent-hi" strokeWidth={1.75} /> Needs you — production is paused
        </h2>
        <ul className="flex flex-col gap-2 text-[13px] text-fg-2">
          {blockers.awaitingInputs ? (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1">
                The planner is waiting for you to confirm the brief, assets and access are complete. Nothing is produced or spent until you do.
                {blockers.missingInputs.length ? (
                  <span className="mt-1 block text-xs text-fg-3">
                    Still missing per the analysis: {blockers.missingInputs.slice(0, 5).join(" · ")}
                    {blockers.missingInputs.length > 5 ? ` (+${blockers.missingInputs.length - 5} more)` : ""}
                  </span>
                ) : null}
              </span>
              {canManage && blockers.canConfirmInputs ? (
                <Button variant="primary" size="sm" onClick={() => setDialog("inputs")} data-testid="job-confirm-inputs">
                  <ClipboardCheck className="size-3.5" /> Inputs confirmed — start production
                </Button>
              ) : null}
            </li>
          ) : null}
          {blockers.blockedSteps.length || blockers.repairLimitReached || blockers.deliveryFailed ? (
            <li className="flex flex-wrap items-start gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1">
                {blockers.blockedSteps.length ? (
                  <span className="block">
                    {blockers.blockedSteps.slice(0, 4).map((s, i) => (
                      <span key={s.key} className="block">
                        <span className="font-medium text-fg">{s.name}</span> {blockReasonText(s.reason)}
                        <span className="ml-1.5 font-mono text-[11px] text-fg-3">
                          {s.attempts}/{s.maxAttempts} attempts
                        </span>
                        {i === 3 && blockers.blockedSteps.length > 4 ? ` (+${blockers.blockedSteps.length - 4} more)` : ""}
                      </span>
                    ))}
                  </span>
                ) : null}
                {blockers.repairLimitReached ? <span className="block">QA still fails and the job has used every repair it was allowed.</span> : null}
                {blockers.deliveryFailed ? <span className="block">Packaging the delivery failed.</span> : null}
                {blockers.budgetBlocked ? (
                  <span className="mt-0.5 block text-xs text-fg-3">
                    Spend {formatUsd(actualCostUsd, { cents: true })} of {formatUsd(spendLimitUsd, { cents: true })} — raise the job spend limit (Spend vs limit, below) to continue.
                  </span>
                ) : null}
              </span>
              {canManage && blockers.canResume ? (
                <Button variant={blockers.awaitingInputs ? "outline" : "primary"} size="sm" onClick={() => setDialog("resume")} data-testid="job-resume">
                  <Play className="size-3.5" /> Authorise another attempt
                </Button>
              ) : null}
            </li>
          ) : blockers.budgetBlocked ? (
            <li className="text-[13px]">
              Spend {formatUsd(actualCostUsd, { cents: true })} of {formatUsd(spendLimitUsd, { cents: true })}: the next step would exceed the job’s spend limit. Raise it under Spend vs limit to continue.
            </li>
          ) : null}
        </ul>
        {!canManage ? <p className="text-xs text-fg-3">Only owners and admins can unblock production.</p> : null}
      </div>

      <ConfirmDialog
        open={dialog === "inputs"}
        onOpenChange={(v) => !v && setDialog(null)}
        title="Start production?"
        description="Confirms the client inputs are complete. Agents start executing the planned workflow within the job’s spend limit."
        confirmLabel="Start production"
        tone="primary"
        loading={pending}
        onConfirm={() =>
          run(() => confirmInputsAction(jobId, note), {
            onSuccess: () => {
              setDialog(null);
              setNote("");
            },
          })
        }
      >
        <Field id="inputs-note" label="Note for the agents (optional)" hint="E.g. where the assets are, or what the client clarified.">
          <Textarea id="inputs-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} data-testid="job-inputs-note" />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "resume"}
        onOpenChange={(v) => !v && setDialog(null)}
        title="Authorise another attempt?"
        description={`Grants ${blockers.blockedSteps.length ? "1 more attempt per paused step" : "a new attempt"}${grant.extraRepairs ? " and 1 more automatic repair" : ""}${blockers.deliveryFailed ? " and re-packages the delivery" : ""} for this job only. Each attempt is recorded as a new run; spend stays within the job limit.`}
        confirmLabel="Authorise"
        tone="primary"
        loading={pending}
        onConfirm={() => run(() => resumeJobAction(jobId, grant), { onSuccess: () => setDialog(null) })}
      >
        {blockers.blockedSteps.some((s) => s.reason === "ambiguous_submission") ? (
          <p className="text-xs leading-5 text-warn">One step’s outcome was unclear at the provider. Check the provider dashboard first so the work isn’t produced (or billed) twice.</p>
        ) : null}
        {blockers.budgetBlocked ? <p className="mt-2 text-xs leading-5 text-fg-3">Budget-blocked steps also need a higher job spend limit.</p> : null}
      </ConfirmDialog>
    </section>
  );
}
