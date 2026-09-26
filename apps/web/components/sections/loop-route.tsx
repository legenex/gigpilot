"use client";

import { useRef } from "react";
import { m, useScroll, useTransform, type MotionValue } from "motion/react";
import { useReducedFlag } from "@/components/motion/use-reduced-flag";
import { cn } from "@gigpilot/ui/lib/cn";

export interface Waypoint {
  code: string;
  name: string;
  body: string;
  agent: string;
  state: string;
  owner?: boolean;
}

/**
 * The loop as a flight plan: eight waypoints on a course line that fills as
 * the section scrolls through the viewport. Owner-gated stages carry the
 * orange diamond used throughout the site.
 */
export function LoopRoute({ stages }: { stages: Waypoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedFlag();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.85", "end 0.45"] });
  const progress = useTransform([scrollYProgress, reduced], ([v, r]: number[]) => (r ? 1 : Math.min(1, Math.max(0, v ?? 0))));
  const n = stages.length;

  return (
    <div ref={ref} className="relative mt-14 lg:mt-20">
      {/* Desktop: horizontal course line */}
      <div className="hidden xl:block">
        <div className="relative grid grid-cols-8 gap-x-4">
          {/* the course runs from the first waypoint to the last (column starts, gap-x-4 = 1rem) */}
          <div aria-hidden className="absolute left-0 top-[39px] h-px w-[calc((100%+1rem)*0.875)] bg-line-strong" />
          <m.div aria-hidden className="absolute left-0 top-[39px] h-px w-[calc((100%+1rem)*0.875)] origin-left bg-fg" style={{ scaleX: progress }} />
          <Marker progress={progress} />
          {stages.map((s, i) => (
            <Stop key={s.code} s={s} i={i} n={n} progress={progress} />
          ))}
        </div>
        <ReturnArc />
      </div>

      {/* Tablet + mobile: vertical course line */}
      <ol className="relative grid gap-0 sm:grid-cols-2 sm:gap-x-10 xl:hidden">
        <div aria-hidden className="absolute bottom-3 left-[5px] top-3 w-px bg-line-strong sm:hidden" />
        <m.div aria-hidden className="absolute bottom-3 left-[5px] top-3 w-px origin-top bg-fg sm:hidden" style={{ scaleY: progress }} />
        {stages.map((s, i) => (
          <StopVertical key={s.code} s={s} i={i} n={n} progress={progress} />
        ))}
      </ol>
    </div>
  );
}

function useLit(progress: MotionValue<number>, i: number, n: number) {
  const at = i / (n - 1);
  return useTransform(progress, (v): number => (v >= at - 0.001 ? 1 : 0));
}

function Glyph({ owner, lit }: { owner?: boolean; lit: MotionValue<number> }) {
  const color = useTransform(lit, (l) => (l ? (owner ? "var(--gp-accent)" : "var(--gp-fg)") : "var(--gp-fg-3)"));
  const fill = useTransform(lit, (l) => (l ? (owner ? "var(--gp-accent)" : "var(--gp-fg)") : "var(--gp-bg)"));
  if (owner) {
    return (
      <m.span
        className="block size-[9px] rotate-45 border-[1.5px] bg-bg transition-colors duration-300"
        style={{ borderColor: color, backgroundColor: fill }}
      />
    );
  }
  return <m.span className="block size-[9px] rounded-full border-[1.5px] transition-colors duration-300" style={{ borderColor: color, backgroundColor: fill }} />;
}

function useEmphasis(lit: MotionValue<number>) {
  // Emphasis changes colour, never opacity, so unlit stops still meet 4.5:1 contrast.
  const title = useTransform(lit, (l) => (l ? "var(--gp-fg)" : "var(--gp-fg-2)"));
  const body = useTransform(lit, (l) => (l ? "var(--gp-fg-2)" : "var(--site-fg-3)"));
  return { title, body };
}

function Stop({ s, i, n, progress }: { s: Waypoint; i: number; n: number; progress: MotionValue<number> }) {
  const lit = useLit(progress, i, n);
  const { title, body } = useEmphasis(lit);
  return (
    <div className="relative">
      <div className="flex h-6 items-center gap-2">
        <m.span className="font-mono text-[11px] tracking-[0.12em]" style={{ color: title }}>
          {s.code}
        </m.span>
        <span className="label tnum">{String(i + 1).padStart(2, "0")}</span>
      </div>
      <div className="relative flex h-[30px] items-center">
        <span className="relative z-[1] -ml-px">
          <Glyph owner={s.owner} lit={lit} />
        </span>
      </div>
      <m.h3 className="display-3 mt-3 transition-colors duration-300" style={{ color: title }}>
        {s.name}
      </m.h3>
      <m.p className="mt-2 text-[14px] leading-[21px] transition-colors duration-300" style={{ color: body }}>
        {s.body}
      </m.p>
      <p className="label mt-4">{s.agent}</p>
      <p className="mt-1.5 font-mono text-[11px] leading-4 text-fg-muted">{s.state.replaceAll("_", "_\u200b")}</p>
    </div>
  );
}

function StopVertical({ s, i, n, progress }: { s: Waypoint; i: number; n: number; progress: MotionValue<number> }) {
  const lit = useLit(progress, i, n);
  const { title, body } = useEmphasis(lit);
  return (
    <li className="relative grid grid-cols-[11px_minmax(0,1fr)] gap-x-5 pb-9 sm:border-t sm:border-line sm:pb-8 sm:pt-5">
      <span className="relative z-[1] mt-[5px] flex justify-center bg-bg py-1">
        <Glyph owner={s.owner} lit={lit} />
      </span>
      <div>
        <p className="flex items-center gap-2">
          <m.span className="font-mono text-[11px] tracking-[0.12em]" style={{ color: title }}>
            {s.code}
          </m.span>
          <span className="label tnum">{String(i + 1).padStart(2, "0")}</span>
        </p>
        <m.h3 className="display-3 mt-1.5" style={{ color: title }}>
          {s.name}
        </m.h3>
        <m.p className="mt-1.5 text-[15px] leading-[23px]" style={{ color: body }}>
          {s.body}
        </m.p>
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
          <span className="label">{s.agent}</span>
          <span className="font-mono text-[11px] leading-4 text-fg-muted">{s.state.replaceAll("_", "_\u200b")}</span>
        </p>
      </div>
    </li>
  );
}

function Marker({ progress }: { progress: MotionValue<number> }) {
  const left = useTransform(progress, (v) => `calc((100% + 1rem) * ${(0.875 * v).toFixed(4)})`);
  return (
    <m.span aria-hidden className="absolute top-[31px] z-[2] -ml-2 flex size-4 items-center justify-center" style={{ left }}>
      <svg viewBox="0 0 16 16" className={cn("size-4")} fill="none">
        <path d="M3 13 13 3m0 0H7.5M13 3v5.5" stroke="var(--gp-accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </m.span>
  );
}

function ReturnArc() {
  return (
    <div className="relative mt-10" aria-hidden>
      <svg viewBox="0 0 1000 60" preserveAspectRatio="none" className="h-[60px] w-full overflow-visible">
        <path
          d="M 995 0 C 995 44, 960 52, 900 52 L 100 52 C 40 52, 5 44, 5 0"
          fill="none"
          stroke="var(--gp-profit)"
          strokeOpacity="0.55"
          strokeWidth="1"
          strokeDasharray="2 6"
          vectorEffect="non-scaling-stroke"
          style={{ animation: "site-dash 1.6s linear infinite reverse" }}
        />
      </svg>
      <p className="label absolute left-1/2 top-[44px] -translate-x-1/2 bg-bg px-3">
        <span className="text-profit">Learn → Discover</span> · every outcome re-weights the next search
      </p>
    </div>
  );
}
