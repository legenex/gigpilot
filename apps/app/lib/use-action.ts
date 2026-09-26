"use client";

import { useCallback, useState, useTransition } from "react";
import { useToast } from "@gigpilot/ui";
import type { ActionResult } from "./actions/types";

/**
 * Runs a server action inside a transition and reports the outcome as a
 * toast. Pages refresh through the action's revalidatePath.
 */
export function useAction() {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [lastError, setLastError] = useState<string | null>(null);

  const run = useCallback(
    <T,>(fn: () => Promise<ActionResult<T>>, opts: { success?: string | false; onSuccess?: (data: T | undefined) => void; onError?: (e: string) => void } = {}) => {
      startTransition(async () => {
        try {
          const res = await fn();
          if (res.ok) {
            setLastError(null);
            if (opts.success !== false) toast({ title: opts.success ?? res.message ?? "Done", tone: "success" });
            opts.onSuccess?.(res.data);
          } else {
            setLastError(res.error);
            toast({ title: res.error, tone: "error" });
            opts.onError?.(res.error);
          }
        } catch {
          const e = "Network error — check your connection and try again.";
          setLastError(e);
          toast({ title: e, tone: "error" });
          opts.onError?.(e);
        }
      });
    },
    [toast],
  );

  return { run, pending, lastError };
}
