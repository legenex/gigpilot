"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@gigpilot/ui/lib/cn";

export interface AllocationRow {
  key: string;
  name: string;
  current: number;
  recommended: number;
}

const MAX = 35;

/**
 * Six service families, current vs. recommended sourcing allocation. Bars
 * start at today's split and shift to the agent's recommendation when the
 * chart enters view — the motion is the recommendation.
 */
export function AllocationShift({ rows, focus }: { rows: AllocationRow[]; focus: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shifted, setShifted] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = requestAnimationFrame(() => setShifted(true));
      return () => cancelAnimationFrame(id);
    }
    let t = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        setArmed(true);
        t = window.setTimeout(() => setShifted(true), 450);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  const replay = () => {
    setShifted(false);
    window.setTimeout(() => setShifted(true), 500);
  };

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <p className="label">Sourcing allocation · share of search effort</p>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-4 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted sm:flex">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 border border-dashed border-fg-3" aria-hidden /> Current
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 bg-fg-2" aria-hidden /> Recommended
            </span>
          </span>
          <button
            type="button"
            onClick={replay}
            className="focus-ring inline-flex items-center gap-1.5 rounded-xs px-1.5 py-1 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted hover:text-fg"
            aria-label="Replay allocation shift"
          >
            <RotateCcw className="size-3" strokeWidth={2} aria-hidden /> Replay
          </button>
        </div>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r, i) => {
          const delta = r.recommended - r.current;
          const value = shifted ? r.recommended : r.current;
          const isFocus = r.key === focus;
          return (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_64px] items-center gap-x-4 py-3.5 sm:grid-cols-[200px_minmax(0,1fr)_88px]">
              <span className={cn("col-start-1 row-start-1 text-[13.5px] leading-5 sm:col-auto sm:row-auto", isFocus ? "text-fg" : "text-fg-2")}>{r.name}</span>
              <span className="relative col-span-2 col-start-1 row-start-2 mt-2 h-[10px] sm:col-span-1 sm:col-auto sm:row-auto sm:mt-0" aria-hidden>
                <span className="absolute inset-y-0 left-0 w-full bg-[repeating-linear-gradient(90deg,var(--gp-line)_0_1px,transparent_1px_calc(100%/7))]" />
                <span className="absolute inset-y-0 left-0 border border-dashed border-fg-3/70" style={{ width: `${(r.current / MAX) * 100}%` }} />
                <span
                  className={cn("absolute inset-y-[2px] left-0", isFocus ? "bg-accent" : delta > 0 ? "bg-fg-2" : "bg-fg-3/80")}
                  style={{
                    width: `${(value / MAX) * 100}%`,
                    transition: armed ? `width 900ms var(--gp-ease-out) ${i * 70}ms` : undefined,
                  }}
                />
              </span>
              <span className="tnum col-start-2 row-start-1 text-right font-mono text-[12px] sm:col-auto sm:row-auto">
                <span className="text-fg">{value}%</span>{" "}
                <span className={cn("inline-block w-7 transition-opacity duration-300", shifted ? "opacity-100" : "opacity-0", delta > 0 ? "text-profit" : delta < 0 ? "text-risk" : "text-fg-muted")}>
                  {delta > 0 ? `+${delta}` : delta}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="sr-only">
        Recommended shift: {rows.map((r) => `${r.name} from ${r.current}% to ${r.recommended}%`).join("; ")}.
      </p>
    </div>
  );
}
