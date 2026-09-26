"use client";

import { ClipboardPaste } from "lucide-react";
import { Button } from "@gigpilot/ui";
import { useShell } from "@/components/shell/app-shell";
import type { ManualSourceKey } from "@/components/shell/paste-dialog";

export function PasteButton({ source, variant = "outline", size = "md", label = "Paste opportunity" }: { source?: ManualSourceKey; variant?: "primary" | "secondary" | "outline" | "ghost"; size?: "xs" | "sm" | "md"; label?: string }) {
  const { openPaste } = useShell();
  return (
    <Button variant={variant} size={size} onClick={() => openPaste(source)} data-testid={source ? `paste-${source}` : "paste-opportunity"}>
      <ClipboardPaste className="size-3.5" strokeWidth={1.75} />
      {label}
    </Button>
  );
}
