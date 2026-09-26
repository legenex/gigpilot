"use client";

import { useEffect, useRef } from "react";

interface CountUpProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  className?: string;
}

function fmt(v: number, decimals: number, prefix: string, suffix: string) {
  return `${prefix}${v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`;
}

/**
 * Server renders the final value (correct without JS, no flash). If the number
 * starts below the fold, it rewinds to zero and counts up when it enters view.
 */
export function CountUp({ value, prefix = "", suffix = "", decimals = 0, duration = 1100, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.textContent = fmt(0, decimals, prefix, suffix);
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          const e = 1 - Math.pow(1 - t, 4);
          el.textContent = fmt(value * e, t < 1 ? decimals : decimals, prefix, suffix);
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, prefix, suffix, decimals, duration]);

  return (
    <span ref={ref} className={className}>
      {fmt(value, decimals, prefix, suffix)}
    </span>
  );
}
