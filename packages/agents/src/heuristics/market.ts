import type { MarketInsight } from "@gigpilot/contracts";
import type { MarketMetrics } from "@gigpilot/db";
import { clamp, familyLabel, money, pct } from "../lib/util";

/**
 * Deterministic market analytics: turns a tenant's own pipeline data into
 * market metrics, recommended sourcing allocation and a reasoned insight.
 */

export interface MarketStats {
  key: string;
  name: string;
  enabled: boolean;
  allocationPct: number;
  previous: MarketMetrics | null;
  opps7d: number;
  recent3d: number;
  prior4d: number;
  budgets: number[];
  margins: number[];
  profits: number[];
  proposals: number[];
  won: number;
  lost: number;
  qaPass: number;
  qaTotal: number;
  repairs: number;
  jobsDone: number;
  turnaroundDays: number[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Blend observed values with the previous snapshot when the sample is small. */
function blend(observed: number | null, previous: number | undefined, sample: number, full = 8): number {
  if (observed === null) return previous ?? 0;
  if (previous === undefined) return observed;
  const w = clamp(sample / full, 0, 1);
  return observed * w + previous * (1 - w);
}

export function metricsFromStats(s: MarketStats): MarketMetrics {
  const prev = s.previous ?? undefined;
  const oppsPerDay = s.opps7d / 7;
  const decided = s.won + s.lost;
  const winObserved = decided > 0 ? s.won / decided : null;
  const reliabilityObserved = s.qaTotal > 0 ? clamp(s.qaPass / s.qaTotal - (s.jobsDone > 0 ? (s.repairs / Math.max(1, s.jobsDone)) * 0.03 : 0), 0, 1) : null;
  const competitionObserved = s.proposals.length ? clamp((avg(s.proposals) ?? 0) / 40, 0, 1) : null;
  const recentRate = s.recent3d / 3;
  const priorRate = s.prior4d / 4;
  const demandTrend: MarketMetrics["demandTrend"] = recentRate > priorRate * 1.15 ? "up" : recentRate < priorRate * 0.85 ? "down" : prev?.demandTrend ?? "flat";
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    opportunitiesPerDay: r(blend(oppsPerDay, prev?.opportunitiesPerDay, s.opps7d, 14), 1),
    avgBudgetUsd: r(blend(avg(s.budgets), prev?.avgBudgetUsd, s.budgets.length), 0),
    avgMargin: r(blend(avg(s.margins), prev?.avgMargin, s.margins.length), 3),
    avgProfitUsd: r(blend(avg(s.profits), prev?.avgProfitUsd, s.profits.length), 0),
    competition: r(blend(competitionObserved, prev?.competition, s.proposals.length), 2),
    winRate: r(blend(winObserved, prev?.winRate, decided, 6), 2),
    fulfilmentReliability: r(blend(reliabilityObserved, prev?.fulfilmentReliability, s.qaTotal, 10), 2),
    avgTurnaroundDays: r(blend(avg(s.turnaroundDays), prev?.avgTurnaroundDays, s.turnaroundDays.length, 4), 1),
    demandTrend,
  };
}

export function marketValue(m: MarketMetrics): number {
  const trend = m.demandTrend === "up" ? 1.1 : m.demandTrend === "down" ? 0.9 : 1;
  return (
    Math.max(0, m.avgProfitUsd) *
    clamp(m.winRate || 0.05, 0.05, 1) *
    clamp(m.fulfilmentReliability || 0.5, 0.2, 1) *
    Math.sqrt(Math.max(0, m.opportunitiesPerDay) + 0.5) *
    (1 - 0.5 * clamp(m.competition, 0, 1)) *
    trend
  );
}

/** Recommended allocation (%, multiples of 5, summing to 100 across enabled markets). Moves halfway from the current allocation. */
export function recommendAllocations(markets: { key: string; enabled: boolean; allocationPct: number; metrics: MarketMetrics }[]): Record<string, number> {
  const enabled = markets.filter((m) => m.enabled);
  const out: Record<string, number> = {};
  for (const m of markets) if (!m.enabled) out[m.key] = 0;
  if (enabled.length === 0) return out;
  const values = enabled.map((m) => marketValue(m.metrics));
  const total = values.reduce((a, b) => a + b, 0);
  const currentTotal = enabled.reduce((a, m) => a + m.allocationPct, 0) || 100;
  const raw = enabled.map((m, i) => {
    const ideal = total > 0 ? (values[i]! / total) * 100 : 100 / enabled.length;
    const current = (m.allocationPct / currentTotal) * 100;
    return { key: m.key, v: Math.max(5, (ideal + current) / 2) };
  });
  const rawSum = raw.reduce((a, r) => a + r.v, 0);
  const rounded = raw.map((r) => ({ key: r.key, v: Math.max(5, Math.round(((r.v / rawSum) * 100) / 5) * 5) }));
  let diff = 100 - rounded.reduce((a, r) => a + r.v, 0);
  const order = [...rounded].sort((a, b) => b.v - a.v);
  let i = 0;
  while (diff !== 0 && i < 100) {
    const target = order[i % order.length]!;
    const step = diff > 0 ? 5 : -5;
    if (target.v + step >= 5) {
      target.v += step;
      diff -= step;
    }
    i++;
  }
  for (const r of rounded) out[r.key] = r.v;
  return out;
}

export function buildMarketInsight(
  markets: { key: string; name: string; enabled: boolean; allocationPct: number; metrics: MarketMetrics; recommendedPct: number }[],
): MarketInsight {
  const enabled = markets.filter((m) => m.enabled);
  const deltas = enabled.map((m) => ({ ...m, delta: m.recommendedPct - Math.round(m.allocationPct) }));
  const up = [...deltas].sort((a, b) => b.delta - a.delta)[0];
  const down = [...deltas].sort((a, b) => a.delta - b.delta)[0];
  const byProfit = [...enabled].sort((a, b) => b.metrics.avgProfitUsd - a.metrics.avgProfitUsd);
  const best = byProfit[0];
  let headline = "Hold current sourcing allocation";
  let summary = "Market signals are balanced across your enabled service families; no reallocation is warranted this cycle.";
  if (up && down && up.delta > 0 && down.delta < 0) {
    const reasonBits = [
      up.metrics.avgProfitUsd >= (down.metrics.avgProfitUsd || 0) ? `average estimated profit (${money(up.metrics.avgProfitUsd)} vs ${money(down.metrics.avgProfitUsd)})` : null,
      up.metrics.fulfilmentReliability >= down.metrics.fulfilmentReliability ? `fulfilment reliability (${pct(up.metrics.fulfilmentReliability)})` : null,
      up.metrics.winRate > down.metrics.winRate ? `win rate (${pct(up.metrics.winRate)})` : null,
    ].filter(Boolean);
    const because = reasonBits.length ? reasonBits.join(" and ") : `overall expected value per opportunity`;
    headline = `Shift sourcing toward ${familyLabel(up.key)}`;
    summary =
      `Increase ${familyLabel(up.key)} sourcing allocation from ${Math.round(up.allocationPct)}% to ${up.recommendedPct}% because ${because} ${reasonBits.length > 1 ? "are" : "is"} outperforming ${familyLabel(down.key).toLowerCase()} work. ` +
      `Reduce ${familyLabel(down.key)} from ${Math.round(down.allocationPct)}% to ${down.recommendedPct}%` +
      (down.metrics.competition > 0.5 ? ` — competition there is high (${pct(down.metrics.competition)} of listings saturated).` : ".");
  }
  const recommendations: MarketInsight["recommendations"] = deltas.map((d) => ({
    marketKey: d.key,
    action: d.delta > 0 ? "increase" : d.delta < 0 ? "decrease" : "hold",
    fromPct: Math.round(d.allocationPct),
    toPct: d.recommendedPct,
    reason:
      d.delta === 0
        ? `Steady: ${money(d.metrics.avgProfitUsd)} avg profit, ${pct(d.metrics.winRate)} win rate`
        : `${d.delta > 0 ? "Outperforming" : "Underperforming"}: ${money(d.metrics.avgProfitUsd)} avg profit, ${pct(d.metrics.avgMargin)} margin, ${pct(d.metrics.fulfilmentReliability)} QA reliability, ${d.metrics.opportunitiesPerDay}/day`,
  }));
  const totalPerDay = enabled.reduce((a, m) => a + m.metrics.opportunitiesPerDay, 0);
  const avgWin = enabled.length ? enabled.reduce((a, m) => a + m.metrics.winRate, 0) / enabled.length : 0;
  const signals: MarketInsight["signals"] = [
    { label: "Opportunities / day", value: totalPerDay.toFixed(1), trend: enabled.some((m) => m.metrics.demandTrend === "up") ? "up" : "flat" },
    { label: "Best market by profit", value: best ? `${familyLabel(best.key)} · ${money(best.metrics.avgProfitUsd)}` : "—" },
    { label: "Average win rate", value: pct(avgWin) },
    ...(up && up.delta > 0 ? [{ label: "Biggest move", value: `${familyLabel(up.key)} +${up.delta} pts`, trend: "up" as const }] : []),
  ];
  return { headline, summary, recommendations, signals };
}
