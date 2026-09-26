import "server-only";
import type { SourceCapabilities, TenantSettings } from "@gigpilot/contracts";
import {
  and,
  application,
  costEstimate,
  desc,
  eq,
  getDb,
  getTenantSettings,
  job,
  market,
  opportunity,
  opportunityAnalysis,
  opportunityScore,
  proposal,
  providerMetric,
  isNull,
  or,
} from "@gigpilot/db";
import { chooseCreativeRoute, type RouteChoice } from "@gigpilot/economics";
import { getSourceAdapter } from "@gigpilot/providers";
import { listRecentEvents } from "./events";

export type OpportunityDetail = NonNullable<Awaited<ReturnType<typeof getOpportunityDetail>>>;

export async function getOpportunityDetail(tenantId: string, id: string) {
  const db = getDb();
  const [opp] = await db
    .select()
    .from(opportunity)
    .where(and(eq(opportunity.id, id), eq(opportunity.tenantId, tenantId)))
    .limit(1);
  if (!opp) return null;

  const [analysisRows, estimateRows, scoreRows, proposals, apps, jobs, marketRows, settings, metrics] = await Promise.all([
    db.select().from(opportunityAnalysis).where(eq(opportunityAnalysis.opportunityId, id)).orderBy(desc(opportunityAnalysis.version), desc(opportunityAnalysis.createdAt)).limit(1),
    db.select().from(costEstimate).where(eq(costEstimate.opportunityId, id)).orderBy(desc(costEstimate.createdAt)).limit(1),
    db.select().from(opportunityScore).where(eq(opportunityScore.opportunityId, id)).orderBy(desc(opportunityScore.createdAt)).limit(1),
    db.select().from(proposal).where(and(eq(proposal.opportunityId, id), eq(proposal.tenantId, tenantId))).orderBy(desc(proposal.createdAt)),
    db.select().from(application).where(and(eq(application.opportunityId, id), eq(application.tenantId, tenantId))).orderBy(desc(application.createdAt)).limit(1),
    db.select({ id: job.id, status: job.status, title: job.title }).from(job).where(and(eq(job.opportunityId, id), eq(job.tenantId, tenantId))).limit(1),
    opp.marketKey ? db.select({ name: market.name }).from(market).where(and(eq(market.tenantId, tenantId), eq(market.key, opp.marketKey))).limit(1) : Promise.resolve([]),
    getTenantSettings(db, tenantId),
    db
      .select()
      .from(providerMetric)
      .where(or(eq(providerMetric.tenantId, tenantId), isNull(providerMetric.tenantId))),
  ]);

  const analysisRow = analysisRows[0] ?? null;
  const estimate = estimateRows[0] ?? null;
  const score = scoreRows[0] ?? null;
  const currentProposal = proposals.find((p) => p.status !== "superseded") ?? null;
  const app = apps[0] ?? null;

  const adapter = getSourceAdapter(opp.sourceKey);
  const capabilities: SourceCapabilities | null = adapter?.capabilities ?? null;

  const routes: (RouteChoice & { label: string })[] = [];
  if (analysisRow) {
    for (const est of analysisRow.analysis.productionEstimates) {
      if (!est.capability.startsWith("image.") && !est.capability.startsWith("video.")) continue;
      const durationSec = /(\d+)\s*s\b/.exec(est.label)?.[1];
      const r = chooseCreativeRoute(est.capability, {
        qualityThreshold: settings.routing.creativeQualityThreshold,
        preference: settings.routing.creativeProviderPreference,
        metrics: metrics.map((m) => ({ provider: m.provider, model: m.model, capability: m.capability, usableRate: m.usableRate, attempts: m.attempts })),
        durationSec: durationSec ? Number(durationSec) : undefined,
      });
      if (r) routes.push({ ...r, label: est.label });
    }
  }

  const events = await listRecentEvents(tenantId, {
    limit: 30,
    subjectIds: [opp.id, ...proposals.map((p) => p.id), ...(app ? [app.id] : [])],
  });

  return {
    opp,
    marketName: marketRows[0]?.name ?? null,
    analysis: analysisRow?.analysis ?? null,
    analysisMeta: analysisRow ? { provider: analysisRow.provider, model: analysisRow.model, version: analysisRow.version, createdAt: analysisRow.createdAt } : null,
    estimate,
    score,
    proposals,
    currentProposal,
    application: app,
    job: jobs[0] ?? null,
    capabilities,
    settings: settings as TenantSettings,
    routes,
    events,
    autoSubmit: Boolean(capabilities?.canSubmit && settings.autonomy.autoSubmitWhenPermitted),
  };
}
