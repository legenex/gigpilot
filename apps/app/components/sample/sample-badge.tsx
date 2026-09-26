import { cn } from "@gigpilot/ui";

/** Quiet marker for seeded sample history (excluded from goals and totals). */
export function SampleBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[18px] shrink-0 items-center rounded-xs px-1.5 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.06em] text-fg-3 ring-1 ring-inset ring-line-strong", className)}
      title="Seeded sample history — shown for orientation, excluded from goals and totals"
      data-sample="true"
    >
      Sample
    </span>
  );
}
