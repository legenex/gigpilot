/**
 * Owner-facing commands (the application service layer). Called by dashboard
 * server actions and API routes. Every command:
 *   - is scoped to ctx.tenantId (tenant isolation),
 *   - validates state transitions (audited via @gigpilot/db `transition`),
 *   - enqueues background work only AFTER its transaction commits.
 */
import { z } from "zod";
import {
  QUEUES,
  integrationByKey,
  resolveTenantSettings,
  tenantSettingsSchema,
  type TenantSettingsInput,
} from "@gigpilot/contracts";
import {
  and,
  application,
  audit,
  clearTenantSecret,
  delivery,
  desc,
  emitEvent,
  eq,
  getDb,
  inArray,
  isNull,
  job,
  market,
  marketInsight,
  notification,
  opportunity,
  proposal,
  providerIntegration,
  revision,
  saveTenantSecret,
  sourceIntegration,
  tenant,
  transition,
  workflowStep,
  type Actor,
} from "@gigpilot/db";
import { enqueue } from "@gigpilot/db/queue";
import { dedupeHash } from "@gigpilot/economics";
import { createJobFromApplication } from "./domain/jobs";

export interface CommandContext {
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" = "invalid",
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function actor(ctx: CommandContext): Actor {
  return { type: "user", id: ctx.userId };
}

function requireOperator(ctx: CommandContext) {
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new CommandError("Only owners and admins can do this.", "forbidden");
}

async function loadOpportunity(ctx: CommandContext, id: string) {
  const [row] = await getDb()
    .select()
    .from(opportunity)
    .where(and(eq(opportunity.id, id), eq(opportunity.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new CommandError("Opportunity not found", "not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export async function shortlistOpportunity(ctx: CommandContext, opportunityId: string) {
  requireOperator(ctx);
  const opp = await loadOpportunity(ctx, opportunityId);
  await transition(getDb(), {
    machine: "opportunity",
    id: opp.id,
    tenantId: ctx.tenantId,
    to: "shortlisted",
    actor: actor(ctx),
    event: { type: "opportunity.shortlisted", agent: "orchestrator", subjectType: "opportunity", subjectId: opp.id, message: `Shortlisted: ${opp.title}` },
  });
}

/** Owner approves pursuing an opportunity → Proposal Agent drafts a proposal. */
export async function approveOpportunity(ctx: CommandContext, opportunityId: string) {
  requireOperator(ctx);
  const db = getDb();
  const opp = await loadOpportunity(ctx, opportunityId);
  await db.transaction(async (tx) => {
    await transition(tx, {
      machine: "opportunity",
      id: opp.id,
      tenantId: ctx.tenantId,
      to: "pursuing",
      actor: actor(ctx),
      reason: "owner approved pursuit",
      event: {
        type: "opportunity.shortlisted",
        level: "success",
        agent: "orchestrator",
        subjectType: "opportunity",
        subjectId: opp.id,
        message: `Owner approved pursuit: ${opp.title}`,
      },
    });
  });
  const existing = await db
    .select({ id: proposal.id })
    .from(proposal)
    .where(and(eq(proposal.opportunityId, opp.id), inArray(proposal.status, ["draft", "awaiting_approval", "approved"])))
    .limit(1);
  if (!existing[0]) {
    await enqueue(QUEUES.proposalGenerate, { tenantId: ctx.tenantId, opportunityId: opp.id, requestedBy: ctx.userId }, { singletonKey: opp.id });
  }
}

export async function rejectOpportunity(ctx: CommandContext, opportunityId: string, reason?: string) {
  requireOperator(ctx);
  const opp = await loadOpportunity(ctx, opportunityId);
  await transition(getDb(), {
    machine: "opportunity",
    id: opp.id,
    tenantId: ctx.tenantId,
    to: "rejected",
    actor: actor(ctx),
    reason: reason ?? "owner rejected",
    event: { type: "opportunity.rejected", agent: "orchestrator", subjectType: "opportunity", subjectId: opp.id, message: `Rejected: ${opp.title}` },
  });
}

/** Ask the Proposal Agent for a (new) draft. */
export async function requestProposal(ctx: CommandContext, opportunityId: string) {
  requireOperator(ctx);
  const opp = await loadOpportunity(ctx, opportunityId);
  await enqueue(QUEUES.proposalGenerate, { tenantId: ctx.tenantId, opportunityId: opp.id, requestedBy: ctx.userId }, { singletonKey: opp.id });
}

export async function reanalyseOpportunity(ctx: CommandContext, opportunityId: string) {
  requireOperator(ctx);
  const opp = await loadOpportunity(ctx, opportunityId);
  await enqueue(QUEUES.opportunityAnalyse, { tenantId: ctx.tenantId, opportunityId: opp.id, force: true }, { singletonKey: opp.id });
}

export const manualOpportunitySchema = z.object({
  sourceKey: z.enum(["upwork", "freelancer", "contra", "fiverr", "web", "direct"]),
  title: z.string().trim().min(4).max(300),
  description: z.string().trim().min(20).max(20_000),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), "http(s) only")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  clientName: z.string().trim().max(200).optional(),
  budgetType: z.enum(["fixed", "hourly", "unknown"]).default("fixed"),
  budgetMinUsd: z.coerce.number().min(0).max(10_000_000).optional(),
  budgetMaxUsd: z.coerce.number().min(0).max(10_000_000).optional(),
  deadlineAt: z.coerce.date().optional(),
});

/** Paste-in / direct prospect ingestion (the compliant path for Contra, Fiverr, Upwork manual). */
export async function addManualOpportunity(ctx: CommandContext, input: z.input<typeof manualOpportunitySchema>) {
  requireOperator(ctx);
  const data = manualOpportunitySchema.parse(input);
  const db = getDb();
  const externalId = `manual-${dedupeHash(data.title, data.description)}`;
  const [row] = await db
    .insert(opportunity)
    .values({
      tenantId: ctx.tenantId,
      sourceKey: data.sourceKey,
      externalId,
      url: data.url ?? null,
      title: data.title,
      description: data.description,
      clientName: data.clientName ?? null,
      budgetType: data.budgetType,
      budgetMinUsd: data.budgetMinUsd ?? null,
      budgetMaxUsd: data.budgetMaxUsd ?? data.budgetMinUsd ?? null,
      deadlineAt: data.deadlineAt ?? null,
      postedAt: new Date(),
      dedupeHash: dedupeHash(data.title, data.description),
      raw: { ingestion: "manual", addedBy: ctx.userId },
    })
    .onConflictDoNothing()
    .returning({ id: opportunity.id });
  if (!row) throw new CommandError("This opportunity was already added.", "conflict");
  await emitEvent(db, {
    tenantId: ctx.tenantId,
    type: "opportunity.discovered",
    agent: "scout",
    subjectType: "opportunity",
    subjectId: row.id,
    message: `Added manually from ${data.sourceKey}: ${data.title}`,
  });
  await enqueue(QUEUES.opportunityAnalyse, { tenantId: ctx.tenantId, opportunityId: row.id }, { singletonKey: row.id });
  return { opportunityId: row.id };
}

// ---------------------------------------------------------------------------
// Proposals & applications
// ---------------------------------------------------------------------------

export const proposalEditSchema = z.object({
  headline: z.string().trim().min(3).max(300).optional(),
  coverLetter: z.string().trim().min(40).max(12_000).optional(),
  priceUsd: z.coerce.number().min(1).max(10_000_000).optional(),
  timelineDays: z.coerce.number().int().min(1).max(365).optional(),
  assumptions: z.array(z.string().max(500)).max(30).optional(),
});

export async function updateProposalDraft(ctx: CommandContext, proposalId: string, edits: z.input<typeof proposalEditSchema>) {
  requireOperator(ctx);
  const data = proposalEditSchema.parse(edits);
  const db = getDb();
  const [p] = await db
    .select()
    .from(proposal)
    .where(and(eq(proposal.id, proposalId), eq(proposal.tenantId, ctx.tenantId)))
    .limit(1);
  if (!p) throw new CommandError("Proposal not found", "not_found");
  if (!["draft", "awaiting_approval"].includes(p.status)) throw new CommandError("Only drafts can be edited", "conflict");
  await db.update(proposal).set(data).where(eq(proposal.id, p.id));
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "proposal.edited", subjectType: "proposal", subjectId: p.id, data: { fields: Object.keys(data) } });
}

/**
 * Commercial-commitment gate. Owner approves proposal, price, scope and
 * assumptions; GigPilot then submits where the marketplace officially
 * permits it (worker decides), otherwise it is queued for manual submission.
 */
export async function approveProposal(ctx: CommandContext, proposalId: string) {
  requireOperator(ctx);
  const db = getDb();
  const [p] = await db
    .select()
    .from(proposal)
    .where(and(eq(proposal.id, proposalId), eq(proposal.tenantId, ctx.tenantId)))
    .limit(1);
  if (!p) throw new CommandError("Proposal not found", "not_found");

  const applicationId = await db.transaction(async (tx) => {
    await transition(tx, {
      machine: "proposal",
      id: p.id,
      tenantId: ctx.tenantId,
      to: "approved",
      actor: actor(ctx),
      reason: "owner approved proposal, price and scope",
      patch: { approvedBy: ctx.userId, approvedAt: new Date() },
      event: {
        type: "proposal.approved",
        level: "success",
        agent: "proposal",
        subjectType: "proposal",
        subjectId: p.id,
        message: `Proposal approved at $${Math.round(p.priceUsd)}`,
      },
    });
    const [opp] = await tx.select().from(opportunity).where(eq(opportunity.id, p.opportunityId)).limit(1);
    if (opp && ["analysed", "shortlisted"].includes(opp.status)) {
      await transition(tx, { machine: "opportunity", id: opp.id, tenantId: ctx.tenantId, to: "pursuing", actor: actor(ctx) });
    }
    const idempotencyKey = `application:${p.opportunityId}:${p.id}`;
    const [inserted] = await tx
      .insert(application)
      .values({
        tenantId: ctx.tenantId,
        opportunityId: p.opportunityId,
        proposalId: p.id,
        status: "awaiting_approval",
        idempotencyKey,
        priceUsd: p.priceUsd,
      })
      .onConflictDoNothing()
      .returning({ id: application.id });
    const appId =
      inserted?.id ??
      (
        await tx
          .select({ id: application.id })
          .from(application)
          .where(and(eq(application.tenantId, ctx.tenantId), eq(application.idempotencyKey, idempotencyKey)))
          .limit(1)
      )[0]?.id;
    if (!appId) throw new CommandError("Could not create application", "conflict");
    await transition(tx, {
      machine: "application",
      id: appId,
      tenantId: ctx.tenantId,
      to: "approved",
      actor: actor(ctx),
      reason: "proposal approved",
    });
    return appId;
  });

  await enqueue(QUEUES.applicationSubmit, { tenantId: ctx.tenantId, applicationId }, { singletonKey: applicationId });
  return { applicationId };
}

export async function rejectProposal(ctx: CommandContext, proposalId: string, reason?: string) {
  requireOperator(ctx);
  const db = getDb();
  const [p] = await db
    .select()
    .from(proposal)
    .where(and(eq(proposal.id, proposalId), eq(proposal.tenantId, ctx.tenantId)))
    .limit(1);
  if (!p) throw new CommandError("Proposal not found", "not_found");
  await transition(db, {
    machine: "proposal",
    id: p.id,
    tenantId: ctx.tenantId,
    to: "rejected",
    actor: actor(ctx),
    reason: reason ?? "owner rejected proposal",
    event: { type: "proposal.rejected", agent: "proposal", subjectType: "proposal", subjectId: p.id, message: "Proposal rejected by owner" },
  });
}

/** Owner confirms they submitted a manually-submitted application on the marketplace. */
export async function markApplicationSubmitted(ctx: CommandContext, applicationId: string, externalRef?: string) {
  requireOperator(ctx);
  const db = getDb();
  await db.transaction(async (tx) => {
    const [app] = await tx
      .select()
      .from(application)
      .where(and(eq(application.id, applicationId), eq(application.tenantId, ctx.tenantId)))
      .limit(1);
    if (!app) throw new CommandError("Application not found", "not_found");
    await transition(tx, {
      machine: "application",
      id: app.id,
      tenantId: ctx.tenantId,
      to: "submitted",
      actor: actor(ctx),
      reason: "owner submitted on marketplace",
      patch: { submittedAt: new Date(), submissionMode: "manual", externalRef: externalRef ?? null },
      event: { type: "application.submitted", agent: "client", subjectType: "application", subjectId: app.id, message: "Submitted manually by owner" },
    });
    const [opp] = await tx.select().from(opportunity).where(eq(opportunity.id, app.opportunityId)).limit(1);
    if (opp && opp.status === "pursuing") {
      await transition(tx, { machine: "opportunity", id: opp.id, tenantId: ctx.tenantId, to: "applied", actor: actor(ctx) });
    }
  });
}

export async function recordApplicationOutcome(
  ctx: CommandContext,
  applicationId: string,
  outcome: "client_response" | "negotiating" | "won" | "lost",
) {
  requireOperator(ctx);
  const db = getDb();
  let jobId: string | undefined;
  await db.transaction(async (tx) => {
    const [app] = await tx
      .select()
      .from(application)
      .where(and(eq(application.id, applicationId), eq(application.tenantId, ctx.tenantId)))
      .limit(1);
    if (!app) throw new CommandError("Application not found", "not_found");
    if (outcome === "won") {
      const res = await createJobFromApplication(tx, { tenantId: ctx.tenantId, applicationId: app.id, actor: actor(ctx) });
      jobId = res.jobId;
      return;
    }
    await transition(tx, {
      machine: "application",
      id: app.id,
      tenantId: ctx.tenantId,
      to: outcome,
      actor: actor(ctx),
      patch: outcome === "lost" ? { decidedAt: new Date() } : {},
      event: {
        type: outcome === "lost" ? "application.lost" : "application.submitted",
        agent: "client",
        subjectType: "application",
        subjectId: app.id,
        message: outcome === "lost" ? "Application lost" : `Client response: ${outcome.replace("_", " ")}`,
      },
    });
    if (outcome === "lost") {
      const [opp] = await tx.select().from(opportunity).where(eq(opportunity.id, app.opportunityId)).limit(1);
      if (opp && opp.status === "applied") await transition(tx, { machine: "opportunity", id: opp.id, tenantId: ctx.tenantId, to: "lost", actor: actor(ctx) });
    }
  });
  if (jobId) await enqueue(QUEUES.jobPlan, { tenantId: ctx.tenantId, jobId }, { singletonKey: jobId });
  return { jobId };
}

// ---------------------------------------------------------------------------
// Jobs & delivery
// ---------------------------------------------------------------------------

async function loadJob(ctx: CommandContext, jobId: string) {
  const [row] = await getDb()
    .select()
    .from(job)
    .where(and(eq(job.id, jobId), eq(job.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new CommandError("Job not found", "not_found");
  return row;
}

/** Final-delivery gate: owner approves the prepared package. */
export async function approveFinalDelivery(ctx: CommandContext, jobId: string) {
  requireOperator(ctx);
  const db = getDb();
  const j = await loadJob(ctx, jobId);
  await db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(delivery)
      .where(and(eq(delivery.jobId, j.id), eq(delivery.status, "prepared")))
      .orderBy(desc(delivery.createdAt))
      .limit(1);
    if (!d) throw new CommandError("No prepared delivery package to approve yet", "conflict");
    await transition(tx, {
      machine: "delivery",
      id: d.id,
      tenantId: ctx.tenantId,
      to: "approved",
      actor: actor(ctx),
      patch: { approvedBy: ctx.userId, approvedAt: new Date() },
      event: {
        type: "delivery.approved",
        level: "success",
        agent: "client",
        subjectType: "delivery",
        subjectId: d.id,
        jobId: j.id,
        message: "Owner approved final delivery",
      },
    });
    await transition(tx, {
      machine: "job",
      id: j.id,
      tenantId: ctx.tenantId,
      to: "delivered",
      actor: actor(ctx),
      patch: { completedAt: new Date() },
      event: { type: "job.state", level: "success", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `Delivered: ${j.title}` },
    });
  });
}

export async function requestJobRevision(ctx: CommandContext, jobId: string, note: string) {
  requireOperator(ctx);
  const text = z.string().trim().min(3).max(4000).parse(note);
  const db = getDb();
  const j = await loadJob(ctx, jobId);
  await db.transaction(async (tx) => {
    await tx.insert(revision).values({ tenantId: ctx.tenantId, jobId: j.id, request: text, status: "open" });
    await transition(tx, {
      machine: "job",
      id: j.id,
      tenantId: ctx.tenantId,
      to: "repairing",
      actor: actor(ctx),
      reason: "owner requested changes",
      event: { type: "job.state", agent: "recovery", subjectType: "job", subjectId: j.id, jobId: j.id, message: "Owner requested changes — Recovery Agent reopening work" },
    });
  });
  await enqueue(QUEUES.workflowTick, { tenantId: ctx.tenantId, jobId: j.id }, { singletonKey: j.id });
}

export async function closeJob(ctx: CommandContext, jobId: string) {
  requireOperator(ctx);
  const j = await loadJob(ctx, jobId);
  await transition(getDb(), { machine: "job", id: j.id, tenantId: ctx.tenantId, to: "closed", actor: actor(ctx) });
}

export async function cancelJob(ctx: CommandContext, jobId: string, reason?: string) {
  requireOperator(ctx);
  const j = await loadJob(ctx, jobId);
  await transition(getDb(), { machine: "job", id: j.id, tenantId: ctx.tenantId, to: "cancelled", actor: actor(ctx), reason });
}

/** Manually retry a failed/blocked step (still bounded by maxAttempts). */
export async function retryStep(ctx: CommandContext, stepId: string) {
  requireOperator(ctx);
  const db = getDb();
  const [s] = await db
    .select()
    .from(workflowStep)
    .where(and(eq(workflowStep.id, stepId), eq(workflowStep.tenantId, ctx.tenantId)))
    .limit(1);
  if (!s) throw new CommandError("Step not found", "not_found");
  if (s.attempts >= s.maxAttempts) throw new CommandError("Attempt limit reached for this step", "conflict");
  await transition(db, { machine: "step", id: s.id, tenantId: ctx.tenantId, to: "ready", actor: actor(ctx), reason: "manual retry" });
  await enqueue(QUEUES.workflowTick, { tenantId: ctx.tenantId, jobId: s.jobId }, { singletonKey: s.jobId });
}

// ---------------------------------------------------------------------------
// Settings, markets, sources, integrations
// ---------------------------------------------------------------------------

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] =
      typeof v === "object" && v !== null && !Array.isArray(v) && typeof cur === "object" && cur !== null && !Array.isArray(cur)
        ? deepMerge(cur, v)
        : v;
  }
  return out as T;
}

export async function updateSettings(ctx: CommandContext, patch: TenantSettingsInput) {
  requireOperator(ctx);
  const db = getDb();
  const [t] = await db.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, ctx.tenantId)).limit(1);
  const merged = deepMerge(resolveTenantSettings(t?.settings), patch);
  const parsed = tenantSettingsSchema.safeParse(merged);
  if (!parsed.success) throw new CommandError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  await db.update(tenant).set({ settings: parsed.data }).where(eq(tenant.id, ctx.tenantId));
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "settings.updated", subjectType: "tenant", subjectId: ctx.tenantId, data: { patch } });
  return parsed.data;
}

export async function updateMarket(ctx: CommandContext, marketKey: string, patch: { enabled?: boolean; allocationPct?: number }) {
  requireOperator(ctx);
  const data = z.object({ enabled: z.boolean().optional(), allocationPct: z.number().min(0).max(100).optional() }).parse(patch);
  const db = getDb();
  const res = await db
    .update(market)
    .set(data)
    .where(and(eq(market.tenantId, ctx.tenantId), eq(market.key, marketKey)))
    .returning({ id: market.id });
  if (!res[0]) throw new CommandError("Market not found", "not_found");
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "market.updated", subjectType: "market", subjectId: res[0].id, data });
}

export async function applyMarketRecommendation(ctx: CommandContext, insightId: string) {
  requireOperator(ctx);
  const db = getDb();
  const [ins] = await db
    .select()
    .from(marketInsight)
    .where(and(eq(marketInsight.id, insightId), eq(marketInsight.tenantId, ctx.tenantId)))
    .limit(1);
  if (!ins) throw new CommandError("Insight not found", "not_found");
  await db.transaction(async (tx) => {
    for (const r of ins.body.recommendations) {
      const patch: { enabled?: boolean; allocationPct?: number } = {};
      if (typeof r.toPct === "number") patch.allocationPct = r.toPct;
      if (r.action === "enable") patch.enabled = true;
      if (r.action === "disable") patch.enabled = false;
      if (Object.keys(patch).length) {
        await tx.update(market).set(patch).where(and(eq(market.tenantId, ctx.tenantId), eq(market.key, r.marketKey)));
      }
    }
    await audit(tx, { tenantId: ctx.tenantId, actor: actor(ctx), action: "market.recommendation_applied", subjectType: "market", data: { insightId } });
    await emitEvent(tx, {
      tenantId: ctx.tenantId,
      type: "market.insight",
      agent: "market_research",
      message: `Applied allocation recommendation: ${ins.headline}`,
      level: "success",
    });
  });
}

export async function setSourceEnabled(ctx: CommandContext, sourceKey: string, enabled: boolean) {
  requireOperator(ctx);
  const db = getDb();
  const res = await db
    .update(sourceIntegration)
    .set({ enabled })
    .where(and(eq(sourceIntegration.tenantId, ctx.tenantId), eq(sourceIntegration.sourceKey, sourceKey)))
    .returning({ id: sourceIntegration.id });
  if (!res[0]) throw new CommandError("Source not found", "not_found");
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: enabled ? "source.enabled" : "source.disabled", subjectType: "source", subjectId: res[0].id, data: { sourceKey } });
}

export async function updateSourceConfig(ctx: CommandContext, sourceKey: string, config: Record<string, unknown>) {
  requireOperator(ctx);
  const clean = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(2000)).max(50)])).parse(config);
  const db = getDb();
  await db
    .update(sourceIntegration)
    .set({ config: clean })
    .where(and(eq(sourceIntegration.tenantId, ctx.tenantId), eq(sourceIntegration.sourceKey, sourceKey)));
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "source.configured", subjectType: "source", data: { sourceKey, keys: Object.keys(clean) } });
}

/** User-directed refresh (the only permitted way to search Upwork). */
export async function triggerSourceRefresh(ctx: CommandContext, sourceKey: string) {
  requireOperator(ctx);
  await enqueue(QUEUES.sourceRefresh, { tenantId: ctx.tenantId, sourceKey }, { singletonKey: `${ctx.tenantId}:${sourceKey}` });
}

export async function saveProviderSecret(ctx: CommandContext, providerKey: string, name: string, value: string) {
  requireOperator(ctx);
  const desc_ = integrationByKey(providerKey);
  if (!desc_ || !desc_.secretFields.some((f) => f.name === name)) throw new CommandError("Unknown credential field");
  const v = z.string().trim().min(8).max(4096).parse(value);
  const db = getDb();
  await saveTenantSecret(db, ctx.tenantId, providerKey, name, v);
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "credential.saved", subjectType: "provider", data: { providerKey, name } });
  await enqueue(QUEUES.providerHealth, {}, {});
}

export async function clearProviderSecret(ctx: CommandContext, providerKey: string, name?: string) {
  requireOperator(ctx);
  const db = getDb();
  await clearTenantSecret(db, ctx.tenantId, providerKey, name);
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "credential.cleared", subjectType: "provider", data: { providerKey, name } });
}

export async function setProviderEnabled(ctx: CommandContext, providerKey: string, enabled: boolean) {
  requireOperator(ctx);
  const db = getDb();
  await db
    .update(providerIntegration)
    .set({ enabled })
    .where(and(eq(providerIntegration.tenantId, ctx.tenantId), eq(providerIntegration.providerKey, providerKey)));
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: enabled ? "provider.enabled" : "provider.disabled", subjectType: "provider", data: { providerKey } });
}

export async function markNotificationsRead(ctx: CommandContext, ids?: string[]) {
  const db = getDb();
  const base = and(eq(notification.tenantId, ctx.tenantId), isNull(notification.readAt));
  await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(ids && ids.length ? and(base, inArray(notification.id, ids)) : base);
}
