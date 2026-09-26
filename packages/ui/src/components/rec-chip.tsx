import { cn } from "../lib/cn";

export type Recommendation = "pursue" | "consider" | "skip";

const STYLE: Record<Recommendation, string> = {
  pursue: "bg-accent-wash text-accent-hi ring-accent-line",
  consider: "bg-warn-wash text-warn ring-warn/30",
  skip: "bg-surface-2 text-fg-2 ring-line-strong",
};

const LABEL: Record<Recommendation, string> = { pursue: "Pursue", consider: "Consider", skip: "Skip" };

/**
 * The one recommendation chip (dashboard + marketing radar): mono uppercase,
 * PURSUE orange, CONSIDER amber, SKIP graphite. `pending` renders the
 * analysing/queued state before a recommendation exists.
 */
export function RecChip({
  rec,
  pending,
  size = "md",
  className,
}: {
  rec: Recommendation | null | undefined;
  /** Shown when `rec` is null: "analysing" pulses, "queued" is static. */
  pending?: "analysing" | "queued";
  size?: "sm" | "md";
  className?: string;
}) {
  const base = cn(
    "inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-xs font-mono font-medium uppercase leading-none tracking-[0.06em] ring-1 ring-inset",
    size === "sm" ? "h-[18px] px-1.5 text-[11px]" : "h-5 px-1.5 text-[11px]",
    className,
  );
  if (!rec) {
    const analysing = pending !== "queued";
    return (
      <span className={cn(base, "bg-transparent text-fg-3 ring-line")} data-rec="pending">
        <span className={cn("size-1.5 rounded-full bg-info", analysing && "animate-pulse-dot text-info")} aria-hidden />
        {analysing ? "Analysing" : "Queued"}
      </span>
    );
  }
  return (
    <span className={cn(base, STYLE[rec])} data-rec={rec}>
      {LABEL[rec]}
    </span>
  );
}
