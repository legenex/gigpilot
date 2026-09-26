"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@gigpilot/ui";
import { retryStepAction } from "@/lib/actions/jobs";
import { useAction } from "@/lib/use-action";

export function RetryStepButton({ stepId, disabled, reason }: { stepId: string; disabled?: boolean; reason?: string }) {
  const { run, pending } = useAction();
  return (
    <Button size="sm" variant="outline" loading={pending} disabled={disabled} title={reason} onClick={() => run(() => retryStepAction(stepId))} data-testid="step-retry">
      <RotateCcw className="size-3.5" /> Retry step
    </Button>
  );
}
