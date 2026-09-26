import { cn } from "../lib/cn";
import type { Tone } from "./badge";

const fills: Record<Tone, string> = {
  neutral: "bg-fg-2",
  accent: "bg-accent",
  profit: "bg-profit",
  warn: "bg-warn",
  risk: "bg-risk",
  info: "bg-info",
  violet: "bg-violet",
};
const tracks: Record<Tone, string> = {
  neutral: "bg-surface-3",
  accent: "bg-accent-wash",
  profit: "bg-profit-wash",
  warn: "bg-warn-wash",
  risk: "bg-risk-wash",
  info: "bg-info-wash",
  violet: "bg-violet/10",
};

/** Horizontal meter. The track is a lighter step of the fill's own hue. */
export function BarMeter({
  value,
  max = 1,
  tone = "neutral",
  className,
  label,
  height = 4,
}: {
  value: number | null | undefined;
  max?: number;
  tone?: Tone;
  className?: string;
  label?: string;
  height?: number;
}) {
  const pct = value === null || value === undefined || max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
      className={cn("relative w-full overflow-hidden rounded-full", tracks[tone], className)}
      style={{ height }}
    >
      <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out", fills[tone])} style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

/**
 * Tiny 0..1 score readout for table cells: 2-digit value + 24px bar.
 * `invert` colours high values as risk (e.g. revision risk).
 */
export function MiniMeter({ value, invert, className }: { value: number | null | undefined; invert?: boolean; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="font-mono text-xs text-fg-4">—</span>;
  const v = Math.max(0, Math.min(1, value));
  const good = invert ? 1 - v : v;
  const tone: Tone = good >= 0.66 ? "profit" : good >= 0.4 ? "warn" : "risk";
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={`${Math.round(v * 100)} / 100`}>
      <span className="font-mono text-xs tabular text-fg-2">{Math.round(v * 100)}</span>
      <span className={cn("relative h-[3px] w-5 overflow-hidden rounded-full", tracks[tone])} aria-hidden>
        <span className={cn("absolute inset-y-0 left-0 rounded-full", fills[tone])} style={{ width: `${v * 100}%` }} />
      </span>
    </span>
  );
}

/**
 * Goal meter: shows a target band [min,max] on a scale and the actual value
 * as a marker + fill. Status is conveyed by label text, not colour alone.
 */
export function TargetMeter({
  value,
  min,
  max,
  scaleMax,
  className,
  label,
  lowerIsBetter,
}: {
  value: number;
  min: number;
  max: number;
  scaleMax?: number;
  className?: string;
  label?: string;
  lowerIsBetter?: boolean;
}) {
  const top = Math.max(scaleMax ?? max * 1.25, value, max) || 1;
  const pos = (n: number) => `${Math.max(0, Math.min(1, n / top)) * 100}%`;
  const inBand = value >= min && value <= max;
  const tone: Tone = lowerIsBetter ? (value <= max ? "profit" : value <= max * 1.5 ? "warn" : "risk") : inBand || value > max ? "profit" : value >= min * 0.5 ? "warn" : "risk";
  return (
    <div className={cn("relative h-5 w-full", className)} role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={top}>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-3" />
      <div
        className="absolute top-1/2 h-3 -translate-y-1/2 rounded-[3px] bg-white/[0.06] ring-1 ring-inset ring-line-bright"
        style={{ left: pos(lowerIsBetter ? 0 : min), width: `calc(${pos(max)} - ${pos(lowerIsBetter ? 0 : min)})` }}
        aria-hidden
      />
      <div className={cn("absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full transition-[width] duration-700 ease-out", fills[tone])} style={{ width: pos(value) }} />
      <div
        className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg transition-[left] duration-700 ease-out", fills[tone])}
        style={{ left: pos(value) }}
        aria-hidden
      />
    </div>
  );
}

/** Split bar for part-to-whole of two quantities (e.g. paid vs simulated). */
export function SplitBar({
  parts,
  className,
  height = 6,
}: {
  parts: { value: number; className: string; label: string }[];
  className?: string;
  height?: number;
}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className={cn("flex w-full gap-[2px] overflow-hidden rounded-full", className)} style={{ height }} role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}>
      {total <= 0 ? (
        <div className="h-full w-full rounded-full bg-surface-3" />
      ) : (
        parts
          .filter((p) => p.value > 0)
          .map((p) => <div key={p.label} className={cn("h-full first:rounded-l-full last:rounded-r-full", p.className)} style={{ width: `${(p.value / total) * 100}%` }} title={p.label} />)
      )}
    </div>
  );
}

/** Minimal inline sparkline (single series, de-emphasis hue, last point marked). */
export function Sparkline({
  values,
  width = 88,
  height = 24,
  className,
  label,
  area = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  label?: string;
  area?: boolean;
}) {
  if (values.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = 3;
  const step = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => [pad + i * step, pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const last = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible text-fg-3", className)} role="img" aria-label={label ?? `Trend: ${values.join(", ")}`}>
      {area ? <path d={`${d}L${last[0].toFixed(1)},${height}L${pad},${height}Z`} fill="currentColor" opacity={0.1} /> : null}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--gp-fg)" stroke="var(--gp-bg)" strokeWidth={1.5} />
    </svg>
  );
}
