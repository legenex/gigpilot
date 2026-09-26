"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LEARNING_JOBS, learningSeries, learningSummary } from "@/lib/learning";

const JOBS = LEARNING_JOBS;
const H = 300;
const PAD = { l: 40, r: 16, t: 16, b: 34 };
const YMAX = 50;

const y = (v: number) => PAD.t + (1 - Math.min(v, YMAX) / YMAX) * (H - PAD.t - PAD.b);

export function LearningChart({ target = 20 }: { target?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drawn, setDrawn] = useState(false);
  // The coordinate width follows the rendered width so labels stay legible on phones.
  const [W, setW] = useState(640);
  const data = useMemo(() => learningSeries(), []);
  const summary = useMemo(() => learningSummary(data), [data]);
  const x = (i: number) => PAD.l + (i / (JOBS - 1)) * (W - PAD.l - PAD.r);

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(Math.max(340, Math.min(720, el.clientWidth)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = requestAnimationFrame(() => setDrawn(true));
      return () => cancelAnimationFrame(id);
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setDrawn(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const line = data.map((d, k) => `${k ? "L" : "M"}${x(d.i).toFixed(1)} ${y(d.v).toFixed(1)}`).join(" ");
  const band =
    data.map((d, k) => `${k ? "L" : "M"}${x(d.i).toFixed(1)} ${y(d.hi).toFixed(1)}`).join(" ") +
    " " +
    [...data]
      .reverse()
      .map((d) => `L${x(d.i).toFixed(1)} ${y(d.lo).toFixed(1)}`)
      .join(" ") +
    " Z";
  const last = data[data.length - 1]!;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label={`Illustrative chart: median absolute cost-estimate error is about ${summary.first}% over the first ${summary.window} jobs and about ${summary.last}% over the last ${summary.window}, inside the ${target}% target.`}
    >
      {/* grid */}
      {[0, 10, 20, 30, 40, 50].map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--gp-line)" />
          <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize={11} className="font-mono" fill="var(--site-fg-3)">
            {v}%
          </text>
        </g>
      ))}
      {(W < 480 ? [1, 20, 40] : [1, 10, 20, 30, 40]).map((j) => (
        <text key={j} x={x(j - 1)} y={H - 12} textAnchor="middle" fontSize={11} className="font-mono" fill="var(--site-fg-3)">
          {j}
        </text>
      ))}
      <text x={W - PAD.r} y={H - 0} textAnchor="end" fontSize={11} className="font-mono" fill="var(--site-fg-3)" letterSpacing="0.04em">
        COMPLETED JOBS →
      </text>

      {/* target band */}
      <rect x={PAD.l} y={y(target)} width={W - PAD.l - PAD.r} height={y(0) - y(target)} fill="var(--gp-profit)" opacity={0.05} />
      <line x1={PAD.l} x2={W - PAD.r} y1={y(target)} y2={y(target)} stroke="var(--gp-profit)" strokeOpacity={0.6} strokeDasharray="3 4" />
      <text x={W - PAD.r - 14} y={y(target) - 7} textAnchor="end" fontSize={11} className="font-mono" fill="var(--gp-profit)" letterSpacing="0.03em">
        TARGET ≤ {target}%
      </text>

      <path d={band} fill="var(--gp-fg)" opacity={drawn ? 0.06 : 0} style={{ transition: "opacity 900ms var(--gp-ease-out) 300ms" }} />
      <path
        d={line}
        fill="none"
        stroke="var(--gp-fg)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={drawn ? 0 : 1}
        style={{ transition: "stroke-dashoffset 1600ms var(--gp-ease-out)" }}
      />
      {/* Annotation sits in the empty upper-right of the plot with a leader, clear of the line. */}
      <g style={{ opacity: drawn ? 1 : 0, transition: "opacity 400ms ease-out 1400ms" }}>
        <circle cx={x(last.i)} cy={y(last.v)} r={3.5} fill="var(--gp-profit)" />
        <line x1={x(last.i)} x2={x(last.i)} y1={y(37) + 8} y2={y(last.v) - 6} stroke="var(--gp-fg-3)" strokeDasharray="2 3" />
        <text x={x(last.i)} y={y(43)} textAnchor="end" fontSize={11} className="font-mono" fill="var(--site-fg-3)" letterSpacing="0.03em">
          LAST {summary.window} JOBS
        </text>
        <text x={x(last.i)} y={y(37)} textAnchor="end" fontSize={13} fontWeight={600} className="font-mono" fill="var(--gp-fg)">
          median ±{summary.last}%
        </text>
      </g>
    </svg>
  );
}
