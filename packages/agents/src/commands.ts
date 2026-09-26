/**
 * Owner-facing commands (the application service layer). Called by dashboard
 * server actions and API routes. Every command:
 *   - is scoped to ctx.tenantId (tenant isolation),
 *   - validates state transitions (audited via @gigpilot/db `transition`),
 *   - enqueues background work only AFTER its transaction commits.
 */
import { z } from "zod";
import { env, OPERATIONAL_DEFAULTS } from "@gigpilot/config";
import {
  INTEGRATION_STATUSES,
  QUEUES,
  integrationByKey,
  resolveTenantSettings,
  tenantSettingsSchema,
  type ProviderHealth,
  type QueuePayloads,
  type RawOpportunity,
  type TenantSettingsInput,
} from "@gigpilot/contracts";
import {
  agentRun,
  and,
  application,
  asc,
  audit,
  clearTenantSecret,
  costLedgerEntry,
  delivery,
  desc,
  emitEvent,
  eq,
  getDb,
  getTenantSettings,
  gte,
  inArray,
  isNull,
  job,
  market,
  marketInsight,
  notification,
  opportunity,
  opportunityAnalysis,
  proposal,
  providerIntegration,
  repair,
  revision,
  saveTenantSecret,
  sourceIntegration,
  tenant,
  transition,
  workflow,
  workflowStep,
  type Actor,
} from "@gigpilot/db";
import { enqueue } from "@gigpilot/db/queue";
import { dedupeHash, findDuplicate } from "@gigpilot/economics";
import { matchMarket, normaliseRaw } from "./agents/scout";
import { createJobFromApplication } from "./domain/jobs";
import { isQaStep } from "./heuristics/workflows";
import { blockedReasonOf, clearBlockMarkers, isOwnerBlocked } from "./lib/steps";

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

/** Applications that still represent a live bid for an opportunity (a new proposal would duplicate it). */
const LIVE_APPLICATION_STATES = ["awaiting_approval", "approved", "submitted", "client_response", "negotiating", "won"] as const;

async function liveApplicationFor(tenantId: string, opportunityId: string) {
  const [row] = await getDb()
    .select({ id: application.id, status: application.status, proposalId: application.proposalId })
    .from(application)
    .where(and(eq(application.tenantId, tenantId), eq(application.opportunityId, opportunityId), inArray(application.status, [...LIVE_APPLICATION_STATES])))
    .limit(1);
  return row;
}

/** Ask the Proposal Agent for a (new) draft. Only for open opportunities without a live application. */
export async function requestProposal(ctx: CommandContext, opportunityId: string) {
  requireOperator(ctx);
  const opp = await loadOpportunity(ctx, opportunityId);
  if (!["analysed", "shortlisted", "pursuing"].includes(opp.status)) {
    throw new CommandError(`A proposal can only be drafted for an analysed, shortlisted or pursued opportunity (this one is ${opp.status}).`, "conflict");
  }
  const live = await liveApplicationFor(ctx.tenantId, opp.id);
  if (live) throw new CommandError(`This opportunity already has an application (${live.status.replace(/_/g, " ")}); a new proposal would duplicate it.`, "conflict");
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
  const live = await liveApplicationFor(ctx.tenantId, p.opportunityId);
  if (live && live.proposalId !== p.id) {
    throw new CommandError(`This opportunity already has an application (${live.status.replace(/_/g, " ")}) from another proposal.`, "conflict");
  }

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
    // Estimate vs actual: record the contract value and marketplace fee as actuals on delivery (once).
    const ledger = await tx
      .select({ category: costLedgerEntry.category, kind: costLedgerEntry.kind, amountUsd: costLedgerEntry.amountUsd, provider: costLedgerEntry.provider })
      .from(costLedgerEntry)
      .where(eq(costLedgerEntry.jobId, j.id));
    if (!ledger.some((l) => l.category === "revenue" && l.kind === "actual")) {
      const feeEstimate = ledger.find((l) => l.category === "marketplace_fee" && l.kind === "estimate");
      await tx.insert(costLedgerEntry).values([
        { tenantId: ctx.tenantId, jobId: j.id, opportunityId: j.opportunityId, category: "revenue", kind: "actual", amountUsd: j.priceUsd, memo: "Contract value (delivered)" },
        ...(feeEstimate
          ? [{ tenantId: ctx.tenantId, jobId: j.id, opportunityId: j.opportunityId, category: "marketplace_fee" as const, kind: "actual" as const, provider: feeEstimate.provider, amountUsd: feeEstimate.amountUsd, memo: "Marketplace fee on delivery" }]
          : []),
      ]);
    }
  });
}

/** States in which an owner revision is processed (the package exists and production is idle). */
export const REVISABLE_JOB_STATES = ["awaiting_final_approval", "delivered"] as const;

export async function requestJobRevision(ctx: CommandContext, jobId: string, note: string) {
  requireOperator(ctx);
  const text = z.string().trim().min(3).max(4000).parse(note);
  const db = getDb();
  const j = await loadJob(ctx, jobId);
  if (!(REVISABLE_JOB_STATES as readonly string[]).includes(j.status)) {
    throw new CommandError(`Changes can be requested once the delivery package is ready (the job is ${j.status.replace(/_/g, " ")}).`, "conflict");
  }
  await db.transaction(async (tx) => {
    await tx.insert(revision).values({ tenantId: ctx.tenantId, jobId: j.id, request: text, status: "open" });
    await transition(tx, {
      machine: "job",
      id: j.id,
      tenantId: ctx.tenantId,
      to: "repairing",
      actor: actor(ctx),
      reason: "owner requested changes",
      expectFrom: [...REVISABLE_JOB_STATES],
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

/**
 * Cancel a job and everything in flight for it: pending/ready/running/
 * blocked/failed steps → cancelled and queued/running agent runs → cancelled
 * (all audited). Deliveries are left untouched (history). Running handlers
 * notice at their next checkpoint and stop without writing results.
 */
export async function cancelJob(ctx: CommandContext, jobId: string, reason?: string) {
  requireOperator(ctx);
  const j = await loadJob(ctx, jobId);
  const db = getDb();
  const who = actor(ctx);
  const why = reason ?? "owner cancelled the job";
  const counts = await db.transaction(async (tx) => {
    await transition(tx, {
      machine: "job",
      id: j.id,
      tenantId: ctx.tenantId,
      to: "cancelled",
      actor: who,
      reason: why,
      event: { type: "job.state", level: "warn", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `Cancelled: ${j.title}` },
    });
    const steps = await tx
      .select({ id: workflowStep.id, status: workflowStep.status })
      .from(workflowStep)
      .where(and(eq(workflowStep.jobId, j.id), eq(workflowStep.tenantId, ctx.tenantId), inArray(workflowStep.status, ["pending", "ready", "running", "blocked", "failed"])));
    for (const st of steps) {
      await transition(tx, { machine: "step", id: st.id, tenantId: ctx.tenantId, to: "cancelled", actor: who, reason: `job cancelled: ${why}`, patch: { finishedAt: new Date() } });
    }
    const runs = await tx
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(and(eq(agentRun.jobId, j.id), eq(agentRun.tenantId, ctx.tenantId), inArray(agentRun.status, ["queued", "running"])));
    for (const r of runs) {
      await transition(tx, { machine: "run", id: r.id, tenantId: ctx.tenantId, to: "cancelled", actor: who, reason: "job cancelled", patch: { finishedAt: new Date(), error: "job cancelled by the owner" } });
    }
    return { steps: steps.length, runs: runs.length };
  });
  return counts;
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
  if (s.attempts >= s.maxAttempts) throw new CommandError("Attempt limit reached for this step — resume the job to authorise more attempts", "conflict");
  if (!["failed", "blocked"].includes(s.status)) throw new CommandError(`Only failed or blocked steps can be retried (this one is ${s.status}).`, "conflict");
  await transition(db, { machine: "step", id: s.id, tenantId: ctx.tenantId, to: "ready", actor: actor(ctx), reason: "manual retry", patch: { output: clearBlockMarkers(s.output) } });
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

/** Dotted key paths touched by a settings patch (values are never written to the audit log). */
function changedSettingPaths(patch: unknown, prefix = ""): string[] {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return prefix ? [prefix] : [];
  return Object.entries(patch as Record<string, unknown>).flatMap(([k, v]) => changedSettingPaths(v, prefix ? `${prefix}.${k}` : k));
}

export async function updateSettings(ctx: CommandContext, patch: TenantSettingsInput) {
  requireOperator(ctx);
  const db = getDb();
  const [t] = await db.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, ctx.tenantId)).limit(1);
  const merged = deepMerge(resolveTenantSettings(t?.settings), patch);
  const parsed = tenantSettingsSchema.safeParse(merged);
  if (!parsed.success) throw new CommandError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  await db.update(tenant).set({ settings: parsed.data }).where(eq(tenant.id, ctx.tenantId));
  await audit(db, { tenantId: ctx.tenantId, actor: actor(ctx), action: "settings.updated", subjectType: "tenant", subjectId: ctx.tenantId, data: { changed: changedSettingPaths(patch) } });
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
  await enqueue(QUEUES.sourceRefresh, { tenantId: ctx.tenantId, sourceKey, trigger: "user" } as QueuePayloads["source-refresh"], { singletonKey: `${ctx.tenantId}:${sourceKey}` });
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

// ---------------------------------------------------------------------------
// Owner escalations: inputs, resume, spend limit
// ---------------------------------------------------------------------------

async function loadActiveWorkflowSteps(tenantId: string, jobId: string) {
  const db = getDb();
  const [wf] = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(and(eq(workflow.jobId, jobId), eq(workflow.tenantId, tenantId), eq(workflow.status, "active")))
    .limit(1);
  if (!wf) return [];
  return db.select().from(workflowStep).where(eq(workflowStep.workflowId, wf.id)).orderBy(asc(workflowStep.position));
}

/**
 * Owner confirms the client supplied the missing inputs: awaiting_inputs →
 * ready (audited with the owner's note), then production starts.
 */
export async function confirmJobInputs(ctx: CommandContext, jobId: string, note?: string) {
  requireOperator(ctx);
  const text = note === undefined ? undefined : z.string().trim().max(2000).parse(note);
  const j = await loadJob(ctx, jobId);
  if (j.status !== "awaiting_inputs") throw new CommandError(`This job is not waiting for inputs (it is ${j.status.replace(/_/g, " ")}).`, "conflict");
  const db = getDb();
  await db.transaction(async (tx) => {
    await transition(tx, {
      machine: "job",
      id: j.id,
      tenantId: ctx.tenantId,
      to: "ready",
      actor: actor(ctx),
      reason: text ? `owner confirmed inputs: ${text.slice(0, 200)}` : "owner confirmed the client inputs",
      expectFrom: ["awaiting_inputs"],
      event: { type: "job.state", level: "success", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `Inputs confirmed for ${j.title.slice(0, 80)} — production can start` },
    });
    await audit(tx, { tenantId: ctx.tenantId, actor: actor(ctx), action: "job.inputs_confirmed", subjectType: "job", subjectId: j.id, data: text ? { note: text } : {} });
  });
  await enqueue(QUEUES.workflowTick, { tenantId: ctx.tenantId, jobId: j.id }, { singletonKey: j.id });
}

export interface ResumeJobOptions {
  /** Extra attempts authorised for each exhausted/failed/blocked step (default 1, max 10). */
  extraAttempts?: number;
  /** Extra automatic repairs granted on top of settings.limits.maxRepairsPerJob (default 1 when the repair limit was reached). */
  extraRepairs?: number;
}

const resumeSchema = z.object({
  extraAttempts: z.number().int().min(0).max(10).optional(),
  extraRepairs: z.number().int().min(0).max(20).optional(),
});

/**
 * Owner authorises a new attempt window for a paused job:
 *  - failed / owner-blocked steps get maxAttempts raised (attempts + extraAttempts) and are
 *    re-opened (the next dispatch is a NEW agent_run; history is never overwritten),
 *  - a repair-limit escalation gets `extraRepairs` added to the job's repair allowance
 *    (job.extra_repairs, audited) and Recovery re-runs on the failed QA review,
 *  - a failed delivery is re-queued.
 * Budget-blocked steps are re-opened too — if the budget still does not fit they block again
 * (raise it with setJobSpendLimit).
 */
export async function resumeJob(ctx: CommandContext, jobId: string, opts: ResumeJobOptions = {}) {
  requireOperator(ctx);
  const o = resumeSchema.parse(opts);
  const j = await loadJob(ctx, jobId);
  if (!["ready", "executing", "qa", "repairing"].includes(j.status)) {
    throw new CommandError(`Only an active job can be resumed (this one is ${j.status.replace(/_/g, " ")}).`, "conflict");
  }
  const db = getDb();
  const steps = await loadActiveWorkflowSteps(ctx.tenantId, j.id);
  const qa = steps.find((s) => isQaStep(s));
  const qaFailed = qa && (qa.status === "failed" ? (qa.output as Record<string, unknown> | null)?.verdict === "fail" : qa.status === "blocked" && blockedReasonOf(qa) === "repair_limit");
  const extraAttempts = o.extraAttempts ?? 1;
  const extraRepairs = o.extraRepairs ?? (qaFailed ? 1 : 0);
  const [failedDelivery] = await db
    .select({ id: delivery.id })
    .from(delivery)
    .where(and(eq(delivery.jobId, j.id), eq(delivery.status, "failed")))
    .limit(1);
  const reopen = steps.filter((s) => s.id !== qa?.id && (s.status === "failed" || isOwnerBlocked(s)));
  if (!reopen.length && !qaFailed && !failedDelivery) throw new CommandError("Nothing is paused on this job — no failed or blocked work to resume.", "conflict");

  // Steps whose QA reviews failed must be repairable again: give them a new attempt window too.
  const failingTargets = new Set<string>(
    qaFailed ? (((qa!.output as Record<string, unknown> | null)?.reviews as { stepId: string; verdict: string }[] | undefined) ?? []).filter((r) => r.verdict === "fail").map((r) => r.stepId) : [],
  );
  const who = actor(ctx);
  const resumed: string[] = [];
  await db.transaction(async (tx) => {
    for (const s of reopen) {
      const maxAttempts = Math.max(s.maxAttempts, s.attempts + Math.max(1, extraAttempts));
      await transition(tx, {
        machine: "step",
        id: s.id,
        tenantId: ctx.tenantId,
        to: "ready",
        actor: who,
        reason: `owner resumed (${blockedReasonOf(s) ?? s.status}) — attempt window ${s.attempts + 1}…${maxAttempts}`,
        patch: { maxAttempts, error: null, output: clearBlockMarkers(s.output) },
      });
      resumed.push(s.key);
    }
    for (const s of steps) {
      if (failingTargets.has(s.id) && s.attempts >= s.maxAttempts) {
        await tx.update(workflowStep).set({ maxAttempts: s.attempts + Math.max(1, extraAttempts) }).where(eq(workflowStep.id, s.id));
      }
    }
    if (qaFailed && qa) {
      const output = { ...clearBlockMarkers(qa.output), blockedReason: "repair_limit", resumeRequestedAt: new Date().toISOString() };
      const maxAttempts = Math.max(qa.maxAttempts, qa.attempts + extraRepairs + 1);
      if (qa.status === "failed") {
        await transition(tx, { machine: "step", id: qa.id, tenantId: ctx.tenantId, to: "blocked", actor: who, reason: "owner resumed after the repair limit", patch: { output, maxAttempts } });
      } else {
        await tx.update(workflowStep).set({ output, maxAttempts }).where(eq(workflowStep.id, qa.id));
      }
      // Escalations are answered: the owner granted more automatic repairs.
      await tx.update(repair).set({ status: "failed" }).where(and(eq(repair.jobId, j.id), eq(repair.strategy, "escalate"), eq(repair.status, "blocked")));
    }
    if (extraRepairs > 0) {
      await tx.update(job).set({ extraRepairs: (j.extraRepairs ?? 0) + extraRepairs }).where(eq(job.id, j.id));
    }
    if (failedDelivery) {
      await transition(tx, { machine: "delivery", id: failedDelivery.id, tenantId: ctx.tenantId, to: "preparing", actor: who, reason: "owner resumed delivery packaging" });
    }
    await audit(tx, {
      tenantId: ctx.tenantId,
      actor: who,
      action: "job.resumed",
      subjectType: "job",
      subjectId: j.id,
      data: { extraAttempts, extraRepairs, steps: resumed, repairLimit: Boolean(qaFailed), delivery: Boolean(failedDelivery), repairAllowance: (j.extraRepairs ?? 0) + extraRepairs },
    });
    await emitEvent(tx, {
      tenantId: ctx.tenantId,
      type: "job.resumed",
      level: "info",
      agent: "orchestrator",
      subjectType: "job",
      subjectId: j.id,
      jobId: j.id,
      message: `Owner resumed ${j.title.slice(0, 80)}${resumed.length ? ` — reopened ${resumed.join(", ")}` : ""}${extraRepairs ? ` · +${extraRepairs} repair${extraRepairs === 1 ? "" : "s"}` : ""}${failedDelivery ? " · re-packaging delivery" : ""}`,
    });
  });
  if (failedDelivery) await enqueue(QUEUES.deliveryPrepare, { tenantId: ctx.tenantId, jobId: j.id }, { singletonKey: j.id });
  await enqueue(QUEUES.workflowTick, { tenantId: ctx.tenantId, jobId: j.id }, { singletonKey: j.id });
  return { resumedSteps: resumed, extraAttempts, extraRepairs, repairLimit: Boolean(qaFailed), delivery: Boolean(failedDelivery) };
}

/**
 * Operator ceiling for a job's spend limit: the deployment's daily paid budget
 * when one is configured, otherwise perJobSpendLimitUsd × OPERATIONAL_DEFAULTS
 * .spendLimitCeilingMultiplier (DECISIONS D12). Raising real-money budgets
 * themselves stays a human-only env/settings change.
 */
export async function jobSpendCeilingUsd(tenantId: string): Promise<number> {
  const envBudget = env().PAID_PROVIDER_DAILY_BUDGET_USD;
  if (envBudget > 0) return envBudget;
  const settings = await getTenantSettings(getDb(), tenantId);
  return settings.limits.perJobSpendLimitUsd * OPERATIONAL_DEFAULTS.spendLimitCeilingMultiplier;
}

/** Owner changes a job's max authorised spend (≥ actual spend, ≤ operator ceiling); budget-blocked steps are re-queued. */
export async function setJobSpendLimit(ctx: CommandContext, jobId: string, usd: number) {
  requireOperator(ctx);
  const amount = z.number().finite().min(0).parse(usd);
  const j = await loadJob(ctx, jobId);
  if (["closed", "cancelled"].includes(j.status)) throw new CommandError(`The job is ${j.status}; its spend limit can no longer change.`, "conflict");
  const actual = Number(j.actualCostUsd);
  if (amount + 1e-9 < actual) throw new CommandError(`The spend limit cannot be below the $${actual.toFixed(2)} already spent on this job.`, "invalid");
  const ceiling = await jobSpendCeilingUsd(ctx.tenantId);
  if (amount > ceiling + 1e-9) throw new CommandError(`The spend limit cannot exceed the operator ceiling of $${ceiling.toFixed(2)}.`, "invalid");
  const db = getDb();
  const who = actor(ctx);
  const steps = await loadActiveWorkflowSteps(ctx.tenantId, j.id);
  const budgetBlocked = steps.filter((s) => s.status === "blocked" && blockedReasonOf(s) === "budget");
  const active = ["ready", "executing", "qa", "repairing"].includes(j.status);
  await db.transaction(async (tx) => {
    await tx.update(job).set({ spendLimitUsd: Math.round(amount * 10_000) / 10_000 }).where(eq(job.id, j.id));
    await audit(tx, { tenantId: ctx.tenantId, actor: who, action: "job.spend_limit_changed", subjectType: "job", subjectId: j.id, data: { fromUsd: Number(j.spendLimitUsd), toUsd: amount, actualUsd: actual, ceilingUsd: ceiling } });
    if (active) {
      for (const s of budgetBlocked) {
        await transition(tx, {
          machine: "step",
          id: s.id,
          tenantId: ctx.tenantId,
          to: "ready",
          actor: who,
          reason: `spend limit raised to $${amount.toFixed(2)}`,
          patch: { maxAttempts: Math.max(s.maxAttempts, s.attempts + 1), output: clearBlockMarkers(s.output) },
        });
      }
    }
    await emitEvent(tx, {
      tenantId: ctx.tenantId,
      type: "cost.recorded",
      level: "info",
      agent: "economics",
      subjectType: "job",
      subjectId: j.id,
      jobId: j.id,
      message: `Spend limit for ${j.title.slice(0, 80)} changed from $${Number(j.spendLimitUsd).toFixed(2)} to $${amount.toFixed(2)}${active && budgetBlocked.length ? ` — ${budgetBlocked.length} blocked step${budgetBlocked.length === 1 ? "" : "s"} re-queued` : ""}`,
    });
  });
  if (active) await enqueue(QUEUES.workflowTick, { tenantId: ctx.tenantId, jobId: j.id }, { singletonKey: j.id });
  return { spendLimitUsd: amount, requeuedSteps: active ? budgetBlocked.map((s) => s.key) : [], ceilingUsd: ceiling };
}

export interface JobBlockers {
  jobId: string;
  status: string;
  awaitingInputs: boolean;
  missingInputs: string[];
  blockedSteps: { id: string; key: string; name: string; reason: string; attempts: number; maxAttempts: number; error: string | null }[];
  repairLimitReached: boolean;
  budgetBlocked: boolean;
  deliveryFailed: boolean;
  canResume: boolean;
  canRequestRevision: boolean;
  canConfirmInputs: boolean;
  spend: { limitUsd: number; actualUsd: number; ceilingUsd: number };
}

/** Owner actions currently available / required for a job (for the job page). Tenant-scoped. */
export async function jobBlockers(tenantId: string, jobId: string): Promise<JobBlockers> {
  const db = getDb();
  const [j] = await db.select().from(job).where(and(eq(job.id, jobId), eq(job.tenantId, tenantId))).limit(1);
  if (!j) throw new CommandError("Job not found", "not_found");
  const steps = await loadActiveWorkflowSteps(tenantId, j.id);
  const active = ["ready", "executing", "qa", "repairing"].includes(j.status);
  const qa = steps.find((s) => isQaStep(s));
  const repairLimitReached =
    Boolean(qa) &&
    ((qa!.status === "blocked" && blockedReasonOf(qa!) === "repair_limit") || (j.status === "repairing" && qa!.status === "failed" && (qa!.output as Record<string, unknown> | null)?.verdict === "fail"));
  const blockedSteps = steps
    .filter((s) => s.id !== qa?.id && (isOwnerBlocked(s) || (s.status === "failed" && s.attempts >= s.maxAttempts)))
    .map((s) => ({ id: s.id, key: s.key, name: s.name, reason: blockedReasonOf(s) ?? "attempts_exhausted", attempts: s.attempts, maxAttempts: s.maxAttempts, error: s.error }));
  const [failedDelivery] = await db.select({ id: delivery.id }).from(delivery).where(and(eq(delivery.jobId, j.id), eq(delivery.status, "failed"))).limit(1);
  let missingInputs: string[] = [];
  if (j.status === "awaiting_inputs" && j.opportunityId) {
    const [a] = await db
      .select({ analysis: opportunityAnalysis.analysis })
      .from(opportunityAnalysis)
      .where(eq(opportunityAnalysis.opportunityId, j.opportunityId))
      .orderBy(desc(opportunityAnalysis.version))
      .limit(1);
    missingInputs = a?.analysis.missingInputs ?? [];
  }
  return {
    jobId: j.id,
    status: j.status,
    awaitingInputs: j.status === "awaiting_inputs",
    missingInputs,
    blockedSteps,
    repairLimitReached,
    budgetBlocked: blockedSteps.some((s) => s.reason === "budget"),
    deliveryFailed: Boolean(failedDelivery),
    canResume: active && (blockedSteps.length > 0 || repairLimitReached || Boolean(failedDelivery)),
    canRequestRevision: (REVISABLE_JOB_STATES as readonly string[]).includes(j.status),
    canConfirmInputs: j.status === "awaiting_inputs",
    spend: { limitUsd: Number(j.spendLimitUsd), actualUsd: Number(j.actualCostUsd), ceilingUsd: await jobSpendCeilingUsd(tenantId) },
  };
}

// ---------------------------------------------------------------------------
// Integrations, inbound intake, markets
// ---------------------------------------------------------------------------

const healthSchema = z.object({
  status: z.enum(INTEGRATION_STATUSES),
  detail: z.string().max(2000),
  latencyMs: z.number().int().min(0).max(3_600_000).optional(),
  checkedAt: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Record an on-demand health check (e.g. the owner's "Test connection").
 * Upserts provider_integration (status/detail/latency/meta/lastCheckAt) or,
 * for marketplace sources, source_integration (status/detail). Audited.
 */
export async function recordIntegrationHealth(ctx: CommandContext, key: string, health: ProviderHealth) {
  requireOperator(ctx);
  const desc_ = integrationByKey(key);
  if (!desc_) throw new CommandError("Unknown integration", "not_found");
  const h = healthSchema.parse(health);
  const detail = h.detail.slice(0, 500);
  const db = getDb();
  await db.transaction(async (tx) => {
    if (desc_.kind === "marketplace") {
      await tx
        .insert(sourceIntegration)
        .values({ tenantId: ctx.tenantId, sourceKey: key, enabled: false, status: h.status, statusDetail: detail, config: {} })
        .onConflictDoUpdate({ target: [sourceIntegration.tenantId, sourceIntegration.sourceKey], set: { status: h.status, statusDetail: detail, updatedAt: new Date() } });
    } else {
      const set = { status: h.status, statusDetail: detail, latencyMs: h.latencyMs ?? null, meta: h.meta ?? null, lastCheckAt: new Date() };
      await tx
        .insert(providerIntegration)
        .values({ tenantId: ctx.tenantId, providerKey: key, kind: desc_.kind, enabled: true, config: {}, ...set })
        .onConflictDoUpdate({ target: [providerIntegration.tenantId, providerIntegration.providerKey], set: { ...set, updatedAt: new Date() } });
    }
    await audit(tx, { tenantId: ctx.tenantId, actor: actor(ctx), action: "integration.health_recorded", subjectType: desc_.kind === "marketplace" ? "source" : "provider", data: { key, status: h.status, latencyMs: h.latencyMs ?? null } });
  });
}

/**
 * Inbound (forwarded email / webhook) opportunity intake under a SYSTEM actor.
 * Keeps the source's external id and the message metadata, dedupes by
 * (source, external id) and by content (near-duplicates are archived with a
 * pointer to the original), then queues analysis for new rows.
 */
export async function ingestInboundOpportunity(tenantId: string, raw: RawOpportunity, provider: string, meta: { messageId?: string } = {}) {
  const db = getDb();
  const [t] = await db.select({ id: tenant.id }).from(tenant).where(eq(tenant.id, tenantId)).limit(1);
  if (!t) throw new CommandError("Unknown workspace", "not_found");
  const providerKey = z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i).parse(provider);
  const messageId = meta.messageId ? String(meta.messageId).slice(0, 300) : undefined;
  const n = normaliseRaw(raw);
  if (!n.title || !n.description) throw new CommandError("The inbound message has no title or description", "invalid");
  const sourceKey = z.string().trim().min(1).max(40).parse(raw.sourceKey || "direct");
  const hash = dedupeHash(n.title, n.description);
  const externalId = (raw.externalId ? String(raw.externalId) : `inbound-${messageId ? dedupeHash(messageId, "") : hash}`).slice(0, 200);
  const sys: Actor = { type: "system", id: `inbound:${providerKey}` };

  const [known] = await db
    .select({ id: opportunity.id })
    .from(opportunity)
    .where(and(eq(opportunity.tenantId, tenantId), eq(opportunity.sourceKey, sourceKey), eq(opportunity.externalId, externalId)))
    .limit(1);
  if (known) return { opportunityId: known.id, duplicate: true };

  const recent = await db
    .select({ id: opportunity.id, title: opportunity.title, description: opportunity.description, dedupeHash: opportunity.dedupeHash })
    .from(opportunity)
    .where(and(eq(opportunity.tenantId, tenantId), gte(opportunity.createdAt, new Date(Date.now() - 14 * 86_400_000))))
    .orderBy(desc(opportunity.createdAt))
    .limit(600);
  const dupOf = findDuplicate({ title: n.title, description: n.description }, recent);
  const markets = await db.select({ key: market.key, enabled: market.enabled, keywords: market.keywords }).from(market).where(eq(market.tenantId, tenantId));
  const match = matchMarket(n, markets);

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(opportunity)
      .values({
        tenantId,
        sourceKey,
        externalId,
        url: n.url,
        title: n.title,
        description: n.description,
        clientName: n.clientName,
        clientCountry: n.clientCountry,
        clientRating: n.clientRating,
        clientSpendUsd: n.clientSpendUsd,
        budgetType: n.budgetType,
        budgetMinUsd: n.budgetMinUsd,
        budgetMaxUsd: n.budgetMaxUsd,
        currency: n.currency,
        skills: n.skills,
        marketKey: match?.key ?? null,
        proposalsCount: n.proposalsCount,
        postedAt: n.postedAt ?? new Date(),
        deadlineAt: n.deadlineAt,
        status: "new",
        dedupeHash: hash,
        raw: { ...n.raw, ingestion: "email", inboundProvider: providerKey, messageId: messageId ?? null, receivedAt: new Date().toISOString(), marketMatchScore: match?.score ?? 0 },
      })
      .onConflictDoNothing()
      .returning({ id: opportunity.id });
    if (!row) return null;
    if (dupOf) {
      await transition(tx, {
        machine: "opportunity",
        id: row.id,
        tenantId,
        to: "archived",
        actor: sys,
        reason: "near-duplicate of an existing opportunity",
        patch: { duplicateOfId: dupOf },
        event: { type: "opportunity.duplicate", level: "debug", agent: "scout", subjectType: "opportunity", subjectId: row.id, message: `Inbound duplicate of an opportunity already on the radar: ${n.title.slice(0, 120)}`, data: { duplicateOfId: dupOf } },
      });
    } else {
      await emitEvent(tx, { tenantId, type: "opportunity.discovered", agent: "scout", subjectType: "opportunity", subjectId: row.id, message: `Received via ${providerKey}: ${n.title.slice(0, 160)}`, data: { messageId: messageId ?? null } });
    }
    await audit(tx, { tenantId, actor: sys, action: "opportunity.ingested", subjectType: "opportunity", subjectId: row.id, data: { provider: providerKey, sourceKey, externalId, messageId: messageId ?? null, duplicateOf: dupOf ?? null } });
    return row.id;
  });
  if (!inserted) {
    const [again] = await db
      .select({ id: opportunity.id })
      .from(opportunity)
      .where(and(eq(opportunity.tenantId, tenantId), eq(opportunity.sourceKey, sourceKey), eq(opportunity.externalId, externalId)))
      .limit(1);
    return { opportunityId: again?.id ?? "", duplicate: true };
  }
  if (dupOf) return { opportunityId: dupOf, duplicate: true };
  await enqueue(QUEUES.opportunityAnalyse, { tenantId, opportunityId: inserted }, { singletonKey: inserted });
  return { opportunityId: inserted, duplicate: false };
}

const marketPatchSchema = z
  .array(z.object({ key: z.string().trim().min(1).max(80), enabled: z.boolean().optional(), allocationPct: z.number().min(0).max(100).optional() }))
  .min(1)
  .max(50);

/** Update several markets atomically (all or nothing), audited. */
export async function updateMarkets(ctx: CommandContext, patches: { key: string; enabled?: boolean; allocationPct?: number }[]) {
  requireOperator(ctx);
  const list = marketPatchSchema.parse(patches);
  const keys = new Set<string>();
  for (const p of list) {
    if (keys.has(p.key)) throw new CommandError(`Market ${p.key} appears twice`, "invalid");
    keys.add(p.key);
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const p of list) {
      const data: { enabled?: boolean; allocationPct?: number } = {};
      if (p.enabled !== undefined) data.enabled = p.enabled;
      if (p.allocationPct !== undefined) data.allocationPct = p.allocationPct;
      if (!Object.keys(data).length) continue;
      const res = await tx
        .update(market)
        .set(data)
        .where(and(eq(market.tenantId, ctx.tenantId), eq(market.key, p.key)))
        .returning({ id: market.id });
      if (!res[0]) throw new CommandError(`Market ${p.key} not found`, "not_found");
      await audit(tx, { tenantId: ctx.tenantId, actor: actor(ctx), action: "market.updated", subjectType: "market", subjectId: res[0].id, data: { key: p.key, ...data } });
    }
  });
}
