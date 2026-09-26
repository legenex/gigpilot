import {
  AGENTS,
  QUEUES,
  opportunityAnalysisSchema,
  type OpportunityAnalysis,
  type QueuePayloads,
  type TenantSettings,
} from "@gigpilot/contracts";
import {
  and,
  costEstimate,
  desc,
  emitEvent,
  eq,
  getDb,
  getTenantSettings,
  inArray,
  market,
  opportunity,
  opportunityAnalysis,
  opportunityScore,
  providerMetric,
  transition,
  type EconomicsBreakdown,
  type Executor,
} from "@gigpilot/db";
import { estimateOpportunity, scoreOpportunity, statedBudget, type EconomicsResult } from "@gigpilot/economics";
import type { AgentDeps } from "../deps";
import { analyseOpportunityHeuristically, sanitiseAnalysis } from "../heuristics/analysis";
import { notify } from "../lib/notify";
import { familyLabel, money, pct, quote, safeError } from "../lib/util";
import { callIntelligence, runAgent } from "../runtime";

type OpportunityRow = typeof opportunity.$inferSelect;

export function analysisPrompt(opp: OpportunityRow, baseline: OpportunityAnalysis) {
  const budget =
    opp.budgetType === "hourly"
      ? `hourly ${money(opp.budgetMinUsd)}–${money(opp.budgetMaxUsd)}/h`
      : opp.budgetMaxUsd || opp.budgetMinUsd
        ? `fixed ${money(opp.budgetMinUsd)}–${money(opp.budgetMaxUsd)}`
        : "not stated";
  return [
    {
      role: "system" as const,
      content:
        "You are GigPilot's Opportunity Analyst. Read a freelance brief and return JSON matching the opportunity_analysis schema. " +
        "Estimate QUANTITIES only (deliverable units, attempts per usable unit, owner hours, billable hours, token volumes) — never prices or fees. " +
        "serviceFamily must be one of: paid-social-ugc, image-design, localization-repurposing, ai-automation, web-app-builds, research-content. " +
        "productionEstimates.capability must be one of: image.generate, image.edit, image.upscale, video.generate, video.image_to_video, audio.voiceover, audio.dub, text.copy, text.translate, text.research, code.build, code.automation, media.finishing, qa.review. " +
        "For video estimates include the clip length in the label like '(15s)'. " +
        `proposedWorkflow agents must be keys of: ${Object.keys(AGENTS).join(", ")}; include a QA step (agent "qa") before a final step. ` +
        "Rationale bullets are short, factual and user-visible (no chain-of-thought).",
    },
    {
      role: "user" as const,
      content: [
        `Title: ${opp.title}`,
        `Source: ${opp.sourceKey} · Budget: ${budget} · Client: ${opp.clientName ?? "unknown"} (${opp.clientCountry ?? "?"}, rating ${opp.clientRating ?? "n/a"}) · Proposals so far: ${opp.proposalsCount ?? "?"}`,
        `Deadline: ${opp.deadlineAt ? opp.deadlineAt.toISOString().slice(0, 10) : "not stated"}`,
        "",
        "Brief:",
        opp.description.slice(0, 8000),
        "",
        "Deterministic baseline (refine it where the brief says otherwise):",
        JSON.stringify({
          serviceFamily: baseline.serviceFamily,
          deliverables: baseline.deliverables,
          productionEstimates: baseline.productionEstimates,
          humanHours: baseline.humanHours,
          billableHours: baseline.billableHours,
          deadlineDays: baseline.deadlineDays,
        }),
      ].join("\n"),
    },
  ];
}

export async function persistEstimate(
  db: Executor,
  input: { tenantId: string; opportunityId: string; analysisId: string | null; economics: EconomicsResult; jobId?: string | null },
): Promise<string> {
  const e = input.economics;
  const breakdown: EconomicsBreakdown = {
    priceUsd: e.priceUsd,
    priceBasis: e.priceBasis,
    lineItems: e.lineItems.map((li) => ({
      category: li.category,
      label: li.label,
      provider: li.provider,
      model: li.model,
      unit: li.unit,
      unitCostUsd: li.unitCostUsd,
      quantity: li.quantity,
      attempts: li.attempts,
      totalUsd: li.totalUsd,
      priceSource: li.priceSource,
    })),
    fulfilmentCostUsd: e.fulfilmentCostUsd,
    revisionContingencyUsd: e.revisionContingencyUsd,
    contingencyUsd: e.contingencyUsd,
    shadowCostUsd: e.shadowCostUsd,
    platformFeesUsd: e.platformFeesUsd,
    platformFeeKey: e.platformFeeKey,
    totalCostUsd: e.totalCostUsd,
    grossProfitUsd: e.grossProfitUsd,
    grossMargin: e.grossMargin,
    breakEvenPriceUsd: e.breakEvenPriceUsd,
    complete: e.complete,
    missing: e.missing,
  };
  const [row] = await db
    .insert(costEstimate)
    .values({
      tenantId: input.tenantId,
      opportunityId: input.opportunityId,
      jobId: input.jobId ?? null,
      analysisId: input.analysisId,
      breakdown,
      totalCostUsd: e.totalCostUsd,
      grossProfitUsd: e.grossProfitUsd,
      grossMargin: e.grossMargin,
      complete: e.complete,
    })
    .returning({ id: costEstimate.id });
  if (!row) throw new Error("cost_estimate insert failed");
  return row.id;
}

export async function tenantMetrics(db: Executor, tenantId: string) {
  return db
    .select({ provider: providerMetric.provider, model: providerMetric.model, capability: providerMetric.capability, usableRate: providerMetric.usableRate, attempts: providerMetric.attempts })
    .from(providerMetric)
    .where(eq(providerMetric.tenantId, tenantId));
}

export function computeEconomics(
  analysis: OpportunityAnalysis,
  opp: Pick<OpportunityRow, "sourceKey" | "budgetType" | "budgetMinUsd" | "budgetMaxUsd">,
  settings: TenantSettings,
  metrics: Awaited<ReturnType<typeof tenantMetrics>>,
  proposedPriceUsd?: number | null,
) {
  const { economics, routes } = estimateOpportunity(
    analysis,
    { sourceKey: opp.sourceKey, budgetType: opp.budgetType, budgetMinUsd: opp.budgetMinUsd, budgetMaxUsd: opp.budgetMaxUsd, proposedPriceUsd: proposedPriceUsd ?? null },
    settings,
    { metrics },
  );
  const score = scoreOpportunity(
    economics,
    {
      fit: analysis.fitScore,
      complexity: analysis.complexity,
      revisionRisk: analysis.revisionRisk,
      deadlineRisk: analysis.deadlineRisk,
      confidence: analysis.confidence,
      highRisks: analysis.risks.filter((r) => r.severity === "high").length,
    },
    settings.thresholds,
    // For hourly work the stated "budget" is a rate, not a total — let the gate use the estimated price instead.
    opp.budgetType === "hourly" ? null : statedBudget(opp.budgetMinUsd, opp.budgetMaxUsd),
  );
  return { economics, routes, score };
}

/**
 * Opportunity Analyst + Economics. new → analysing → analysed (→ shortlisted
 * when the deterministic score recommends pursuit).
 */
export async function runOpportunityAnalyse(payload: QueuePayloads["opportunity-analyse"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, opportunityId } = payload;
  if (payload.refine) return runOpportunityRefine({ tenantId, opportunityId }, deps);
  const [opp] = await db.select().from(opportunity).where(and(eq(opportunity.id, opportunityId), eq(opportunity.tenantId, tenantId))).limit(1);
  if (!opp) return { status: "skipped" as const, reason: "not found" };
  const reanalysable = ["analysed", "shortlisted", "rejected"];
  if (!(opp.status === "new" || opp.status === "analysing" || (payload.force && reanalysable.includes(opp.status)))) {
    return { status: "skipped" as const, reason: `opportunity is ${opp.status}` };
  }
  const settings = await getTenantSettings(db, tenantId);
  const actor = { type: "agent" as const, id: "analyst" };

  if (opp.status !== "analysing") {
    await transition(db, { machine: "opportunity", id: opp.id, tenantId, to: "analysing", actor, reason: payload.force ? "re-analysis requested" : "analysis started" });
  }

  try {
    return await runAgent(
      { deps, tenantId, agent: "analyst", task: "analyse_opportunity", subjectType: "opportunity", subjectId: opp.id, label: `Analysis of ${quote(opp.title)}` },
      async (ctx) => {
        const { markets, baseline } = await baselineFor(opp, settings, deps);
        // Two-tier analysis: every brief gets an instant deterministic triage priced by the
        // same economics engine, so the radar fills immediately. Pursue candidates are then
        // refined by local GX in a separate job (runOpportunityRefine) without blocking the
        // owner; an owner-requested re-analysis goes straight to the model.
        const metrics = await tenantMetrics(db, tenantId);
        const deep = Boolean(payload.force);
        let provider = "heuristic";
        let model = "deterministic-triage";
        let analysis = baseline;
        if (deep) {
          const res = await callIntelligence(
            ctx,
            {
              task: "analyse_opportunity",
              messages: analysisPrompt(opp, baseline),
              schema: opportunityAnalysisSchema,
              schemaName: "opportunity_analysis",
              maxOutputTokens: 2500,
              temperature: 0.2,
              mockResult: () => baseline,
            },
            { opportunityId: opp.id },
          );
          provider = res.family;
          model = res.model;
          analysis = res.family === "mock" ? baseline : sanitiseAnalysis(res.data ?? baseline, baseline);
        } else {
          ctx.provider = provider;
          ctx.model = model;
        }

        const [latest] = await db
          .select({ version: opportunityAnalysis.version })
          .from(opportunityAnalysis)
          .where(eq(opportunityAnalysis.opportunityId, opp.id))
          .orderBy(desc(opportunityAnalysis.version))
          .limit(1);
        const [analysisRow] = await db
          .insert(opportunityAnalysis)
          .values({ tenantId, opportunityId: opp.id, version: (latest?.version ?? 0) + 1, analysis, provider, model, agentRunId: ctx.runId })
          .returning({ id: opportunityAnalysis.id });
        if (!analysisRow) throw new Error("analysis insert failed");

        const { economics, score } = computeEconomics(analysis, opp, settings, metrics);
        const estimateId = await persistEstimate(db, { tenantId, opportunityId: opp.id, analysisId: analysisRow.id, economics });
        await db.insert(opportunityScore).values({
          tenantId,
          opportunityId: opp.id,
          analysisId: analysisRow.id,
          costEstimateId: estimateId,
          fit: analysis.fitScore,
          complexity: analysis.complexity,
          revisionRisk: analysis.revisionRisk,
          deadlineRisk: analysis.deadlineRisk,
          confidence: analysis.confidence,
          overall: score.overall,
          recommendation: score.recommendation,
          gates: score.gates,
          reasons: score.reasons,
        });

        const marketKeys = new Set(markets.map((m) => m.key));
        const budgetLabel =
          opp.budgetType === "hourly"
            ? `${money(economics.priceUsd)} est. (${money(opp.budgetMinUsd)}–${money(opp.budgetMaxUsd)}/h)`
            : `${money(opp.budgetMaxUsd ?? opp.budgetMinUsd ?? economics.priceUsd)} budget`;
        const message = `Analysed ${quote(opp.title)} — ${budgetLabel}, ${money(economics.grossProfitUsd)} expected profit, ${pct(economics.grossMargin)} margin → ${score.recommendation}`;

        await db.transaction(async (tx) => {
          await transition(tx, {
            machine: "opportunity",
            id: opp.id,
            tenantId,
            to: "analysed",
            actor,
            patch: {
              expectedProfitUsd: economics.grossProfitUsd,
              expectedMargin: economics.grossMargin,
              estimatedCostUsd: economics.totalCostUsd,
              expectedFeesUsd: economics.platformFeesUsd,
              priceUsd: economics.priceUsd,
              overallScore: score.overall,
              recommendation: score.recommendation,
              estimateComplete: economics.complete,
              marketKey: marketKeys.has(analysis.serviceFamily) ? analysis.serviceFamily : opp.marketKey,
            },
            event: {
              type: "opportunity.analysed",
              level: score.recommendation === "pursue" ? "success" : "info",
              agent: "analyst",
              runId: ctx.runId,
              subjectType: "opportunity",
              subjectId: opp.id,
              message,
              data: { provider, model, family: analysis.serviceFamily, triaged: !deep },
            },
          });
          await emitEvent(tx, {
            tenantId,
            type: "opportunity.scored",
            level: "debug",
            agent: "economics",
            runId: ctx.runId,
            subjectType: "opportunity",
            subjectId: opp.id,
            message: `Scored ${quote(opp.title, 40)}: ${Math.round(score.overall * 100)}/100 — ${score.reasons[0] ?? score.recommendation}`,
            data: { gates: score.gates, overall: score.overall, recommendation: score.recommendation },
          });
          if (score.recommendation === "pursue") {
            await transition(tx, {
              machine: "opportunity",
              id: opp.id,
              tenantId,
              to: "shortlisted",
              actor,
              reason: score.reasons[0],
              event: {
                type: "opportunity.shortlisted",
                level: "success",
                agent: "analyst",
                runId: ctx.runId,
                subjectType: "opportunity",
                subjectId: opp.id,
                message: `Shortlisted ${quote(opp.title)} (${familyLabel(analysis.serviceFamily)}) — awaiting your approval to pursue`,
              },
            });
            await notify(tx, {
              tenantId,
              kind: "approval",
              title: `Pursue “${opp.title.slice(0, 90)}”?`,
              body: `${money(economics.grossProfitUsd)} expected profit at ${pct(economics.grossMargin)} margin. ${score.reasons[0] ?? ""}`.trim(),
              link: `/radar/${opp.id}`,
              dedupeKey: `opportunity-approve:${opp.id}`,
            });
          }
        });
        ctx.summary = message;

        if (!deep && score.recommendation === "pursue") {
          await deps.queue.send(QUEUES.opportunityRefine, { tenantId, opportunityId: opp.id }, { singletonKey: opp.id });
        }

        if (score.recommendation === "pursue" && !settings.autonomy.requireOpportunityApproval) {
          await transition(db, { machine: "opportunity", id: opp.id, tenantId, to: "pursuing", actor: { type: "system", id: "autonomy" }, reason: "opportunity approval not required by tenant autonomy settings" });
          await deps.queue.send(QUEUES.proposalGenerate, { tenantId, opportunityId: opp.id }, { singletonKey: opp.id });
        }
        return { status: "analysed" as const, recommendation: score.recommendation, economics, analysisId: analysisRow.id, estimateId };
      },
    );
  } catch (err) {
    // Return to `new` so a retry (pg-boss) or the job monitor can pick it up again.
    await transition(db, { machine: "opportunity", id: opp.id, tenantId, to: "new", actor, reason: `analysis failed: ${safeError(err, 200)}` }).catch(() => {});
    throw err;
  }
}


async function baselineFor(opp: typeof opportunity.$inferSelect, settings: Awaited<ReturnType<typeof getTenantSettings>>, deps: AgentDeps) {
  const db = getDb();
  const markets = await db
    .select({ key: market.key, enabled: market.enabled, keywords: market.keywords })
    .from(market)
    .where(eq(market.tenantId, opp.tenantId));
  const baseline = analyseOpportunityHeuristically(
    {
      title: opp.title,
      description: opp.description,
      skills: opp.skills,
      sourceKey: opp.sourceKey,
      budgetType: opp.budgetType,
      budgetMinUsd: opp.budgetMinUsd,
      budgetMaxUsd: opp.budgetMaxUsd,
      deadlineAt: opp.deadlineAt,
      postedAt: opp.postedAt,
      clientName: opp.clientName,
      clientRating: opp.clientRating,
      clientSpendUsd: opp.clientSpendUsd,
      proposalsCount: opp.proposalsCount,
      marketKey: opp.marketKey,
    },
    { markets, preferredMinBudgetUsd: settings.thresholds.preferredMinBudgetUsd, now: deps.now() },
  );
  return { markets, baseline };
}

/**
 * Deep refinement of a triaged pursue candidate with the model router (local
 * GX first). Adds a new analysis version and re-prices it; never flips the
 * opportunity out of its current state (so it cannot race owner actions) —
 * it only shortlists an `analysed` brief that the refined numbers now clear.
 */
export async function runOpportunityRefine(payload: QueuePayloads["opportunity-refine"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, opportunityId } = payload;
  const [opp] = await db.select().from(opportunity).where(and(eq(opportunity.id, opportunityId), eq(opportunity.tenantId, tenantId))).limit(1);
  if (!opp) return { status: "skipped" as const, reason: "not found" };
  if (!["analysed", "shortlisted"].includes(opp.status)) return { status: "skipped" as const, reason: `opportunity is ${opp.status}` };
  const settings = await getTenantSettings(db, tenantId);
  const actor = { type: "agent" as const, id: "analyst" };

  return runAgent(
    { deps, tenantId, agent: "analyst", task: "analyse_opportunity.refine", subjectType: "opportunity", subjectId: opp.id, label: `Deep analysis of ${quote(opp.title)}` },
    async (ctx) => {
      const { markets, baseline } = await baselineFor(opp, settings, deps);
      const res = await callIntelligence(
        ctx,
        {
          task: "analyse_opportunity",
          messages: analysisPrompt(opp, baseline),
          schema: opportunityAnalysisSchema,
          schemaName: "opportunity_analysis",
          maxOutputTokens: 2500,
          temperature: 0.2,
          mockResult: () => baseline,
        },
        { opportunityId: opp.id },
      );
      if (res.family === "mock") {
        ctx.summary = "No model available — triage analysis stands";
        return { status: "unchanged" as const };
      }
      const analysis = sanitiseAnalysis(res.data ?? baseline, baseline);
      const [latest] = await db
        .select({ version: opportunityAnalysis.version })
        .from(opportunityAnalysis)
        .where(eq(opportunityAnalysis.opportunityId, opp.id))
        .orderBy(desc(opportunityAnalysis.version))
        .limit(1);
      const [analysisRow] = await db
        .insert(opportunityAnalysis)
        .values({ tenantId, opportunityId: opp.id, version: (latest?.version ?? 0) + 1, analysis, provider: res.family, model: res.model, agentRunId: ctx.runId })
        .returning({ id: opportunityAnalysis.id });
      if (!analysisRow) throw new Error("analysis insert failed");
      const metrics = await tenantMetrics(db, tenantId);
      const { economics, score } = computeEconomics(analysis, opp, settings, metrics);
      const estimateId = await persistEstimate(db, { tenantId, opportunityId: opp.id, analysisId: analysisRow.id, economics });
      await db.insert(opportunityScore).values({
        tenantId,
        opportunityId: opp.id,
        analysisId: analysisRow.id,
        costEstimateId: estimateId,
        fit: analysis.fitScore,
        complexity: analysis.complexity,
        revisionRisk: analysis.revisionRisk,
        deadlineRisk: analysis.deadlineRisk,
        confidence: analysis.confidence,
        overall: score.overall,
        recommendation: score.recommendation,
        gates: score.gates,
        reasons: score.reasons,
      });
      const marketKeys = new Set(markets.map((m) => m.key));
      const message = `Refined ${quote(opp.title)} with ${res.family}/${res.model} — ${money(economics.grossProfitUsd)} expected profit, ${pct(economics.grossMargin)} margin → ${score.recommendation}`;
      await db.transaction(async (tx) => {
        // Only still-open briefs are re-priced; an owner action in the meantime wins.
        const updated = await tx
          .update(opportunity)
          .set({
            expectedProfitUsd: economics.grossProfitUsd,
            expectedMargin: economics.grossMargin,
            estimatedCostUsd: economics.totalCostUsd,
            expectedFeesUsd: economics.platformFeesUsd,
            priceUsd: economics.priceUsd,
            overallScore: score.overall,
            recommendation: score.recommendation,
            estimateComplete: economics.complete,
            marketKey: marketKeys.has(analysis.serviceFamily) ? analysis.serviceFamily : opp.marketKey,
          })
          .where(and(eq(opportunity.id, opp.id), inArray(opportunity.status, ["analysed", "shortlisted"])))
          .returning({ status: opportunity.status });
        if (!updated[0]) return;
        await emitEvent(tx, {
          tenantId,
          type: "opportunity.analysed",
          level: "info",
          agent: "analyst",
          runId: ctx.runId,
          subjectType: "opportunity",
          subjectId: opp.id,
          message,
          data: { provider: res.family, model: res.model, refined: true },
        });
        if (updated[0].status === "analysed" && score.recommendation === "pursue") {
          await transition(tx, { machine: "opportunity", id: opp.id, tenantId, to: "shortlisted", actor, reason: score.reasons[0] });
        }
      });
      ctx.summary = message;
      return { status: "refined" as const, recommendation: score.recommendation };
    },
  );
}
