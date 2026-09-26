"use client";

import { useRef } from "react";
import { m, useScroll, useTransform } from "motion/react";
import { useReducedFlag } from "@/components/motion/use-reduced-flag";

/**
 * The mark, drawn as an instrument: the heading ring turns with scroll while
 * the course chevron holds its heading. Graphite, not orange — the CTA beside
 * it is the one accent in this viewport.
 */
export function CtaRing() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedFlag();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const rotate = useTransform([scrollYProgress, reduced], ([v, r]: number[]) => (r ? 0 : -40 + 80 * (v ?? 0)));
  const chevron = useTransform([scrollYProgress, reduced], ([v, r]: number[]) => (r ? 1 : Math.min(1, Math.max(0, ((v ?? 0) - 0.2) / 0.35))));
  const chevronOpacity = useTransform(chevron, (v) => (v > 0.02 ? 1 : 0));

  const ticks = Array.from({ length: 72 }, (_, i) => i);
  // Rounded so server and client trig agree byte-for-byte (avoids hydration mismatches).
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return (
    <div ref={ref} aria-hidden className="pointer-events-none relative aspect-square w-full">
      <m.svg viewBox="-200 -200 400 400" className="absolute inset-0 h-full w-full" style={{ rotate }}>
        <circle r={190} fill="none" stroke="var(--gp-line-strong)" />
        <circle r={150} fill="none" stroke="var(--gp-line)" />
        {ticks.map((i) => {
          const a = (i / 72) * Math.PI * 2;
          const major = i % 6 === 0;
          const r0 = major ? 164 : 172;
          return (
            <line
              key={i}
              x1={r2(Math.cos(a) * r0)}
              y1={r2(Math.sin(a) * r0)}
              x2={r2(Math.cos(a) * 184)}
              y2={r2(Math.sin(a) * 184)}
              stroke={major ? "var(--gp-fg-3)" : "var(--gp-fg-4)"}
              strokeWidth={major ? 1.5 : 1}
            />
          );
        })}
      </m.svg>
      <svg viewBox="-200 -200 400 400" className="absolute inset-0 h-full w-full">
        <m.path
          d="M-58 58 L58 -58 M58 -58 H4 M58 -58 V-4"
          fill="none"
          stroke="var(--gp-fg-3)"
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pathLength: chevron, opacity: chevronOpacity }}
        />
      </svg>
    </div>
  );
}
