/**
 * Illustrative learning curve shared by the chart and the figures beside it,
 * so the two can never disagree. Deterministic (seeded), not product data.
 */
export const LEARNING_JOBS = 40;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
}

export interface LearningPoint {
  i: number;
  /** absolute cost-estimate error, % */
  v: number;
  lo: number;
  hi: number;
}

export function learningSeries(): LearningPoint[] {
  const r = rng(7);
  return Array.from({ length: LEARNING_JOBS }, (_, i) => {
    const base = 9 + 29 * Math.exp(-i / 11);
    const spread = 4 + 14 * Math.exp(-i / 13);
    const v = Math.max(1.5, base + (r() - 0.5) * spread * 1.4);
    return { i, v, lo: Math.max(0, base - spread), hi: base + spread };
  });
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute error of the first and last ten jobs, rounded to whole percent. */
export function learningSummary(points = learningSeries()) {
  return {
    first: Math.round(median(points.slice(0, 10).map((p) => p.v))),
    last: Math.round(median(points.slice(-10).map((p) => p.v))),
    window: 10,
  };
}
