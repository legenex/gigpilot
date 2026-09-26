"use client";

import { LazyMotion, MotionConfig, domAnimation } from "motion/react";

/** Lean motion runtime: `m.*` components + the DOM animation feature set only. */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.56, ease: [0.16, 1, 0.3, 1] }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
