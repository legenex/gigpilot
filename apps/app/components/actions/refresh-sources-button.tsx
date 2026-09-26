"use client";

import { RefreshCw } from "lucide-react";
import { Button, useToast } from "@gigpilot/ui";
import { refreshAllSourcesAction } from "@/lib/actions/integrations";
import { useAction } from "@/lib/use-action";

export interface RefreshOutcome {
  count: number;
  queued: number;
  throttled: { name: string; waitMin: number }[];
}

/** Toast copy that matches what the Scout will write to the activity stream. */
export function refreshToast(d: RefreshOutcome | undefined): { title: string; description?: string } {
  if (!d || d.count === 0) return { title: "No sources enabled", description: "Enable a source in Integrations first." };
  const t = d.throttled;
  const title = d.queued > 0 ? `Refreshing ${d.queued} source${d.queued === 1 ? "" : "s"}` : "Nothing to refresh yet";
  const description = t.length
    ? t.map((x) => `${x.name} refreshed recently — source policy allows the next refresh in ${x.waitMin} min`).join(" · ")
    : "New opportunities appear on the Radar as they are analysed.";
  return { title, description };
}

export function RefreshSourcesButton({ variant = "secondary", size = "md" }: { variant?: "primary" | "secondary" | "outline" | "ghost"; size?: "sm" | "md" }) {
  const { run, pending } = useAction();
  const { toast } = useToast();
  return (
    <Button
      variant={variant}
      size={size}
      loading={pending}
      onClick={() =>
        run(refreshAllSourcesAction, {
          success: false,
          onSuccess: (d) => {
            const m = refreshToast(d);
            toast({ ...m, tone: d && d.queued > 0 ? "success" : "info" });
          },
        })
      }
      data-testid="refresh-sources"
    >
      <RefreshCw className="size-3.5" strokeWidth={1.75} />
      Refresh sources
    </Button>
  );
}
