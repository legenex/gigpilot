import "server-only";
import { asc, desc, eq, getDb, market, marketInsight, sql } from "@gigpilot/db";

export interface MarketRow {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  allocationPct: number;
  recommendedAllocationPct: number | null;
  keywords: string[];
  metrics: {
    opportunitiesPerDay: number;
    avgBudgetUsd: number;
    avgMargin: number;
    avgProfitUsd: number;
    competition: number | null;
    winRate: number | null;
    fulfilmentReliability: number | null;
    avgTurnaroundDays: number | null;
    demandTrend: "up" | "down" | "flat" | null;
  };
  metricsSource: "research" | "observed";
  observed7d: number;
}

export async function getMarkets(tenantId: string) {
  const db = getDb();
  const [rows, observed, insights] = await Promise.all([
    db.select().from(market).where(eq(market.tenantId, tenantId)).orderBy(desc(market.allocationPct), asc(market.name)),
    db.execute(sql`
      select market_key as key, count(*)::int as n,
        avg(coalesce(budget_max_usd, budget_min_usd, price_usd))::float8 as budget,
        avg(expected_margin)::float8 as margin,
        avg(expected_profit_usd)::float8 as profit
      from opportunity where tenant_id = ${tenantId} and created_at > now() - interval '7 days' and market_key is not null
      group by market_key
    `) as unknown as Promise<{ key: string; n: number; budget: number | null; margin: number | null; profit: number | null }[]>,
    db.select().from(marketInsight).where(eq(marketInsight.tenantId, tenantId)).orderBy(desc(marketInsight.createdAt)).limit(6),
  ]);
  const obs = new Map(observed.map((o) => [o.key, o]));
  const markets: MarketRow[] = rows.map((m) => {
    const o = obs.get(m.key);
    const research = m.metrics;
    return {
      key: m.key,
      name: m.name,
      description: m.description,
      enabled: m.enabled,
      allocationPct: m.allocationPct,
      recommendedAllocationPct: m.recommendedAllocationPct,
      keywords: m.keywords,
      metricsSource: research ? "research" : "observed",
      observed7d: o?.n ?? 0,
      metrics: research
        ? {
            opportunitiesPerDay: research.opportunitiesPerDay,
            avgBudgetUsd: research.avgBudgetUsd,
            avgMargin: research.avgMargin,
            avgProfitUsd: research.avgProfitUsd,
            competition: research.competition,
            winRate: research.winRate,
            fulfilmentReliability: research.fulfilmentReliability,
            avgTurnaroundDays: research.avgTurnaroundDays,
            demandTrend: research.demandTrend,
          }
        : {
            opportunitiesPerDay: (o?.n ?? 0) / 7,
            avgBudgetUsd: o?.budget ?? 0,
            avgMargin: o?.margin ?? 0,
            avgProfitUsd: o?.profit ?? 0,
            competition: null,
            winRate: null,
            fulfilmentReliability: null,
            avgTurnaroundDays: null,
            demandTrend: null,
          },
    };
  });
  return {
    markets,
    insights: insights.map((i) => ({ id: i.id, headline: i.headline, summary: i.summary, body: i.body, provider: i.provider, model: i.model, createdAt: i.createdAt.toISOString() })),
  };
}
