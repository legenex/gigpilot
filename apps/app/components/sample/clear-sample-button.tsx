"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, useToast } from "@gigpilot/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { clearSampleDataAction } from "@/lib/actions/workspace";
import { useAction } from "@/lib/use-action";

/** "Clear sample data" + confirmation. Only seeded history is removed; live work is untouched. */
export function ClearSampleButton({ size = "sm", variant = "outline", onCleared }: { size?: "xs" | "sm" | "md"; variant?: "outline" | "secondary" | "ghost"; onCleared?: () => void }) {
  const { run, pending } = useAction();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} data-testid="clear-sample-data">
        <Trash2 className="size-3.5" strokeWidth={1.75} /> Clear sample data
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Clear sample data?"
        description="Removes the seeded sample history (jobs, applications, ledger rows, agent runs and events created before this workspace existed). Opportunities, jobs and spend from your live pipeline are not touched."
        confirmLabel="Clear sample data"
        tone="danger"
        loading={pending}
        onConfirm={() =>
          run(() => clearSampleDataAction(), {
            success: false,
            onSuccess: (d) => {
              setOpen(false);
              onCleared?.();
              toast({ title: "Sample data cleared", description: d ? `${d.rows} seeded row${d.rows === 1 ? "" : "s"} removed — goals and totals now reflect only your live pipeline.` : undefined, tone: "success" });
            },
          })
        }
      />
    </>
  );
}
