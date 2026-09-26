import { env } from "@gigpilot/config";
import type {
  AgentKey,
  Capability,
  CreativeRequest,
  IntelligenceRequest,
  SubjectType,
  TenantSettings,
} from "@gigpilot/contracts";
import {
  agentRun,
  and,
  asset,
  costLedgerEntry,
  emitEvent,
  eq,
  gte,
  generation,
  getDb,
  getTenantSettings,
  job,
  providerMetric,
  sql,
  transition,
  workflowStep,
  type Executor,
} from "@gigpilot/db";
import type { BudgetContext, CreativeRouteDecision, RoutedIntelligenceResult } from "@gigpilot/providers";
import { buildAssetKey, sha256Hex } from "@gigpilot/providers/storage";
import { brokerOf, routerOf, storageOf, type AgentDeps } from "./deps";
import { configuredCreativeProviders, isConfiguredFor } from "./lib/adapters";
import { notify } from "./lib/notify";
import { money, round4, safeError, startOfUtcDay } from "./lib/util";

export type JobRow = typeof job.$inferSelect;
export type StepRow = typeof workflowStep.$inferSelect;
export type AssetRow = typeof asset.$inferSelect;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunInput {
  deps: AgentDeps;
  tenantId: string;
  agent: AgentKey;
  task: string;
  subjectType?: SubjectType | null;
  subjectId?: string | null;
  jobId?: string | null;
  stepId?: string | null;
  parentRunId?: string | null;
  attempt?: number;
  idempotencyKey?: string | null;
  dependencies?: string[];
  /** Human-readable label for the run start event. */
  label?: string;
}

export interface RunContext {
  runId: string;
  tenantId: string;
  agent: AgentKey;
  task: string;
  jobId: string | null;
  stepId: string | null;
  attempt: number;
  deps: AgentDeps;
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  provider: string | null;
  model: string | null;
  /** Concise, user-visible outcome stored on the run. */
  summary: string | null;
  settings(): Promise<TenantSettings>;
}

export class BudgetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetBlockedError";
  }
}

/**
 * Executes an agent unit of work as an audited agent_run: queued → running →
 * succeeded | failed. A failed run is never overwritten — retries create a
 * new row with attempt + 1.
 */
export async function runAgent<T>(input: RunInput, fn: (ctx: RunContext) => Promise<T>): Promise<T> {
  const db = getDb();
  const attempt = input.attempt ?? 1;
  const [row] = await db
    .insert(agentRun)
    .values({
      tenantId: input.tenantId,
      agent: input.agent,
      task: input.task,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      jobId: input.jobId ?? null,
      stepId: input.stepId ?? null,
      parentRunId: input.parentRunId ?? null,
      status: "queued",
      attempt,
      idempotencyKey: input.idempotencyKey ?? null,
      dependencies: input.dependencies ?? [],
    })
    .returning({ id: agentRun.id });
  if (!row) throw new Error("agent_run insert failed");
  const runId = row.id;
  const actor = { type: "agent" as const, id: input.agent };

  let settingsCache: Promise<TenantSettings> | undefined;
  const ctx: RunContext = {
    runId,
    tenantId: input.tenantId,
    agent: input.agent,
    task: input.task,
    jobId: input.jobId ?? null,
    stepId: input.stepId ?? null,
    attempt,
    deps: input.deps,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    provider: null,
    model: null,
    summary: null,
    settings: () => (settingsCache ??= getTenantSettings(getDb(), input.tenantId)),
  };

  await transition(db, {
    machine: "run",
    id: runId,
    tenantId: input.tenantId,
    to: "running",
    actor,
    patch: { startedAt: new Date() },
    event: {
      type: "agent.run",
      level: "debug",
      agent: input.agent,
      runId,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      jobId: input.jobId ?? null,
      message: `${input.label ?? input.task} started${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
    },
  });

  try {
    const result = await fn(ctx);
    await transition(db, {
      machine: "run",
      id: runId,
      tenantId: input.tenantId,
      to: "succeeded",
      actor,
      patch: {
        finishedAt: new Date(),
        summary: ctx.summary?.slice(0, 1000) ?? null,
        provider: ctx.provider,
        model: ctx.model,
        inputTokens: ctx.totals.inputTokens,
        outputTokens: ctx.totals.outputTokens,
        costUsd: round4(ctx.totals.costUsd),
      },
      event: {
        type: "agent.run",
        level: "debug",
        agent: input.agent,
        runId,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        jobId: input.jobId ?? null,
        message: `${input.label ?? input.task} finished${ctx.summary ? ` — ${ctx.summary.slice(0, 160)}` : ""}`,
      },
    });
    return result;
  } catch (err) {
    const message = safeError(err);
    try {
      await transition(db, {
        machine: "run",
        id: runId,
        tenantId: input.tenantId,
        to: "failed",
        actor,
        patch: {
          finishedAt: new Date(),
          error: message,
          provider: ctx.provider,
          model: ctx.model,
          inputTokens: ctx.totals.inputTokens,
          outputTokens: ctx.totals.outputTokens,
          costUsd: round4(ctx.totals.costUsd),
        },
        event: {
          type: "agent.run",
          level: "error",
          agent: input.agent,
          runId,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          jobId: input.jobId ?? null,
          message: `${input.label ?? input.task} failed: ${message.slice(0, 200)}`,
        },
      });
    } catch (inner) {
      input.deps.log.error({ runId, error: safeError(inner) }, "could not record failed run");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Spend authority
// ---------------------------------------------------------------------------

async function paidSpentSince(db: Executor, since: Date, tenantId?: string): Promise<number> {
  const where = tenantId
    ? and(eq(costLedgerEntry.tenantId, tenantId), eq(costLedgerEntry.paid, true), eq(costLedgerEntry.kind, "actual"), gte(costLedgerEntry.createdAt, since))
    : and(eq(costLedgerEntry.paid, true), eq(costLedgerEntry.kind, "actual"), gte(costLedgerEntry.createdAt, since));
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${costLedgerEntry.amountUsd}), 0)` })
    .from(costLedgerEntry)
    .where(where);
  return Number(row?.total ?? 0);
}

/**
 * Paid providers are allowed only when BOTH the deployment budget
 * (PAID_PROVIDER_DAILY_BUDGET_USD) and the tenant's daily limit are > 0.
 * Remaining = min(env budget − today's paid spend (all tenants), tenant limit
 * − today's tenant paid spend), further capped by the job's spend limit.
 */
export async function computeBudget(
  db: Executor,
  tenantId: string,
  settings: TenantSettings,
  opts: { jobId?: string | null; now?: Date } = {},
): Promise<BudgetContext> {
  const envBudget = env().PAID_PROVIDER_DAILY_BUDGET_USD;
  const tenantLimit = settings.limits.dailyPaidSpendLimitUsd;
  if (!(envBudget > 0) || !(tenantLimit > 0)) return { allowPaid: false, remainingPaidUsd: 0 };
  const since = startOfUtcDay(opts.now ?? new Date());
  const [globalSpent, tenantSpent] = await Promise.all([paidSpentSince(db, since), paidSpentSince(db, since, tenantId)]);
  let remaining = Math.min(envBudget - globalSpent, tenantLimit - tenantSpent);
  if (opts.jobId) {
    const [j] = await db.select({ limit: job.spendLimitUsd, actual: job.actualCostUsd }).from(job).where(eq(job.id, opts.jobId)).limit(1);
    if (j) remaining = Math.min(remaining, Number(j.limit) - Number(j.actual));
  }
  return { allowPaid: true, remainingPaidUsd: Math.max(0, remaining) };
}

async function addCosts(db: Executor, ctx: { jobId: string | null; stepId: string | null }, amountUsd: number): Promise<void> {
  if (!(amountUsd > 0)) return;
  if (ctx.jobId) await db.update(job).set({ actualCostUsd: sql`${job.actualCostUsd} + ${amountUsd}` }).where(eq(job.id, ctx.jobId));
  if (ctx.stepId) await db.update(workflowStep).set({ actualCostUsd: sql`${workflowStep.actualCostUsd} + ${amountUsd}` }).where(eq(workflowStep.id, ctx.stepId));
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

export interface CallIntelligenceOptions {
  /** Families to avoid when an alternative exists (QA independence). */
  avoidFamilies?: string[];
  opportunityId?: string | null;
}

/**
 * Routed LLM call with spend authority, ledger entry, fallback events and
 * run/job/step cost accounting.
 */
export async function callIntelligence<T>(
  ctx: RunContext,
  req: IntelligenceRequest<T>,
  opts: CallIntelligenceOptions = {},
): Promise<RoutedIntelligenceResult<T>> {
  const db = getDb();
  const settings = await ctx.settings();
  const budget = await computeBudget(db, ctx.tenantId, settings, { jobId: ctx.jobId });
  const router = routerOf(ctx.deps);

  let allowed = [...settings.routing.allowedModelFamilies];
  if (opts.avoidFamilies?.length) {
    const candidates = router
      .routeFor(req.task, { tenantId: ctx.tenantId, budget, allowedFamilies: allowed, preferLocalForCheapTasks: settings.routing.preferLocalForCheapTasks })
      .filter((f) => f !== "mock" && !opts.avoidFamilies!.includes(f) && allowed.includes(f));
    let alternative = false;
    for (const f of candidates) {
      for (const p of router.providers().filter((x) => x.family === f && x.supports(req.task) && (!x.paid || budget.allowPaid))) {
        if (await isConfiguredFor(p, ctx.tenantId)) alternative = true;
      }
    }
    if (alternative) allowed = allowed.filter((f) => !opts.avoidFamilies!.includes(f));
  }

  const res = await router.complete(
    { ...req, context: { tenantId: ctx.tenantId, jobId: ctx.jobId ?? undefined, opportunityId: opts.opportunityId ?? undefined, agentRunId: ctx.runId } },
    { tenantId: ctx.tenantId, budget, allowedFamilies: allowed, preferLocalForCheapTasks: settings.routing.preferLocalForCheapTasks },
  );

  const cost = Math.max(0, res.usage.costUsd || 0);
  await db.insert(costLedgerEntry).values({
    tenantId: ctx.tenantId,
    jobId: ctx.jobId,
    opportunityId: opts.opportunityId ?? null,
    category: "inference",
    kind: "actual",
    provider: res.family,
    model: res.model,
    amountUsd: round4(cost),
    paid: res.paid && cost > 0,
    agentRunId: ctx.runId,
    memo: `${req.task} · ${res.usage.inputTokens.toLocaleString("en-US")} in / ${res.usage.outputTokens.toLocaleString("en-US")} out tokens (${res.usage.costSource})`,
  });

  if (res.fallbacks.length > 0) {
    const failures = res.fallbacks.filter((f) => f.reason.startsWith("failed"));
    await emitEvent(db, {
      tenantId: ctx.tenantId,
      type: "provider.fallback",
      level: failures.length > 0 ? "warn" : "debug",
      agent: ctx.agent,
      runId: ctx.runId,
      jobId: ctx.jobId,
      message: `${req.task} answered by ${res.family}/${res.model} — ${res.fallbacks.map((f) => `${f.family}: ${f.reason}`).join("; ")}`.slice(0, 480),
      data: { task: req.task, answeredBy: res.family, fallbacks: res.fallbacks },
    });
  }

  ctx.totals.inputTokens += res.usage.inputTokens;
  ctx.totals.outputTokens += res.usage.outputTokens;
  ctx.totals.costUsd += cost;
  ctx.provider = res.family;
  ctx.model = res.model;
  await db
    .update(agentRun)
    .set({
      inputTokens: sql`${agentRun.inputTokens} + ${res.usage.inputTokens}`,
      outputTokens: sql`${agentRun.outputTokens} + ${res.usage.outputTokens}`,
      costUsd: sql`${agentRun.costUsd} + ${round4(cost)}`,
      provider: res.family,
      model: res.model,
    })
    .where(eq(agentRun.id, ctx.runId));
  await addCosts(db, ctx, cost);
  return res;
}

// ---------------------------------------------------------------------------
// Creative
// ---------------------------------------------------------------------------

export function assetKindForMime(mime: string): AssetRow["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/zip") return "archive";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/x-subrip") return "document";
  return "other";
}

export interface StoreFileInput {
  tenantId: string;
  jobId: string | null;
  stepId: string | null;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  kind?: AssetRow["kind"];
  width?: number | null;
  height?: number | null;
  meta?: Record<string, unknown>;
}

/** Persist bytes via the storage adapter and record an asset row. */
export async function storeFile(deps: AgentDeps, db: Executor, input: StoreFileInput): Promise<AssetRow> {
  const sha = sha256Hex(input.bytes);
  const key = buildAssetKey({ tenantId: input.tenantId, jobId: input.jobId, filename: input.filename, sha256: sha });
  await storageOf(deps).put(key, input.bytes, input.mime);
  const [row] = await db
    .insert(asset)
    .values({
      tenantId: input.tenantId,
      jobId: input.jobId,
      stepId: input.stepId,
      kind: input.kind ?? assetKindForMime(input.mime),
      filename: input.filename,
      mime: input.mime,
      storageKey: key,
      bytes: input.bytes.byteLength,
      sha256: sha,
      width: input.width ?? null,
      height: input.height ?? null,
      meta: input.meta ?? null,
    })
    .returning();
  if (!row) throw new Error("asset insert failed");
  return row;
}

export interface CallCreativeInput {
  job: JobRow;
  step: StepRow;
  capability: Capability;
  prompt: string;
  aspectRatio?: CreativeRequest["aspectRatio"];
  durationSec?: number;
  params?: Record<string, unknown>;
  idempotencyKey: string;
  label: string;
  simulateDefect?: string | null;
  exclude?: { provider: string; model: string }[];
  repairOfId?: string | null;
  maxCostUsd?: number;
}

export interface CallCreativeResult {
  generationId: string;
  assets: AssetRow[];
  decision: CreativeRouteDecision | null;
  costUsd: number;
  provider: string;
  model: string;
  reused: boolean;
}

async function observedMetrics(db: Executor, tenantId: string) {
  const rows = await db
    .select({
      provider: providerMetric.provider,
      model: providerMetric.model,
      capability: providerMetric.capability,
      usableRate: providerMetric.usableRate,
      attempts: providerMetric.attempts,
    })
    .from(providerMetric)
    .where(eq(providerMetric.tenantId, tenantId));
  return rows;
}

/**
 * Brokered creative generation. Enforces spend authority (a paid route that
 * the job's spend limit cannot afford BLOCKS the step — no silent mock
 * substitution once real spend is enabled), is idempotent per
 * generation.idempotencyKey, stores output bytes, and records generation,
 * asset, ledger and cost rows.
 */
export async function callCreative(ctx: RunContext, input: CallCreativeInput): Promise<CallCreativeResult> {
  const db = getDb();
  const settings = await ctx.settings();
  const broker = brokerOf(ctx.deps);
  const tenantId = ctx.tenantId;

  const [existing] = await db
    .select()
    .from(generation)
    .where(and(eq(generation.tenantId, tenantId), eq(generation.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing && existing.status === "succeeded") {
    const assets = existing.assetId
      ? await db.select().from(asset).where(and(eq(asset.tenantId, tenantId), eq(asset.stepId, input.step.id)))
      : [];
    const mine = assets.filter((a) => (a.meta as Record<string, unknown> | null)?.generationId === existing.id);
    return {
      generationId: existing.id,
      assets: mine,
      decision: null,
      costUsd: Number(existing.actualCostUsd ?? 0),
      provider: existing.provider,
      model: existing.model,
      reused: true,
    };
  }

  const budget = await computeBudget(db, tenantId, settings, { jobId: input.job.id });
  const metrics = await observedMetrics(db, tenantId);
  const [freshJob] = await db.select({ limit: job.spendLimitUsd, actual: job.actualCostUsd }).from(job).where(eq(job.id, input.job.id)).limit(1);
  const jobRemaining = Math.max(0, Number(freshJob?.limit ?? input.job.spendLimitUsd) - Number(freshJob?.actual ?? input.job.actualCostUsd));
  const maxCostUsd = input.maxCostUsd ?? Math.max(0, jobRemaining);
  const opts = {
    tenantId,
    budget,
    allowedFamilies: settings.routing.allowedModelFamilies,
    qualityThreshold: settings.routing.creativeQualityThreshold,
    preference: settings.routing.creativeProviderPreference,
    metrics,
    exclude: input.exclude,
    simulateDefect: input.simulateDefect ?? null,
    configuredProviders: await configuredCreativeProviders(broker, tenantId),
  };

  if (budget.allowPaid) {
    const ideal = broker.plan(input.capability, {
      ...opts,
      budget: { allowPaid: true, remainingPaidUsd: Number.POSITIVE_INFINITY },
      durationSec: input.durationSec,
    } as Parameters<typeof broker.plan>[1]);
    const actual = broker.plan(input.capability, { ...opts, maxCostUsd, durationSec: input.durationSec } as Parameters<typeof broker.plan>[1]);
    if (ideal.mode === "live" && actual.mode === "mock") {
      const msg = `Blocked ${input.label}: ${ideal.option.provider}/${ideal.option.model} needs about ${money(
        (ideal.option.unitCostUsd ?? 0) * (ideal.option.unit === "second" ? (input.durationSec ?? 8) : 1),
      )} but only ${money(Math.min(budget.remainingPaidUsd, maxCostUsd))} of paid spend remains for this job`;
      await emitEvent(db, {
        tenantId,
        type: "budget.blocked",
        level: "warn",
        agent: ctx.agent,
        runId: ctx.runId,
        jobId: input.job.id,
        subjectType: "step",
        subjectId: input.step.id,
        message: msg,
        data: { remainingPaidUsd: budget.remainingPaidUsd, jobRemainingUsd: jobRemaining, route: `${ideal.option.provider}/${ideal.option.model}` },
      });
      await notify(db, {
        tenantId,
        kind: "alert",
        title: `Spend limit reached on “${input.job.title.slice(0, 80)}”`,
        body: `${msg}. Raise the job's spend limit or the daily paid budget to continue — nothing was charged.`,
        link: `/jobs/${input.job.id}`,
        dedupeKey: `budget-blocked:${input.step.id}:${ctx.attempt}`,
      });
      throw new BudgetBlockedError(msg);
    }
  }

  const params = {
    ...(input.params ?? {}),
    aspectRatio: input.aspectRatio ?? null,
    durationSec: input.durationSec ?? null,
    label: input.label,
  };
  let generationId: string;
  if (existing) {
    generationId = existing.id;
    await db.update(generation).set({ status: "running", error: null }).where(eq(generation.id, existing.id));
  } else {
    const [row] = await db
      .insert(generation)
      .values({
        tenantId,
        jobId: input.job.id,
        stepId: input.step.id,
        agentRunId: ctx.runId,
        provider: "pending",
        model: "pending",
        capability: input.capability,
        params,
        status: "running",
        repairOfId: input.repairOfId ?? null,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: generation.id });
    if (!row) throw new Error("generation insert failed");
    generationId = row.id;
  }

  let out: Awaited<ReturnType<typeof broker.generate>>;
  try {
    out = await broker.generate(
      {
        capability: input.capability,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        durationSec: input.durationSec,
        params: input.params,
        idempotencyKey: input.idempotencyKey,
        maxCostUsd,
        context: { tenantId, jobId: input.job.id, stepId: input.step.id },
      },
      opts,
    );
  } catch (err) {
    const message = safeError(err);
    await db.update(generation).set({ status: "failed", error: message }).where(eq(generation.id, generationId));
    await emitEvent(db, {
      tenantId,
      type: "generation.failed",
      level: "error",
      agent: ctx.agent,
      runId: ctx.runId,
      jobId: input.job.id,
      subjectType: "generation",
      subjectId: generationId,
      message: `${input.label} failed: ${message.slice(0, 200)}`,
    });
    throw err;
  }

  const simulated = out.decision.mode === "mock";
  const cost = Math.max(0, out.costUsd || 0);
  const provider = broker.providers().find((p) => p.key === out.provider);
  const paid = !simulated && Boolean(provider?.paid) && cost > 0;

  if (out.status !== "succeeded" || out.files.length === 0) {
    const message = out.error ?? "provider returned no files";
    await db
      .update(generation)
      .set({
        status: "failed",
        provider: out.provider,
        model: out.model,
        error: message,
        actualCostUsd: round4(cost),
        costSource: out.costSource,
        latencyMs: out.latencyMs,
        externalTaskId: out.externalTaskId ?? null,
        routeRationale: out.decision.rationale,
        estimatedCostUsd: round4(out.decision.option.unitCostUsd ?? 0),
      })
      .where(eq(generation.id, generationId));
    if (cost > 0) {
      await db.insert(costLedgerEntry).values({
        tenantId,
        jobId: input.job.id,
        category: "creative",
        kind: "actual",
        provider: out.provider,
        model: out.model,
        amountUsd: round4(cost),
        paid,
        agentRunId: ctx.runId,
        generationId,
        memo: `${input.label} (failed generation)`,
      });
      await addCosts(db, ctx, cost);
    }
    await emitEvent(db, {
      tenantId,
      type: "generation.failed",
      level: "error",
      agent: ctx.agent,
      runId: ctx.runId,
      jobId: input.job.id,
      subjectType: "generation",
      subjectId: generationId,
      message: `${input.label} failed on ${out.provider}/${out.model}: ${safeError(message, 200)}`,
    });
    throw new Error(`Generation failed on ${out.provider}/${out.model}: ${safeError(message, 200)}`);
  }

  const stored: AssetRow[] = [];
  for (const f of out.files) {
    stored.push(
      await storeFile(ctx.deps, db, {
        tenantId,
        jobId: input.job.id,
        stepId: input.step.id,
        filename: f.filename,
        mime: f.mime,
        bytes: f.bytes,
        width: f.width ?? null,
        height: f.height ?? null,
        meta: {
          generationId,
          simulated,
          provider: out.provider,
          model: out.model,
          simulatedRoute: simulated ? out.decision.option.notes : null,
          capability: input.capability,
          aspectRatio: input.aspectRatio ?? null,
          durationSec: input.durationSec ?? null,
          label: input.label,
          unitIndex: input.params?.unitIndex ?? null,
        },
      }),
    );
  }

  await db
    .update(generation)
    .set({
      status: "succeeded",
      provider: out.provider,
      model: out.model,
      actualCostUsd: round4(cost),
      estimatedCostUsd: round4(out.decision.option.unitCostUsd === null ? 0 : cost),
      costSource: out.costSource,
      latencyMs: out.latencyMs,
      externalTaskId: out.externalTaskId ?? null,
      assetId: stored[0]?.id ?? null,
      routeRationale: out.decision.rationale,
      params: { ...params, simulated, simulatedRoute: simulated ? out.decision.option.notes : null },
      error: null,
    })
    .where(eq(generation.id, generationId));

  await db.insert(costLedgerEntry).values({
    tenantId,
    jobId: input.job.id,
    category: "creative",
    kind: "actual",
    provider: out.provider,
    model: out.model,
    amountUsd: round4(cost),
    paid,
    agentRunId: ctx.runId,
    generationId,
    memo: simulated
      ? `${input.label} — simulated at the catalog price of ${out.decision.option.notes?.replace(/^simulates /, "") ?? "the planned route"} (mock mode, no real spend)`
      : `${input.label} via ${out.provider}/${out.model}`,
  });
  await addCosts(db, ctx, cost);
  ctx.totals.costUsd += cost;
  ctx.provider = out.provider;
  ctx.model = out.model;
  await db.update(agentRun).set({ costUsd: sql`${agentRun.costUsd} + ${round4(cost)}`, provider: out.provider, model: out.model }).where(eq(agentRun.id, ctx.runId));

  await emitEvent(db, {
    tenantId,
    type: "generation.completed",
    level: "info",
    agent: ctx.agent,
    runId: ctx.runId,
    jobId: input.job.id,
    subjectType: "generation",
    subjectId: generationId,
    message: simulated
      ? `${input.label} rendered in mock mode (simulating ${out.decision.option.notes?.replace(/^simulates /, "") ?? "catalog route"} · ${money(cost)} simulated)`
      : `${input.label} generated via ${out.provider}/${out.model} · ${money(cost)}`,
    data: { rationale: out.decision.rationale, mode: out.decision.mode, costUsd: cost },
  });

  return { generationId, assets: stored, decision: out.decision, costUsd: cost, provider: out.provider, model: out.model, reused: false };
}
