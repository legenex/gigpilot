import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Stat readout. Values use proportional figures (large standalone numbers),
 * labels are sentence case, deltas are signed and name their period.
 */
export function Metric({
  label,
  value,
  unit,
  sub,
  delta,
  trend,
  size = "md",
  className,
  valueClassName,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  delta?: ReactNode;
  trend?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  valueClassName?: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-testid={testId}>
      <span className="truncate text-xs text-fg-3">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span
          className={cn(
            "flex items-baseline gap-1 font-semibold tracking-[-0.02em] text-fg",
            size === "sm" && "text-[18px] leading-6",
            size === "md" && "text-[22px] leading-7",
            size === "lg" && "text-[28px] leading-8",
            valueClassName,
          )}
        >
          {value}
          {unit ? <span className="text-[13px] font-medium tracking-normal text-fg-3">{unit}</span> : null}
        </span>
        {trend ? <span className="mb-1 shrink-0">{trend}</span> : null}
      </div>
      {sub || delta ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs leading-4 text-fg-3">
          {delta}
          {sub}
        </span>
      ) : null}
    </div>
  );
}

/** Signed change. `good` decides colour: up can be good (profit) or bad (cost). */
export function Delta({ value, format, good = "up", suffix }: { value: number | null | undefined; format: (n: number) => string; good?: "up" | "down"; suffix?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return <span className="font-mono text-[11px] text-fg-3">±0{suffix ? ` ${suffix}` : ""}</span>;
  }
  const up = value > 0;
  const positive = good === "up" ? up : !up;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-mono text-[11px] tabular", positive ? "text-profit" : "text-risk")}>
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      <span className="sr-only">{up ? "up" : "down"}</span>
      {format(Math.abs(value))}
      {suffix ? <span className="text-fg-3"> {suffix}</span> : null}
    </span>
  );
}

/**
 * Horizontal strip of metrics divided by hairlines (not a grid of cards).
 * Cells draw their own right/bottom hairlines so partial rows never show
 * filler blocks.
 */
export function MetricStrip({ children, className, columns = 4 }: { children: ReactNode; className?: string; columns?: 3 | 4 }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 overflow-hidden rounded-md border-l border-t border-line 2xl:grid-flow-col 2xl:auto-cols-fr 2xl:grid-cols-none",
        columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4",
        "[&>*]:border-b [&>*]:border-r [&>*]:border-line [&>*]:px-4 [&>*]:py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
