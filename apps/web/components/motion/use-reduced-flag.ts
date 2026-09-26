"use client";

import { useEffect } from "react";
import { useMotionValue, type MotionValue } from "motion/react";

/**
 * Reduced-motion preference as a MotionValue (0 | 1). It starts at 0 on both
 * the server and the first client render — so hydration always matches — and
 * flips after mount. Scroll-linked transforms combine it with their input.
 */
export function useReducedFlag(): MotionValue<number> {
  const flag = useMotionValue(0);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => flag.set(mq.matches ? 1 : 0);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [flag]);
  return flag;
}
