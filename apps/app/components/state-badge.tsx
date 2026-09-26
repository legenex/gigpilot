import { Badge, StatusDot, cn } from "@gigpilot/ui";
import type { StateMeta } from "@/lib/labels";

/** State pill: dot (pulses only for live states) + label. Colour is never the only signal. */
export function StateBadge({ meta, className, testId, dataStatus }: { meta: StateMeta; className?: string; testId?: string; dataStatus?: string }) {
  return (
    <Badge tone={meta.tone === "accent" ? "accent" : "neutral"} className={cn("gap-1.5 pl-1.5", className)} data-testid={testId} data-status={dataStatus}>
      <StatusDot tone={meta.tone} live={meta.live} />
      <span className={meta.tone === "accent" ? undefined : "text-fg-2"}>{meta.label}</span>
    </Badge>
  );
}

/** Bare dot + label for dense tables. */
export function StateText({ meta, className }: { meta: StateMeta; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-fg-2", className)}>
      <StatusDot tone={meta.tone} live={meta.live} />
      {meta.label}
    </span>
  );
}
