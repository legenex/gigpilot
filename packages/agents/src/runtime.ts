import { env } from "@gigpilot/config";
import type {
  AgentKey,
  Capability,
  CreativeRequest,
  IntelligenceMessage,
  IntelligenceRequest,
  SubjectType,
  TenantSettings,
} from "@gigpilot/contracts";
import {
  agentRun,
  and,
  asset,
  costLedgerEntry,
  desc,
  emitEvent,
  eq,
  gte,
  generation,
  getDb,
  getTenantSettings,
  job,
  ne,
  or,
  providerMetric,
  sql,
  transition,
  workflowStep,
  type Executor,
} from "@gigpilot/db";
import {
  detectLikelySecret,
  isHeavyGxTask,
  isProviderError,
  UNTRUSTED_DATA_RULE,
  type BudgetContext,
  type CreativeRouteDecision,
  type RoutedIntelligenceResult,
} from "@gigpilot/providers";
import { buildAssetKey, sha256Hex } from "@gigpilot/providers/storage";
import { brokerOf, routerOf, storageOf, type AgentDeps } from "./deps";
import { configuredCreativeProviders, isConfiguredFor } from "./lib/adapters";
import { budgetSnapshot, releaseReservation, reserveSpend, settleReservation } from "./lib/budget";
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
  /** Cancels provider calls (defaults to deps.signal). */
  signal?: AbortSignal;
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
  /** Aborted on queue expiry or worker shutdown; passed to every provider call. */
  signal?: AbortSignal;
  settings(): Promise<TenantSettings>;
  /**
   * Cooperative cancellation point between units of work: throws
   * StepAbortedError when the worker is shutting down, the queue job expired,
   * or the job was cancelled by the owner.
   */
  checkpoint(): Promise<void>;
}

export class BudgetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetBlockedError";
  }
}

export type AbortReason = "shutdown" | "timeout" | "cancelled";

/** Work stopped at a checkpoint (shutdown → resumable, timeout → failed attempt, cancelled → job cancelled). */
export class StepAbortedError extends Error {
  constructor(
    public readonly reason: AbortReason,
    message?: string,
  ) {
    super(message ?? (reason === "shutdown" ? "interrupted by worker shutdown" : reason === "cancelled" ? "job was cancelled" : "timed out (queue expiry)"));
    this.name = "StepAbortedError";
  }
}

/** Why the current handler should stop, or null. Shutdown wins over expiry. */
export function abortReasonOf(deps: AgentDeps): AbortReason | null {
  if (deps.shutdown?.aborted) return "shutdown";
  if (deps.signal?.aborted) return "timeout";
  return null;
}

/**
 * Executes an agent unit of work as an audited agent_run: queued → running →
 * succeeded | failed (| cancelled when stopped by shutdown or job
 * cancellation). A failed run is never overwritten — retries create a new row
 * with attempt + 1.
 */
export async function runAgent<T>(input: RunInput, fn: (ctx: RunContext) => Promise<T>): Promise<T> {
  const db = getDb();
  const attempt = input.attempt ?? 1;
  const signal = input.signal ?? input.deps.signal;
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
    signal,
    settings: () => (settingsCache ??= getTenantSettings(getDb(), input.tenantId)),
    checkpoint: async () => {
      const reason = abortReasonOf(input.deps) ?? (signal?.aborted ? "timeout" : null);
      if (reason) throw new StepAbortedError(reason);
      if (input.jobId) {
        const [j] = await getDb().select({ status: job.status }).from(job).where(eq(job.id, input.jobId)).limit(1);
        if (j?.status === "cancelled") throw new StepAbortedError("cancelled");
      }
    },
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
    // Shutdown / owner cancellation stop the run without counting as a failure.
    const stopped = (err instanceof StepAbortedError && err.reason !== "timeout") || input.deps.shutdown?.aborted === true;
    try {
      await transition(db, {
        machine: "run",
        id: runId,
        tenantId: input.tenantId,
        to: stopped ? "cancelled" : "failed",
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
          level: stopped ? "warn" : "error",
          agent: input.agent,
          runId,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          jobId: input.jobId ?? null,
          message: `${input.label ?? input.task} ${stopped ? "stopped" : "failed"}: ${message.slice(0, 200)}`,
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

/**
 * Paid providers are allowed only when BOTH the deployment budget
 * (PAID_PROVIDER_DAILY_BUDGET_USD) and the tenant's daily limit are > 0.
 * Remaining = min(env budget − today's paid spend (all tenants), tenant limit
 * − today's tenant paid spend, job limit − job actual), each also net of
 * other callers' open spend reservations. This is a planning view; the hard
 * check happens in `reserveSpend` under an advisory lock.
 */
export async function computeBudget(
  db: Executor,
  tenantId: string,
  settings: TenantSettings,
  opts: { jobId?: string | null; now?: Date } = {},
): Promise<BudgetContext> {
  const snap = await budgetSnapshot(db, tenantId, settings, opts);
  return { allowPaid: snap.allowPaid, remainingPaidUsd: snap.remainingPaidUsd };
}

async function addCosts(db: Executor, ctx: { jobId: string | null; stepId: string | null }, amountUsd: number): Promise<void> {
  if (!(amountUsd > 0)) return;
  if (ctx.jobId) await db.update(job).set({ actualCostUsd: sql`${job.actualCostUsd} + ${amountUsd}` }).where(eq(job.id, ctx.jobId));
  if (ctx.stepId) await db.update(workflowStep).set({ actualCostUsd: sql`${workflowStep.actualCostUsd} + ${amountUsd}` }).where(eq(workflowStep.id, ctx.stepId));
}

// ---------------------------------------------------------------------------
// Untrusted input / output hygiene
// ---------------------------------------------------------------------------

/** Exact server credential values (never allowed in model output). */
function knownSecretValues(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 12) continue;
    if (/(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)/.test(k)) out.push(v.trim());
  }
  return out;
}

/** Ensure the untrusted-data rule is in the system prompt whenever a request embeds untrusted blocks. */
function withUntrustedRule(messages: IntelligenceMessage[]): IntelligenceMessage[] {
  if (!messages.some((m) => m.content.includes("<untrusted_brief"))) return messages;
  if (messages.some((m) => m.role === "system" && m.content.includes(UNTRUSTED_DATA_RULE))) return messages;
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx < 0) return [{ role: "system", content: UNTRUSTED_DATA_RULE }, ...messages];
  return messages.map((m, i) => (i === idx ? { ...m, content: `${m.content}\n\n${UNTRUSTED_DATA_RULE}` } : m));
}

// ---------------------------------------------------------------------------
// Local model quota
// ---------------------------------------------------------------------------

const quotaNotified = new Set<string>();

/** Heavy (non-fast-model) GX calls the tenant made today — one inference ledger row per call. */
async function heavyGxCallsToday(db: Executor, tenantId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(costLedgerEntry)
    .where(
      and(
        eq(costLedgerEntry.tenantId, tenantId),
        eq(costLedgerEntry.category, "inference"),
        eq(costLedgerEntry.provider, "gx"),
        ne(costLedgerEntry.model, env().GX_MODEL_FAST),
        gte(costLedgerEntry.createdAt, startOfUtcDay(now)),
      ),
    );
  return Number(row?.n ?? 0);
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
 * Routed LLM call with spend authority (paid calls reserve their estimate
 * first), the per-tenant local-model quota, ledger entry, fallback events,
 * output secret scanning and run/job/step cost accounting.
 */
export async function callIntelligence<T>(
  ctx: RunContext,
  req: IntelligenceRequest<T>,
  opts: CallIntelligenceOptions = {},
): Promise<RoutedIntelligenceResult<T>> {
  const db = getDb();
  const settings = await ctx.settings();
  let budget = await computeBudget(db, ctx.tenantId, settings, { jobId: ctx.jobId });
  const router = routerOf(ctx.deps);
  const now = ctx.deps.now();

  let allowed = [...settings.routing.allowedModelFamilies];
  // Shared GX capacity: a tenant beyond its daily heavy-model quota falls back to triage/mock.
  if (allowed.includes("gx") && isHeavyGxTask(req.task) && (await heavyGxCallsToday(db, ctx.tenantId, now)) >= settings.limits.dailyLocalModelCalls) {
    allowed = allowed.filter((f) => f !== "gx");
    const key = `${ctx.tenantId}:${startOfUtcDay(now).toISOString().slice(0, 10)}`;
    if (!quotaNotified.has(key)) {
      if (quotaNotified.size > 10_000) quotaNotified.clear();
      quotaNotified.add(key);
      await emitEvent(db, {
        tenantId: ctx.tenantId,
        type: "provider.quota",
        level: "warn",
        agent: ctx.agent,
        runId: ctx.runId,
        jobId: ctx.jobId,
        message: `Daily local-model quota reached (${settings.limits.dailyLocalModelCalls} heavy GX calls) — falling back to triage/mock until tomorrow (UTC)`,
        data: { limit: settings.limits.dailyLocalModelCalls, task: req.task },
      });
    }
  }

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

  const request: IntelligenceRequest<T> = {
    ...req,
    messages: withUntrustedRule(req.messages),
    signal: req.signal ?? ctx.signal,
    context: { tenantId: ctx.tenantId, jobId: ctx.jobId ?? undefined, opportunityId: opts.opportunityId ?? undefined, agentRunId: ctx.runId },
  };

  // Hard limit: reserve the most expensive paid route this call could take.
  let reservationId: string | null = null;
  if (budget.allowPaid) {
    let maxEstimate = 0;
    for (const p of router.providers()) {
      if (!p.paid || !allowed.includes(p.family) || !p.supports(req.task)) continue;
      if (!(await isConfiguredFor(p, ctx.tenantId))) continue;
      const est = p.estimateCost(request);
      if (Number.isFinite(est)) maxEstimate = Math.max(maxEstimate, est);
    }
    if (maxEstimate > 0) {
      const r = await reserveSpend({
        tenantId: ctx.tenantId,
        jobId: ctx.jobId,
        stepId: ctx.stepId,
        key: `reservation:${ctx.runId}:${req.task}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        amountUsd: maxEstimate,
        memo: `${req.task} (intelligence)`,
        settings,
        now,
      });
      if (r.ok) {
        reservationId = r.id;
        budget = { allowPaid: true, remainingPaidUsd: r.amountUsd };
        request.maxCostUsd = Math.min(request.maxCostUsd ?? Number.POSITIVE_INFINITY, r.amountUsd);
      } else {
        // Paid routes are skipped for this call (local/mock still answer).
        budget = { allowPaid: false, remainingPaidUsd: 0 };
      }
    }
  }

  let res: RoutedIntelligenceResult<T>;
  try {
    res = await router.complete(request, { tenantId: ctx.tenantId, budget, allowedFamilies: allowed, preferLocalForCheapTasks: settings.routing.preferLocalForCheapTasks });
  } catch (err) {
    await releaseReservation(reservationId, `released: ${safeError(err, 120)}`);
    throw err;
  }

  const cost = Math.max(0, res.usage.costUsd || 0);
  const paid = res.paid && cost > 0;
  await settleReservation(reservationId, paid ? cost : 0);
  await db.insert(costLedgerEntry).values({
    tenantId: ctx.tenantId,
    jobId: ctx.jobId,
    opportunityId: opts.opportunityId ?? null,
    category: "inference",
    kind: "actual",
    provider: res.family,
    model: res.model,
    amountUsd: round4(cost),
    paid,
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

  // Output scan before anything is persisted: a model output that carries a likely
  // secret is discarded (callers fall back to their deterministic result).
  if (res.family !== "mock") {
    const found = detectLikelySecret(`${res.text ?? ""}\n${res.data === undefined ? "" : JSON.stringify(res.data)}`, knownSecretValues());
    if (found) {
      await emitEvent(db, {
        tenantId: ctx.tenantId,
        type: "security.output_rejected",
        level: "warn",
        agent: ctx.agent,
        runId: ctx.runId,
        jobId: ctx.jobId,
        message: `Discarded ${res.family}/${res.model} output for ${req.task}: it contained a likely secret (${found}) — using the deterministic result instead`,
        data: { task: req.task, kind: found },
      });
      return { ...res, text: "", data: undefined };
    }
  }
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
  /**
   * Stable key of the deliverable UNIT (e.g. `gen:<step>:<scope>:<unit>`),
   * NOT attempt-scoped: a unit that already succeeded is reused (never
   * regenerated or paid twice); each attempt gets its own generation row
   * (`<key>#<n>`) so a failed attempt is never overwritten.
   */
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
  /** "live" | "mock" (for reused units: the mode that produced them). */
  mode: "live" | "mock";
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

/** Provider output that failed but may still be charged (poll timeout / interrupted wait). */
function mayStillBeBilled(message: string | undefined): boolean {
  return Boolean(message && /may still (complete and )?be billed/i.test(message));
}

async function recordPendingCost(
  db: Executor,
  ctx: RunContext,
  input: { jobId: string; generationId: string; provider: string; model: string; amountUsd: number; paid: boolean; label: string },
) {
  if (!(input.amountUsd > 0)) return;
  await db.insert(costLedgerEntry).values({
    tenantId: ctx.tenantId,
    jobId: input.jobId,
    category: "creative",
    kind: "actual",
    provider: input.provider,
    model: input.model,
    amountUsd: round4(input.amountUsd),
    paid: input.paid,
    agentRunId: ctx.runId,
    generationId: input.generationId,
    memo: `pending: provider task may be billed — ${input.label}`.slice(0, 300),
  });
  await addCosts(db, ctx, input.amountUsd);
}

/**
 * Brokered creative generation. Enforces spend authority (a paid route that
 * the job's spend limit cannot afford BLOCKS the step — no silent mock
 * substitution once real spend is enabled), reserves paid spend before the
 * call (hard limit), reuses a unit that already succeeded, stores output
 * bytes, and records generation, asset, ledger and cost rows.
 */
export async function callCreative(ctx: RunContext, input: CallCreativeInput): Promise<CallCreativeResult> {
  const db = getDb();
  const settings = await ctx.settings();
  const broker = brokerOf(ctx.deps);
  const tenantId = ctx.tenantId;
  const unitKey = input.idempotencyKey;

  const [existing] = await db
    .select()
    .from(generation)
    .where(and(eq(generation.tenantId, tenantId), or(eq(generation.unitKey, unitKey), eq(generation.idempotencyKey, unitKey)), eq(generation.status, "succeeded")))
    .orderBy(desc(generation.createdAt))
    .limit(1);
  if (existing) {
    const assets = existing.assetId ? await db.select().from(asset).where(and(eq(asset.tenantId, tenantId), eq(asset.stepId, input.step.id))) : [];
    const mine = assets.filter((a) => (a.meta as Record<string, unknown> | null)?.generationId === existing.id);
    return {
      generationId: existing.id,
      assets: mine,
      decision: null,
      costUsd: Number(existing.actualCostUsd ?? 0),
      provider: existing.provider,
      model: existing.model,
      reused: true,
      mode: (existing.params as Record<string, unknown> | null)?.simulated === true || existing.provider === "mock" ? "mock" : "live",
    };
  }

  const snap = await budgetSnapshot(db, tenantId, settings, { jobId: input.job.id });
  const budget: BudgetContext = { allowPaid: snap.allowPaid, remainingPaidUsd: snap.remainingPaidUsd };
  const metrics = await observedMetrics(db, tenantId);
  const jobRemaining = Number.isFinite(snap.jobRemainingUsd) ? snap.jobRemainingUsd : 0;
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

  const blocked = async (routeLabel: string, neededUsd: number, availableUsd: number): Promise<never> => {
    const msg = `Blocked ${input.label}: ${routeLabel} needs about ${money(neededUsd)} but only ${money(availableUsd)} of paid spend remains for this job`;
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
      data: { remainingPaidUsd: budget.remainingPaidUsd, jobRemainingUsd: jobRemaining, route: routeLabel },
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
  };

  let reservation: { id: string; amountUsd: number } | null = null;
  let generateBudget = budget;
  let generateMaxCost = maxCostUsd;
  if (budget.allowPaid) {
    const unitCost = (o: { unitCostUsd: number | null; unit: string }) => (o.unitCostUsd ?? 0) * (o.unit === "second" ? (input.durationSec ?? 8) : 1);
    const ideal = broker.plan(input.capability, {
      ...opts,
      budget: { allowPaid: true, remainingPaidUsd: Number.POSITIVE_INFINITY },
      durationSec: input.durationSec,
    } as Parameters<typeof broker.plan>[1]);
    const actual = broker.plan(input.capability, { ...opts, maxCostUsd, durationSec: input.durationSec } as Parameters<typeof broker.plan>[1]);
    if (ideal.mode === "live" && actual.mode === "mock") {
      await blocked(`${ideal.option.provider}/${ideal.option.model}`, unitCost(ideal.option), Math.min(budget.remainingPaidUsd, maxCostUsd));
    }
    const liveProvider = actual.mode === "live" ? broker.providers().find((p) => p.key === actual.option.provider) : undefined;
    if (liveProvider?.paid) {
      const expected = unitCost(actual.option);
      // Headroom for provider-side estimates that differ slightly from the catalog.
      const r = await reserveSpend({
        tenantId,
        jobId: input.job.id,
        stepId: input.step.id,
        key: `reservation:${unitKey}#${ctx.runId}`,
        amountUsd: Math.min(expected * 1.2, maxCostUsd),
        minAmountUsd: expected,
        provider: actual.option.provider,
        memo: input.label,
        settings,
      });
      if (!r.ok) await blocked(`${actual.option.provider}/${actual.option.model}`, expected, r.remainingUsd);
      else {
        reservation = { id: r.id, amountUsd: r.amountUsd };
        generateBudget = { allowPaid: true, remainingPaidUsd: r.amountUsd };
        generateMaxCost = r.amountUsd;
      }
    }
  }

  const params = {
    ...(input.params ?? {}),
    aspectRatio: input.aspectRatio ?? null,
    durationSec: input.durationSec ?? null,
    label: input.label,
  };

  // One generation row per attempt — a failed attempt is never overwritten.
  let generationId = "";
  let rowKey = "";
  for (let tries = 0; tries < 3 && !generationId; tries++) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(generation)
      .where(and(eq(generation.tenantId, tenantId), or(eq(generation.unitKey, unitKey), eq(generation.idempotencyKey, unitKey))));
    rowKey = `${unitKey}#${Number(n) + 1 + tries}`;
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
        idempotencyKey: rowKey,
        unitKey,
      })
      .onConflictDoNothing()
      .returning({ id: generation.id });
    if (row) generationId = row.id;
  }
  if (!generationId) {
    await releaseReservation(reservation?.id, "released: generation row conflict");
    throw new Error(`generation insert failed for ${unitKey}`);
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
        idempotencyKey: rowKey,
        maxCostUsd: generateMaxCost,
        context: { tenantId, jobId: input.job.id, stepId: input.step.id },
        signal: ctx.signal,
      },
      { ...opts, budget: generateBudget },
    );
  } catch (err) {
    const message = safeError(err);
    await db.update(generation).set({ status: "failed", error: message }).where(eq(generation.id, generationId));
    const ambiguous = isProviderError(err) && err.code === "ambiguous_submission";
    if (ambiguous && reservation) {
      // The provider may have accepted the job: count the reserved estimate as pending spend.
      await recordPendingCost(db, ctx, { jobId: input.job.id, generationId, provider: err.provider, model: "unknown", amountUsd: reservation.amountUsd, paid: true, label: input.label });
      await settleReservation(reservation.id, reservation.amountUsd);
    } else {
      await releaseReservation(reservation?.id, `released: ${message.slice(0, 120)}`);
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
      message: `${input.label} failed: ${message.slice(0, 200)}`,
    });
    throw err;
  }

  const simulated = out.decision.mode === "mock";
  const cost = Math.max(0, out.costUsd || 0);
  const provider = broker.providers().find((p) => p.key === out.provider);
  const paid = !simulated && Boolean(provider?.paid) && cost > 0;
  await settleReservation(reservation?.id, paid ? cost : 0);

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
      if (mayStillBeBilled(message)) {
        await recordPendingCost(db, ctx, { jobId: input.job.id, generationId, provider: out.provider, model: out.model, amountUsd: cost, paid, label: `${input.label} (task ${out.externalTaskId ?? "?"})` });
      } else {
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

  return { generationId, assets: stored, decision: out.decision, costUsd: cost, provider: out.provider, model: out.model, reused: false, mode: out.decision.mode };
}
