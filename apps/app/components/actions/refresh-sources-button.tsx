"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@gigpilot/ui";
import { refreshAllSourcesAction } from "@/lib/actions/integrations";
import { useAction } from "@/lib/use-action";

export function RefreshSourcesButton({ variant = "secondary", size = "md" }: { variant?: "primary" | "secondary" | "outline" | "ghost"; size?: "sm" | "md" }) {
  const { run, pending } = useAction();
  return (
    <Button
      variant={variant}
      size={size}
      loading={pending}
      onClick={() =>
        run(refreshAllSourcesAction, {
          success: undefined,
        })
      }
      data-testid="refresh-sources"
    >
      <RefreshCw className="size-3.5" strokeWidth={1.75} />
      Refresh sources
    </Button>
  );
}
