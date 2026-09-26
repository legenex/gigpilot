import { marketInsightSchema, type QueuePayloads } from "@gigpilot/contracts";
import { and, application, emitEvent, eq, getDb, gte, job, market, marketInsight, ne, opportunity, qaReview } from "@gigpilot/db";
import { wrapUntrusted } from "@gigpilot/providers";
import type { AgentDeps } from "../deps";
import { buildMarketInsight, metricsFromStats, recommendAllocations, type MarketStats } from "../heuristics/market";
import { familyLabel } from "../lib/util";
import { callIntelligence, runAgent } from "../runtime";

/**
 * Market Research agent. Computes per-market metrics from the tenant's own
 * pipeline (demand, budgets, margins, competition, win rate, fulfilment
 * reliability, turnaround), recommends a sourcing allocation and writes a
 * reasoned insight (Grok web research when allowed; GX/mock otherwise).
 * Allocation numbers are deterministic; the model only phrases the insight.
 */
export async function runMarketResearch(payload: QueuePayloads["market-research"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId } = payload;
  const markets = await db.select().from(market).where(eq(market.tenantId, tenantId));
  if (markets.length === 0) return { status: "skipped" as const, reason: "no markets" };
  const now = deps.now();
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const since7 = new Date(now.getTime() - 7 * 86_400_000);
  const since3 = new Date(now.getTime() - 3 * 86_400_000);

  const opps = await db
    .select({
      marketKey: opportunity.marketKey,
      createdAt: opportunity.createdAt,
      budgetMinUsd: opportunity.budgetMinUsd,
      budgetMaxUsd: opportunity.budgetMaxUsd,
      budgetType: opportunity.budgetType,
      expectedMargin: opportunity.expectedMargin,
      expectedProfitUsd: opportunity.expectedProfitUsd,
      proposalsCount: opportunity.proposalsCount,
      priceUsd: opportunity.priceUsd,
    })
    .from(opportunity)
    .where(and(eq(opportunity.tenantId, tenantId), gte(opportunity.createdAt, since30), ne(opportunity.status, "archived")));
  const apps = await db
    .select({ status: application.status, marketKey: opportunity.marketKey })
    .from(application)
    .innerJoin(opportunity, eq(opportunity.id, application.opportunityId))
    .where(eq(application.tenantId, tenantId));
  const jobs = await db
    .select({ id: job.id, family: job.serviceFamily, repairs: job.repairCount, startedAt: job.startedAt, createdAt: job.createdAt, completedAt: job.completedAt, status: job.status })
    .from(job)
    .where(eq(job.tenantId, tenantId));
  const reviews = await db
    .select({ verdict: qaReview.verdict, family: job.serviceFamily })
    .from(qaReview)
    .innerJoin(job, eq(job.id, qaReview.jobId))
    .where(eq(qaReview.tenantId, tenantId));

  return runAgent({ deps, tenantId, agent: "market_research", task: "market_research", subjectType: "market", label: "Market research" }, async (ctx) => {
    const withMetrics = markets.map((m) => {
      const mo = opps.filter((o) => o.marketKey === m.key);
      const stats: MarketStats = {
        key: m.key,
        name: m.name,
        enabled: m.enabled,
        allocationPct: m.allocationPct,
        previous: m.metrics ?? null,
        opps7d: mo.filter((o) => o.createdAt >= since7).length,
        recent3d: mo.filter((o) => o.createdAt >= since3).length,
        prior4d: mo.filter((o) => o.createdAt >= since7 && o.createdAt < since3).length,
        budgets: mo.map((o) => (o.budgetType === "hourly" ? (o.priceUsd ?? null) : (o.budgetMaxUsd ?? o.budgetMinUsd ?? null))).filter((n): n is number => typeof n === "number" && n > 0),
        margins: mo.map((o) => o.expectedMargin).filter((n): n is number => typeof n === "number"),
        profits: mo.map((o) => o.expectedProfitUsd).filter((n): n is number => typeof n === "number"),
        proposals: mo.map((o) => o.proposalsCount).filter((n): n is number => typeof n === "number"),
        won: apps.filter((a) => a.marketKey === m.key && a.status === "won").length,
        lost: apps.filter((a) => a.marketKey === m.key && a.status === "lost").length,
        qaPass: reviews.filter((r) => r.family === m.key && r.verdict === "pass").length,
        qaTotal: reviews.filter((r) => r.family === m.key).length,
        repairs: jobs.filter((jj) => jj.family === m.key).reduce((a, jj) => a + jj.repairs, 0),
        jobsDone: jobs.filter((jj) => jj.family === m.key && ["delivered", "closed"].includes(jj.status)).length,
        turnaroundDays: jobs
          .filter((jj) => jj.family === m.key && jj.completedAt)
          .map((jj) => (jj.completedAt!.getTime() - (jj.startedAt ?? jj.createdAt).getTime()) / 86_400_000),
      };
      return { ...m, metrics: metricsFromStats(stats) };
    });
    const recommended = recommendAllocations(withMetrics.map((m) => ({ key: m.key, enabled: m.enabled, allocationPct: m.allocationPct, metrics: m.metrics })));
    for (const m of withMetrics) {
      await db.update(market).set({ metrics: m.metrics, recommendedAllocationPct: recommended[m.key] ?? null }).where(eq(market.id, m.id));
    }
    const deterministic = buildMarketInsight(withMetrics.map((m) => ({ key: m.key, name: m.name, enabled: m.enabled, allocationPct: m.allocationPct, metrics: m.metrics, recommendedPct: recommended[m.key] ?? 0 })));

    const res = await callIntelligence(ctx, {
      task: "market_research",
      schema: marketInsightSchema,
      schemaName: "market_insight",
      webSearch: true,
      maxOutputTokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "You are GigPilot's market research analyst. Using the tenant's computed market metrics (and current web signals if available), write a concise insight. " +
            "Keep the recommended allocation percentages EXACTLY as given; explain them. Return JSON market_insight.",
        },
        {
          role: "user",
          content: wrapUntrusted(
            "tenant market data",
            JSON.stringify({
              markets: withMetrics.map((m) => ({ key: m.key, name: familyLabel(m.key), enabled: m.enabled, currentPct: m.allocationPct, recommendedPct: recommended[m.key], metrics: m.metrics })),
              draft: deterministic,
            }),
          ),
        },
      ],
      mockResult: () => deterministic,
    });
    const keys = new Set(markets.map((m) => m.key));
    const modelInsight = res.data ?? deterministic;
    const insight = {
      headline: modelInsight.headline || deterministic.headline,
      summary: modelInsight.summary || deterministic.summary,
      // Allocation numbers stay deterministic regardless of the model's phrasing.
      recommendations: deterministic.recommendations.filter((r) => keys.has(r.marketKey)),
      signals: modelInsight.signals?.length ? modelInsight.signals.slice(0, 6) : deterministic.signals,
    };
    const [row] = await db
      .insert(marketInsight)
      .values({ tenantId, headline: insight.headline.slice(0, 200), summary: insight.summary.slice(0, 2000), body: insight, provider: res.family, model: res.model, agentRunId: ctx.runId })
      .returning({ id: marketInsight.id });
    await emitEvent(db, {
      tenantId,
      type: "market.insight",
      level: "info",
      agent: "market_research",
      runId: ctx.runId,
      subjectType: "market",
      message: `Market research: ${insight.summary.split(/(?<=\.)\s/)[0] ?? insight.headline}`.slice(0, 400),
      data: { insightId: row?.id, provider: res.family },
    });
    ctx.summary = insight.headline;
    return { status: "researched" as const, insightId: row?.id, recommended };
  });
}
