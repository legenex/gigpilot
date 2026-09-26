"use client";

import { useState } from "react";
import { Check, PenLine, X } from "lucide-react";
import { Button, Input, cn, formatUsd } from "@gigpilot/ui";
import { setJobSpendLimitAction } from "@/lib/actions/jobs";
import { useAction } from "@/lib/use-action";

/**
 * Inline editor for a job's maximum authorised spend. Shows actual vs limit;
 * the server still caps paid calls by the workspace and server budgets.
 */
export function SpendLimitEditor({
  jobId,
  limitUsd,
  actualUsd,
  ceilingUsd,
  editable,
  highlight,
}: {
  jobId: string;
  limitUsd: number;
  actualUsd: number;
  /** Operator ceiling for any job's spend limit. */
  ceilingUsd: number;
  editable: boolean;
  highlight?: boolean;
}) {
  const { run, pending } = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(limitUsd));
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return setError("Enter an amount ≥ $0.");
    if (n > ceilingUsd + 1e-9) return setError(`The operator ceiling is ${formatUsd(ceilingUsd, { cents: true })}.`);
    if (n < actualUsd) return setError(`Can’t go below the ${formatUsd(actualUsd, { cents: true })} already spent.`);
    setError(null);
    run(() => setJobSpendLimitAction(jobId, n), { onSuccess: () => setEditing(false) });
  };

  if (!editing) {
    return (
      <span className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-fg-3">
        <span className={cn(highlight && "text-warn")}>
          {formatUsd(actualUsd, { cents: true })} of {formatUsd(limitUsd, { cents: true })}
        </span>
        {editable ? (
          <button
            type="button"
            className={cn("grid size-5 place-items-center rounded-xs hover:bg-surface-2 hover:text-fg", highlight ? "text-warn" : "text-fg-3")}
            aria-label="Edit job spend limit"
            data-testid="job-spend-limit-edit"
            onClick={() => {
              setValue(String(limitUsd));
              setEditing(true);
            }}
          >
            <PenLine className="size-3" />
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <form
      className="mt-1.5 flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span className="flex items-center gap-1">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.5"
          prefix="$"
          inputSize="sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Job spend limit in USD"
          aria-invalid={!!error}
          className="w-24"
          autoFocus
          data-testid="job-spend-limit-input"
        />
        <Button type="submit" size="xs" variant="secondary" loading={pending} aria-label="Save spend limit" data-testid="job-spend-limit-save">
          <Check className="size-3" />
        </Button>
        <Button type="button" size="xs" variant="ghost" aria-label="Cancel" onClick={() => setEditing(false)}>
          <X className="size-3" />
        </Button>
      </span>
      <span className={cn("text-[10.5px]", error ? "text-risk" : "text-fg-3")}>{error ?? `Spent ${formatUsd(actualUsd, { cents: true })} · max ${formatUsd(ceilingUsd, { cents: true })} · daily budgets still apply`}</span>
    </form>
  );
}
