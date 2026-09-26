import { proposalDraftSchema, type QueuePayloads } from "@gigpilot/contracts";
import { and, costEstimate, desc, eq, getDb, getTenantSettings, inArray, opportunity, opportunityAnalysis, proposal, transition } from "@gigpilot/db";
import type { AgentDeps } from "../deps";
import { draftProposal, priceProposal, timelineDaysFor } from "../heuristics/proposal";
import { notify } from "../lib/notify";
import { money, pct, quote } from "../lib/util";
import { callIntelligence, runAgent } from "../runtime";
import { computeEconomics, persistEstimate, tenantMetrics } from "./analyst";

/**
 * Proposal Agent. Supersedes stale drafts, prices deterministically, re-runs
 * economics at the proposed price, drafts a specific cover letter (LLM or
 * deterministic) and parks it for owner approval.
 */
export async function runProposalGenerate(payload: QueuePayloads["proposal-generate"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, opportunityId } = payload;
  const [opp] = await db.select().from(opportunity).where(and(eq(opportunity.id, opportunityId), eq(opportunity.tenantId, tenantId))).limit(1);
  if (!opp) return { status: "skipped" as const, reason: "not found" };
  if (!["pursuing", "shortlisted", "analysed"].includes(opp.status)) return { status: "skipped" as const, reason: `opportunity is ${opp.status}` };

  const [analysisRow] = await db
    .select()
    .from(opportunityAnalysis)
    .where(eq(opportunityAnalysis.opportunityId, opp.id))
    .orderBy(desc(opportunityAnalysis.version))
    .limit(1);
  if (!analysisRow) return { status: "skipped" as const, reason: "no analysis yet" };
  const [estimate] = await db.select().from(costEstimate).where(eq(costEstimate.opportunityId, opp.id)).orderBy(desc(costEstimate.createdAt)).limit(1);
  const settings = await getTenantSettings(db, tenantId);
  const actor = { type: "agent" as const, id: "proposal" };

  return runAgent(
    { deps, tenantId, agent: "proposal", task: "proposal", subjectType: "opportunity", subjectId: opp.id, label: `Proposal for ${quote(opp.title)}` },
    async (ctx) => {
      const stale = await db
        .select({ id: proposal.id })
        .from(proposal)
        .where(and(eq(proposal.opportunityId, opp.id), inArray(proposal.status, ["draft", "awaiting_approval"])));
      for (const s of stale) {
        await transition(db, { machine: "proposal", id: s.id, tenantId, to: "superseded", actor, reason: "a newer draft was generated" });
      }

      const analysis = analysisRow.analysis;
      const metrics = await tenantMetrics(db, tenantId);
      let price = priceProposal(
        {
          budgetType: opp.budgetType,
          budgetMinUsd: opp.budgetMinUsd,
          budgetMaxUsd: opp.budgetMaxUsd,
          breakEvenPriceUsd: estimate?.breakdown.breakEvenPriceUsd ?? null,
          billableHours: analysis.billableHours,
        },
        settings,
      );
      let econ = computeEconomics(analysis, opp, settings, metrics, price.priceUsd);
      const hardGatesPass = (e: typeof econ) => e.score.gates.profit.pass && e.score.gates.margin.pass;
      if (!hardGatesPass(econ) && opp.budgetType === "fixed" && opp.budgetMaxUsd && opp.budgetMaxUsd > price.priceUsd) {
        const retry = { priceUsd: opp.budgetMaxUsd, basis: "top of the client's range (needed to clear margin/profit thresholds)" };
        const econ2 = computeEconomics(analysis, opp, settings, metrics, retry.priceUsd);
        price = retry;
        econ = econ2;
      }
      const estimateId = await persistEstimate(db, { tenantId, opportunityId: opp.id, analysisId: analysisRow.id, economics: econ.economics });
      const timelineDays = timelineDaysFor(analysis);

      const deterministic = draftProposal({
        title: opp.title,
        clientName: opp.clientName,
        analysis,
        priceUsd: price.priceUsd,
        priceBasis: price.basis,
        timelineDays,
        budgetType: opp.budgetType,
        rateUsd: "rateUsd" in price ? price.rateUsd : undefined,
        hours: "hours" in price ? price.hours : undefined,
        expectedMargin: econ.economics.grossMargin,
      });

      const res = await callIntelligence(
        ctx,
        {
          task: "proposal",
          schema: proposalDraftSchema,
          schemaName: "proposal_draft",
          maxOutputTokens: 1400,
          temperature: 0.5,
          messages: [
            {
              role: "system",
              content:
                "You write tailored freelance proposals for GigPilot. Be specific to the brief: reference concrete deliverables, the buyer's priorities and the supplied assets. " +
                "No generic filler, no invented credentials or statistics, no promises beyond the scope. Keep the cover letter under 230 words. " +
                `Price is fixed at ${money(price.priceUsd)} and timeline at ${timelineDays} days — do not change them. Return JSON matching proposal_draft.`,
            },
            {
              role: "user",
              content: `Brief title: ${opp.title}\nClient: ${opp.clientName ?? "unknown"}\nAnalysis: ${JSON.stringify({
                summary: analysis.summary,
                deliverables: analysis.deliverables,
                buyerPriorities: analysis.buyerPriorities,
                suppliedAssets: analysis.suppliedAssets,
                missingInputs: analysis.missingInputs,
                risks: analysis.risks,
              })}\nDraft to improve:\n${deterministic.coverLetter}`,
            },
          ],
          mockResult: () => deterministic,
        },
        { opportunityId: opp.id },
      );
      const draft = res.data ?? deterministic;

      const [latest] = await db.select({ version: proposal.version }).from(proposal).where(eq(proposal.opportunityId, opp.id)).orderBy(desc(proposal.version)).limit(1);
      const [row] = await db
        .insert(proposal)
        .values({
          tenantId,
          opportunityId: opp.id,
          version: (latest?.version ?? 0) + 1,
          headline: draft.headline.slice(0, 300),
          coverLetter: draft.coverLetter.slice(0, 12_000),
          scope: draft.scope.slice(0, 20),
          // Money is never model-controlled: the deterministic price and timeline always win.
          priceUsd: price.priceUsd,
          timelineDays,
          assumptions: draft.assumptions.slice(0, 12),
          questions: draft.questions.slice(0, 8),
          status: "draft",
          provider: res.family,
          model: res.model,
          agentRunId: ctx.runId,
        })
        .returning({ id: proposal.id });
      if (!row) throw new Error("proposal insert failed");

      const message = `Drafted proposal for ${quote(opp.title)} at ${money(price.priceUsd)} — ${money(econ.economics.grossProfitUsd)} profit, ${pct(econ.economics.grossMargin)} margin, ${timelineDays}-day timeline`;
      await transition(db, {
        machine: "proposal",
        id: row.id,
        tenantId,
        to: "awaiting_approval",
        actor,
        reason: "ready for owner review",
        event: { type: "proposal.generated", level: "success", agent: "proposal", runId: ctx.runId, subjectType: "proposal", subjectId: row.id, message, data: { opportunityId: opp.id, priceUsd: price.priceUsd, basis: price.basis, estimateId } },
      });
      await notify(db, {
        tenantId,
        kind: "approval",
        title: `Approve proposal for “${opp.title.slice(0, 80)}”`,
        body: `${money(price.priceUsd)} (${price.basis}) · ${pct(econ.economics.grossMargin)} margin · ${timelineDays} days`,
        link: `/applications?proposal=${row.id}`,
        dedupeKey: `proposal-approve:${row.id}`,
      });
      ctx.summary = message;
      return { status: "generated" as const, proposalId: row.id, priceUsd: price.priceUsd, economics: econ.economics };
    },
  );
}
