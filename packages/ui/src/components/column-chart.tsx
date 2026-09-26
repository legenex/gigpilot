"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";

export interface ColumnSeries {
  key: string;
  label: string;
  /** CSS colour (use a --gp-series-* token). */
  color: string;
}

export interface ColumnDatum {
  label: string;
  /** Short tick label (defaults to label). */
  tick?: string;
  values: Record<string, number>;
}

function usdTick(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  if (v >= 10) return `$${Math.round(v)}`;
  if (v >= 1) return `$${v.toFixed(1)}`;
  return `$${v.toFixed(2)}`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

/**
 * Stacked column chart (custom SVG). Thin columns (≤ 24px) with 2px surface
 * gaps between stacked segments, rounded data-end, hairline grid, labelled
 * y-axis, hover/focus tooltip, and a legend for ≥ 2 series.
 */
export function ColumnChart({
  data,
  series,
  height = 180,
  format: formatProp,
  valueFormat = "number",
  className,
  label,
  emptyLabel = "No data yet",
}: {
  data: ColumnDatum[];
  series: ColumnSeries[];
  height?: number;
  /** Client-side formatter (only when rendered from a client component). */
  format?: (n: number) => string;
  /** Serializable formatter choice for server components. */
  valueFormat?: "number" | "usd";
  className?: string;
  label: string;
  emptyLabel?: string;
}) {
  const format = formatProp ?? (valueFormat === "usd" ? usdTick : (n: number) => String(Math.round(n * 100) / 100));
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(240, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = useMemo(() => data.map((d) => series.reduce((s, se) => s + (d.values[se.key] ?? 0), 0)), [data, series]);
  const max = niceMax(Math.max(0, ...totals));
  const padL = 44;
  const padR = 8;
  const padT = 8;
  const axisH = 22;
  const plotH = height - padT - axisH;
  const plotW = width - padL - padR;
  const band = data.length ? plotW / data.length : plotW;
  const colW = Math.max(3, Math.min(24, band * 0.62));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const tickEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 56))));
  const hasData = totals.some((t) => t > 0);

  return (
    <div className={cn("w-full min-w-0", className)}>
      {series.length > 1 ? (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-xs text-fg-2">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--gp-line)" strokeWidth={1} />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-3 font-mono text-[10px] tabular">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + band * i + band / 2;
            let acc = 0;
            const segs = series
              .map((s) => ({ s, v: d.values[s.key] ?? 0 }))
              .filter((x) => x.v > 0);
            return (
              <g key={i}>
                {segs.map(({ s, v }, j) => {
                  const y0 = y(acc);
                  acc += v;
                  const y1 = y(acc);
                  const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                  const top = j === segs.length - 1;
                  const r = top ? Math.min(3, h / 2, colW / 2) : 0;
                  const x = cx - colW / 2;
                  const yy = y1;
                  // rounded top only (data end), square at baseline
                  const path = r
                    ? `M${x},${yy + h}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + colW - r}Q${x + colW},${yy} ${x + colW},${yy + r}V${yy + h}Z`
                    : `M${x},${yy + h}V${yy}H${x + colW}V${yy + h}Z`;
                  return <path key={s.key} d={path} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.45} className="transition-opacity duration-150" />;
                })}
                {i % tickEvery === 0 ? (
                  <text x={cx} y={height - 6} textAnchor="middle" className="fill-fg-3 font-mono text-[10px]">
                    {d.tick ?? d.label}
                  </text>
                ) : null}
                <rect
                  x={padL + band * i}
                  y={padT}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${d.label}: ${format(totals[i] ?? 0)}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                />
              </g>
            );
          })}
          <line x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} stroke="var(--gp-line-strong)" strokeWidth={1} />
        </svg>
        {!hasData ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pl-11 text-xs text-fg-3">{emptyLabel}</div>
        ) : null}
        {hover !== null && data[hover] ? (
          <div
            className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-sm bg-surface-3 px-2.5 py-2 text-xs shadow-2 ring-1 ring-inset ring-line-strong"
            style={{ left: Math.min(Math.max(padL + band * hover + band / 2, 80), width - 80), top: 0 }}
            role="tooltip"
          >
            <p className="mb-1 font-medium text-fg">{data[hover]!.label}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-4 text-fg-2">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
                  {s.label}
                </span>
                <span className="font-mono tabular text-fg">{format(data[hover]!.values[s.key] ?? 0)}</span>
              </p>
            ))}
            {series.length > 1 ? (
              <p className="mt-1 flex justify-between border-t border-line pt-1 text-fg-2">
                Total <span className="font-mono tabular text-fg">{format(totals[hover] ?? 0)}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
