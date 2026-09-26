import {
  and,
  desc,
  eq,
  application,
  client,
  costEstimate,
  costLedgerEntry,
  emitEvent,
  getTenantSettings,
  job,
  opportunity,
  opportunityAnalysis,
  proposal,
  transition,
  type Actor,
  type Executor,
} from "@gigpilot/db";

/**
 * Converts a won application into a job (idempotent per application).
 * Shared by the owner's "Mark won" command and the demo marketplace award.
 * Must run inside a transaction; caller enqueues job-plan after commit.
 */
export async function createJobFromApplication(
  db: Executor,
  input: { tenantId: string; applicationId: string; actor: Actor },
): Promise<{ jobId: string; created: boolean }> {
  const existing = await db.select({ id: job.id }).from(job).where(eq(job.applicationId, input.applicationId)).limit(1);
  if (existing[0]) return { jobId: existing[0].id, created: false };

  const [app] = await db
    .select()
    .from(application)
    .where(and(eq(application.id, input.applicationId), eq(application.tenantId, input.tenantId)))
    .limit(1);
  if (!app) throw new Error("Application not found");

  const [opp] = await db.select().from(opportunity).where(eq(opportunity.id, app.opportunityId)).limit(1);
  if (!opp) throw new Error("Opportunity not found");

  const [prop] = app.proposalId ? await db.select().from(proposal).where(eq(proposal.id, app.proposalId)).limit(1) : [];
  const [analysisRow] = await db
    .select()
    .from(opportunityAnalysis)
    .where(eq(opportunityAnalysis.opportunityId, opp.id))
    .orderBy(desc(opportunityAnalysis.version))
    .limit(1);
  const [estimate] = await db
    .select()
    .from(costEstimate)
    .where(eq(costEstimate.opportunityId, opp.id))
    .orderBy(desc(costEstimate.createdAt))
    .limit(1);

  const settings = await getTenantSettings(db, input.tenantId);

  // Winning is recorded on the application + opportunity before the job exists.
  await transition(db, {
    machine: "application",
    id: app.id,
    tenantId: input.tenantId,
    to: "won",
    actor: input.actor,
    reason: "client awarded the work",
    patch: { decidedAt: new Date() },
    event: {
      type: "application.won",
      level: "success",
      agent: "client",
      subjectType: "application",
      subjectId: app.id,
      message: `Won: ${opp.title}`,
    },
  });
  if (opp.status === "applied") {
    await transition(db, { machine: "opportunity", id: opp.id, tenantId: input.tenantId, to: "won", actor: input.actor });
  }

  const [c] = await db
    .insert(client)
    .values({
      tenantId: input.tenantId,
      name: opp.clientName ?? "Client",
      sourceKey: opp.sourceKey,
      country: opp.clientCountry,
    })
    .returning({ id: client.id });

  const analysis = analysisRow?.analysis;
  const acceptance = analysis
    ? [
        ...analysis.deliverables.map((d) => `${d.quantity}× ${d.item}${d.format ? ` (${d.format})` : ""}`),
        ...analysis.proposedWorkflow.flatMap((s) => s.acceptance),
      ].slice(0, 16)
    : [];
  const priceUsd = prop?.priceUsd ?? app.priceUsd ?? opp.priceUsd ?? 0;
  // Expected production spend (the forecast the ±20% accuracy goal is measured against).
  // Revision contingency and general contingency are buffers, reflected in the spend limit instead.
  const estimatedCostUsd = estimate?.breakdown ? estimate.breakdown.fulfilmentCostUsd : 0;
  const bufferedCostUsd = estimate?.breakdown
    ? estimate.breakdown.fulfilmentCostUsd + estimate.breakdown.revisionContingencyUsd + estimate.breakdown.contingencyUsd
    : 0;
  const dueAt = prop?.timelineDays ? new Date(Date.now() + prop.timelineDays * 86_400_000) : opp.deadlineAt;

  const [j] = await db
    .insert(job)
    .values({
      tenantId: input.tenantId,
      opportunityId: opp.id,
      applicationId: app.id,
      clientId: c?.id ?? null,
      title: opp.title,
      serviceFamily: analysis?.serviceFamily ?? opp.marketKey ?? "research-content",
      status: "intake",
      priceUsd,
      spendLimitUsd: Math.min(settings.limits.perJobSpendLimitUsd, Math.max(bufferedCostUsd * 2.5, 10)),
      estimatedCostUsd,
      acceptanceCriteria: acceptance,
      brief: analysis?.summary ?? opp.description.slice(0, 2000),
      dueAt,
    })
    .returning({ id: job.id });
  if (!j) throw new Error("Job insert failed");

  await db.insert(costLedgerEntry).values([
    {
      tenantId: input.tenantId,
      jobId: j.id,
      opportunityId: opp.id,
      category: "revenue",
      kind: "estimate",
      amountUsd: priceUsd,
      memo: "Contract value (awarded)",
    },
    ...(estimate?.breakdown
      ? [
          {
            tenantId: input.tenantId,
            jobId: j.id,
            opportunityId: opp.id,
            category: "marketplace_fee" as const,
            kind: "estimate" as const,
            provider: opp.sourceKey,
            amountUsd: estimate.breakdown.platformFeesUsd,
            memo: `Expected ${opp.sourceKey} fee`,
          },
        ]
      : []),
  ]);

  await emitEvent(db, {
    tenantId: input.tenantId,
    type: "job.created",
    level: "success",
    agent: "orchestrator",
    subjectType: "job",
    subjectId: j.id,
    jobId: j.id,
    message: `Job opened: ${opp.title}`,
    data: { priceUsd, estimatedCostUsd },
  });

  return { jobId: j.id, created: true };
}
