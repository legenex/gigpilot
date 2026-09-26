import { OPERATIONAL_DEFAULTS } from "@gigpilot/config";
import { INTEGRATIONS, QUEUES } from "@gigpilot/contracts";
import {
  agentRun,
  and,
  application,
  audit,
  auditEvent,
  delivery,
  emitEvent,
  eq,
  generation,
  getDb,
  getTenantSettings,
  gte,
  idempotencyKey,
  inArray,
  isNotNull,
  job,
  listActiveTenantIds,
  listTenantIds,
  lt,
  notification,
  opportunity,
  proposal,
  providerIntegration,
  providerMetric,
  sourceIntegration,
  sql,
  transition,
  workflowStep,
  type Executor,
} from "@gigpilot/db";
import { QUEUE_CONFIG } from "@gigpilot/db/queue";
import { isExpired } from "@gigpilot/economics";
import { checkIntegration, listSourceAdapters } from "@gigpilot/providers";
import type { ProviderHealth } from "@gigpilot/contracts";
import { sourceOf, type AgentDeps } from "../deps";
import { forTenant, isConfiguredFor } from "../lib/adapters";
import { releaseStaleReservations } from "../lib/budget";
import { notify } from "../lib/notify";
import { quote, safeError } from "../lib/util";

const MIN = 60_000;
/**
 * A running step is "stuck" only after its queue expiry (when pg-boss aborts
 * the handler via job.signal) PLUS a grace period — never while the original
 * handler may still legitimately finish (that caused duplicate execution).
 */
export const STEP_STUCK_MS = (QUEUE_CONFIG["step-execute"].expireInSeconds ?? 1800) * 1000 + OPERATIONAL_DEFAULTS.stuckStepGraceMinutes * MIN;
const RUN_STALE_MS = OPERATIONAL_DEFAULTS.staleRunMinutes * MIN;
/** Demo workspaces keep receiving demo-marketplace opportunities while used within this window. */
const DEMO_ACTIVE_DAYS = 7;

// ---------------------------------------------------------------------------
// Fan-out schedulers
// ---------------------------------------------------------------------------

export async function runSourceRefreshAll(deps: AgentDeps) {
  const db = getDb();
  const now = deps.now();
  const rows = await db.select().from(sourceIntegration).where(eq(sourceIntegration.enabled, true));
  // Demo-marketplace sourcing only runs for workspaces someone used in the last 7 days;
  // real sources keep polling for every workspace that has them enabled.
  const activeDemo = new Set(await listActiveTenantIds(db, DEMO_ACTIVE_DAYS, now));
  const settingsCache = new Map<string, Awaited<ReturnType<typeof getTenantSettings>>>();
  let queued = 0;
  let skipped = 0;
  for (const row of rows) {
    const adapter = sourceOf(deps, row.sourceKey);
    if (row.sourceKey === "mock" && !activeDemo.has(row.tenantId)) {
      skipped++;
      continue;
    }
    if (!adapter || !adapter.capabilities.canSearch || !adapter.capabilities.backgroundPollingAllowed || !(await isConfiguredFor(adapter, row.tenantId))) {
      skipped++;
      continue;
    }
    let settings = settingsCache.get(row.tenantId);
    if (!settings) {
      settings = await getTenantSettings(db, row.tenantId);
      settingsCache.set(row.tenantId, settings);
    }
    const intervalMin = Math.max(adapter.capabilities.minPollIntervalMinutes, settings.sourcing.refreshIntervalMinutes) - 2;
    if (row.lastSyncAt && now.getTime() - row.lastSyncAt.getTime() < intervalMin * 60_000) {
      skipped++;
      continue;
    }
    await deps.queue.send(
      QUEUES.sourceRefresh,
      { tenantId: row.tenantId, sourceKey: row.sourceKey, trigger: "schedule" } as never,
      { singletonKey: `${row.tenantId}:${row.sourceKey}` },
    );
    queued++;
  }
  return { queued, skipped };
}

export async function runMarketResearchAll(deps: AgentDeps) {
  // Market research uses local GX inference; skip workspaces idle for two weeks.
  const tenants = await listActiveTenantIds(getDb(), 14, deps.now());
  for (const tenantId of tenants) await deps.queue.send(QUEUES.marketResearch, { tenantId }, { singletonKey: tenantId });
  return { queued: tenants.length };
}

// ---------------------------------------------------------------------------
// Expiry & cache purge
// ---------------------------------------------------------------------------

const PURGED_TEXT = "[Content purged — the source's terms limit how long listing content may be cached. Derived analysis and economics are retained.]";

export async function runOpportunityExpire(deps: AgentDeps) {
  const db = getDb();
  const now = deps.now();
  let expired = 0;
  let purged = 0;
  for (const tenantId of await listTenantIds(db)) {
    const settings = await getTenantSettings(db, tenantId);
    const candidates = await db
      .select({ id: opportunity.id, title: opportunity.title, postedAt: opportunity.postedAt, expiresAt: opportunity.expiresAt, deadlineAt: opportunity.deadlineAt })
      .from(opportunity)
      .where(and(eq(opportunity.tenantId, tenantId), inArray(opportunity.status, ["new", "analysed", "shortlisted"])))
      .limit(2000);
    for (const o of candidates) {
      if (!isExpired(o, settings.sourcing.opportunityMaxAgeHours, now)) continue;
      try {
        await transition(db, {
          machine: "opportunity",
          id: o.id,
          tenantId,
          to: "expired",
          actor: { type: "system", id: "expiry" },
          reason: "past deadline or maximum age",
          event: { type: "opportunity.expired", level: "debug", agent: "scout", subjectType: "opportunity", subjectId: o.id, message: `Expired ${quote(o.title)} — past its deadline or ${settings.sourcing.opportunityMaxAgeHours}h max age` },
        });
        expired++;
      } catch (err) {
        deps.log.warn({ opportunityId: o.id, error: safeError(err) }, "expire transition skipped");
      }
    }
  }
  // Purge cached content whose per-item cache window has passed (e.g. Upwork sets raw.cacheExpiresAt = fetched + 24h).
  const itemExpired = await db
    .select({ id: opportunity.id, tenantId: opportunity.tenantId, sourceKey: opportunity.sourceKey, raw: opportunity.raw })
    .from(opportunity)
    .where(
      and(
        sql`coalesce(${opportunity.raw} ->> 'purgedAt', '') = ''`,
        sql`(${opportunity.raw} ->> 'cacheExpiresAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'`,
        sql`(${opportunity.raw} ->> 'cacheExpiresAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .limit(1000);
  for (const r of itemExpired) {
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    await db
      .update(opportunity)
      .set({ description: PURGED_TEXT, raw: { purgedAt: now.toISOString(), purgeReason: `cache window ended ${String(raw.cacheExpiresAt)}`, triageBudget: raw.triageBudget ?? null } })
      .where(eq(opportunity.id, r.id));
    await audit(db, { tenantId: r.tenantId, actor: { type: "system", id: "cache-ttl" }, action: "opportunity.content_purged", subjectType: "opportunity", subjectId: r.id, data: { source: r.sourceKey, cacheExpiresAt: raw.cacheExpiresAt } });
    purged++;
  }
  // Belt and braces: purge by the adapter-level TTL for items that carry no per-item expiry.
  for (const adapter of listSourceAdapters()) {
    const ttl = adapter.capabilities.maxCacheTtlHours;
    if (ttl === null || ttl === undefined) continue;
    const cutoff = new Date(now.getTime() - ttl * 3_600_000);
    const rows = await db
      .select({ id: opportunity.id, tenantId: opportunity.tenantId, raw: opportunity.raw })
      .from(opportunity)
      .where(and(eq(opportunity.sourceKey, adapter.key), lt(opportunity.createdAt, cutoff), sql`coalesce(${opportunity.raw} ->> 'purgedAt', '') = ''`))
      .limit(1000);
    for (const r of rows) {
      const raw = (r.raw ?? {}) as Record<string, unknown>;
      await db
        .update(opportunity)
        .set({ description: PURGED_TEXT, raw: { purgedAt: now.toISOString(), purgeReason: `${adapter.name} cache TTL ${ttl}h`, triageBudget: raw.triageBudget ?? null } })
        .where(eq(opportunity.id, r.id));
      await audit(db, { tenantId: r.tenantId, actor: { type: "system", id: "cache-ttl" }, action: "opportunity.content_purged", subjectType: "opportunity", subjectId: r.id, data: { source: adapter.key, ttlHours: ttl } });
      purged++;
    }
  }
  return { expired, purged };
}

// ---------------------------------------------------------------------------
// Provider health
// ---------------------------------------------------------------------------

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runProviderHealth(deps: AgentDeps) {
  const db = getDb();
  const providers = await db.select().from(providerIntegration);
  const sources = await db.select().from(sourceIntegration);
  let changed = 0;
  const timeoutHealth = (key: string): ProviderHealth => ({ status: "unavailable", detail: `${key}: health check timed out`, checkedAt: new Date().toISOString() });
  const check = async (key: string, tenantId: string): Promise<ProviderHealth> => {
    try {
      if (key === "mock") {
        const adapter = sourceOf(deps, "mock");
        if (adapter) return await forTenant(adapter, tenantId).health();
      }
      return await withTimeout(checkIntegration(key, tenantId), 15_000, timeoutHealth(key));
    } catch (err) {
      return { status: "error", detail: `${key}: ${safeError(err, 160)}`, checkedAt: new Date().toISOString() };
    }
  };
  for (const row of providers) {
    const h = await check(row.providerKey, row.tenantId);
    await db
      .update(providerIntegration)
      .set({ status: h.status, statusDetail: h.detail.slice(0, 500), latencyMs: h.latencyMs ?? null, meta: h.meta ?? null, lastCheckAt: new Date() })
      .where(eq(providerIntegration.id, row.id));
    if (h.status !== row.status) {
      changed++;
      const name = INTEGRATIONS.find((i) => i.key === row.providerKey)?.name ?? row.providerKey;
      await emitEvent(db, {
        tenantId: row.tenantId,
        type: "provider.health",
        level: h.status === "connected" || h.status === "mock" ? "success" : h.status === "needs_configuration" ? "info" : "warn",
        agent: "orchestrator",
        subjectType: "provider",
        message: `${name}: ${row.status.replace(/_/g, " ")} → ${h.status.replace(/_/g, " ")} — ${h.detail.slice(0, 160)}`,
      });
    }
  }
  for (const row of sources) {
    const h = await check(row.sourceKey, row.tenantId);
    // A source that is working keeps its sync-derived status unless the adapter reports a problem.
    await db.update(sourceIntegration).set({ status: h.status, statusDetail: h.detail.slice(0, 500) }).where(eq(sourceIntegration.id, row.id));
    if (h.status !== row.status) {
      changed++;
      const name = INTEGRATIONS.find((i) => i.key === row.sourceKey)?.name ?? row.sourceKey;
      await emitEvent(db, {
        tenantId: row.tenantId,
        type: "provider.health",
        level: h.status === "connected" || h.status === "mock" ? "success" : h.status === "needs_configuration" ? "info" : "warn",
        agent: "scout",
        subjectType: "source",
        subjectId: row.id,
        message: `${name}: ${row.status.replace(/_/g, " ")} → ${h.status.replace(/_/g, " ")}`,
      });
    }
  }
  return { checked: providers.length + sources.length, changed };
}

// ---------------------------------------------------------------------------
// Outbox sweeper (bounded re-enqueue of work whose queue message was lost)
// ---------------------------------------------------------------------------

async function requeueCount(db: Executor, subjectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvent)
    .where(and(eq(auditEvent.subjectId, subjectId), eq(auditEvent.action, "outbox.requeued")));
  return Number(row?.n ?? 0);
}

interface SweepItem {
  tenantId: string;
  subjectType: string;
  subjectId: string;
  kind: "application_submit" | "proposal_generate" | "job_plan" | "delivery_prepare";
  what: string;
  link: string;
  /** Override the default bound (OPERATIONAL_DEFAULTS.outboxMaxRequeues). */
  max?: number;
}

/**
 * Re-enqueue follow-up work at most `max` times per item (counted in the
 * audit log), then alert the owner once instead of looping forever.
 */
async function sweepOne(deps: AgentDeps, item: SweepItem, send: () => Promise<unknown>): Promise<"requeued" | "exhausted"> {
  const db = getDb();
  const max = item.max ?? OPERATIONAL_DEFAULTS.outboxMaxRequeues;
  const n = await requeueCount(db, item.subjectId);
  if (n >= max) {
    await notify(db, {
      tenantId: item.tenantId,
      kind: "alert",
      title: `Stuck: ${item.what.slice(0, 120)}`,
      body: `GigPilot re-queued this ${n} times without progress and stopped retrying automatically. Open it to retry or resolve it manually.`,
      link: item.link,
      dedupeKey: `outbox-exhausted:${item.kind}:${item.subjectId}`,
    });
    return "exhausted";
  }
  await send();
  await audit(db, {
    tenantId: item.tenantId,
    actor: { type: "system", id: "outbox-sweeper" },
    action: "outbox.requeued",
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    data: { kind: item.kind, attempt: n + 1, max },
  });
  await emitEvent(db, {
    tenantId: item.tenantId,
    type: "outbox.requeued",
    level: "debug",
    agent: "orchestrator",
    subjectType: item.subjectType === "delivery" ? "delivery" : item.subjectType === "job" ? "job" : item.subjectType === "application" ? "application" : "opportunity",
    subjectId: item.subjectId,
    message: `Re-queued ${item.what} (${n + 1}/${max}) — its follow-up work never arrived`,
  });
  return "requeued";
}

export async function runOutboxSweep(deps: AgentDeps): Promise<{ requeued: number; exhausted: number }> {
  const db = getDb();
  const now = deps.now();
  const cutoff = new Date(now.getTime() - OPERATIONAL_DEFAULTS.outboxIdleMinutes * MIN);
  let requeued = 0;
  let exhausted = 0;
  const tally = (r: "requeued" | "exhausted") => (r === "requeued" ? requeued++ : exhausted++);

  // Approved applications with no submission claim and no manual-submission task.
  const apps = await db
    .select({ id: application.id, tenantId: application.tenantId, idem: application.idempotencyKey })
    .from(application)
    .where(and(eq(application.status, "approved"), lt(application.updatedAt, cutoff)))
    .limit(200);
  for (const a of apps) {
    const [claim] = await db.select({ key: idempotencyKey.key }).from(idempotencyKey).where(eq(idempotencyKey.key, `submit:${a.tenantId}:${a.idem}`)).limit(1);
    if (claim) continue; // a claim exists: submitted, ambiguous (owner notified) or in flight
    const [manual] = await db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.tenantId, a.tenantId), eq(notification.dedupeKey, `manual-submit:${a.id}`)))
      .limit(1);
    if (manual) continue; // waiting for the owner to submit manually
    tally(
      await sweepOne(deps, { tenantId: a.tenantId, subjectType: "application", subjectId: a.id, kind: "application_submit", what: "approved application awaiting submission", link: `/applications?application=${a.id}` }, () =>
        deps.queue.send(QUEUES.applicationSubmit, { tenantId: a.tenantId, applicationId: a.id }, { singletonKey: a.id }),
      ),
    );
  }

  // Pursued opportunities whose proposal was never drafted.
  const pursuing = await db
    .select({ id: opportunity.id, tenantId: opportunity.tenantId })
    .from(opportunity)
    .where(and(eq(opportunity.status, "pursuing"), lt(opportunity.updatedAt, cutoff)))
    .limit(200);
  for (const o of pursuing) {
    const [p] = await db
      .select({ id: proposal.id })
      .from(proposal)
      .where(and(eq(proposal.opportunityId, o.id), inArray(proposal.status, ["draft", "awaiting_approval", "approved", "rejected"])))
      .limit(1);
    if (p) continue;
    tally(
      await sweepOne(deps, { tenantId: o.tenantId, subjectType: "opportunity", subjectId: o.id, kind: "proposal_generate", what: "pursued opportunity without a proposal", link: `/radar/${o.id}` }, () =>
        deps.queue.send(QUEUES.proposalGenerate, { tenantId: o.tenantId, opportunityId: o.id }, { singletonKey: o.id }),
      ),
    );
  }

  // Jobs that never got (or never finished) planning.
  const unplanned = await db
    .select({ id: job.id, tenantId: job.tenantId })
    .from(job)
    .where(and(inArray(job.status, ["intake", "planning"]), lt(job.updatedAt, cutoff)))
    .limit(200);
  for (const j of unplanned) {
    tally(
      await sweepOne(deps, { tenantId: j.tenantId, subjectType: "job", subjectId: j.id, kind: "job_plan", what: "job waiting for production planning", link: `/jobs/${j.id}` }, () =>
        deps.queue.send(QUEUES.jobPlan, { tenantId: j.tenantId, jobId: j.id }, { singletonKey: j.id }),
      ),
    );
  }
  return { requeued, exhausted };
}

// ---------------------------------------------------------------------------
// Job monitor
// ---------------------------------------------------------------------------

export async function runJobMonitor(deps: AgentDeps) {
  const db = getDb();
  const now = deps.now();
  let deadlineAlerts = 0;
  let stuckSteps = 0;
  let staleRuns = 0;
  let requeued = 0;
  let inputReminders = 0;
  let deliveriesRequeued = 0;

  const active = await db.select().from(job).where(inArray(job.status, ["ready", "executing", "qa", "repairing", "planning", "intake", "awaiting_inputs"]));
  for (const j of active) {
    if (j.dueAt && j.dueAt.getTime() - now.getTime() < 24 * 3_600_000) {
      const created = await notify(db, {
        tenantId: j.tenantId,
        kind: "alert",
        title: `Deadline risk: “${j.title.slice(0, 80)}”`,
        body: j.dueAt.getTime() < now.getTime() ? "The due date has passed and the job is not delivered." : `Due ${j.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC and still ${j.status}.`,
        link: `/jobs/${j.id}`,
        dedupeKey: `deadline:${j.id}:${j.dueAt.toISOString().slice(0, 10)}`,
      });
      if (created) {
        deadlineAlerts++;
        await emitEvent(db, { tenantId: j.tenantId, type: "job.state", level: "warn", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `Deadline risk on ${quote(j.title)} — due within 24h while ${j.status}` });
      }
    }
    if (j.status === "awaiting_inputs") {
      // Long waits for client inputs are surfaced to the owner (once per day per job).
      if (now.getTime() - j.updatedAt.getTime() > OPERATIONAL_DEFAULTS.awaitingInputsReminderHours * 3_600_000) {
        const days = Math.floor((now.getTime() - j.updatedAt.getTime()) / 86_400_000);
        const created = await notify(db, {
          tenantId: j.tenantId,
          kind: "approval",
          title: `Still waiting for inputs: “${j.title.slice(0, 80)}”`,
          body: `Production has been waiting for client inputs for ${days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : "over a day"}. Confirm the inputs on the job page to start, or cancel the job.`,
          link: `/jobs/${j.id}`,
          dedupeKey: `job-inputs-waiting:${j.id}:${now.toISOString().slice(0, 10)}`,
        });
        if (created) inputReminders++;
      }
    } else if (j.status !== "intake" && j.status !== "planning") {
      // Cheap, idempotent nudge (stately per job) so a lost tick never stalls a job.
      await deps.queue.send(QUEUES.workflowTick, { tenantId: j.tenantId, jobId: j.id }, { singletonKey: j.id });
    }
  }

  const stuck = await db
    .select()
    .from(workflowStep)
    .where(and(eq(workflowStep.status, "running"), isNotNull(workflowStep.startedAt), lt(workflowStep.startedAt, new Date(now.getTime() - STEP_STUCK_MS))));
  for (const s of stuck) {
    try {
      await transition(db, {
        machine: "step",
        id: s.id,
        tenantId: s.tenantId,
        to: "failed",
        actor: { type: "system", id: "job-monitor" },
        reason: "stuck — exceeded the step time limit",
        expectFrom: ["running"],
        match: { attempts: s.attempts },
        patch: { error: `Timed out: running longer than ${Math.round(STEP_STUCK_MS / MIN)} minutes`, finishedAt: now },
        event: { type: "step.failed", level: "error", agent: "orchestrator", subjectType: "step", subjectId: s.id, jobId: s.jobId, message: `${s.name} timed out after ${Math.round(STEP_STUCK_MS / MIN)} min — the engine will retry within its attempt limit` },
      });
      await deps.queue.send(QUEUES.workflowTick, { tenantId: s.tenantId, jobId: s.jobId }, { singletonKey: s.jobId });
      stuckSteps++;
    } catch (err) {
      deps.log.warn({ stepId: s.id, error: safeError(err) }, "stuck step transition skipped");
    }
  }

  // Deliveries stuck in `preparing` (worker died) or `failed` (retries ran out): re-queue, bounded.
  const deliveryBound = OPERATIONAL_DEFAULTS.deliveryPackagingAttempts + OPERATIONAL_DEFAULTS.deliveryMonitorRequeues;
  const stalled = await db
    .select({ id: delivery.id, tenantId: delivery.tenantId, jobId: delivery.jobId, status: delivery.status, attempts: delivery.attempts, updatedAt: delivery.updatedAt, jobStatus: job.status, title: job.title })
    .from(delivery)
    .innerJoin(job, eq(job.id, delivery.jobId))
    .where(
      and(
        inArray(job.status, ["executing", "qa", "repairing"]),
        sql`(${delivery.status} = 'failed' or (${delivery.status} = 'preparing' and ${delivery.updatedAt} < ${new Date(now.getTime() - OPERATIONAL_DEFAULTS.stalePreparingDeliveryMinutes * MIN).toISOString()}::timestamptz))`,
      ),
    )
    .limit(200);
  for (const d of stalled) {
    if (d.attempts >= deliveryBound) {
      await notify(db, {
        tenantId: d.tenantId,
        kind: "alert",
        title: `Delivery packaging keeps failing: “${d.title.slice(0, 70)}”`,
        body: `GigPilot tried to package this delivery ${d.attempts} times and stopped retrying automatically. Resume the job to try again.`,
        link: `/jobs/${d.jobId}`,
        dedupeKey: `delivery-failed:${d.id}`,
      });
      continue;
    }
    await deps.queue.send(QUEUES.deliveryPrepare, { tenantId: d.tenantId, jobId: d.jobId }, { singletonKey: d.jobId });
    await audit(db, { tenantId: d.tenantId, actor: { type: "system", id: "job-monitor" }, action: "delivery.requeued", subjectType: "delivery", subjectId: d.id, data: { status: d.status, attempts: d.attempts } });
    deliveriesRequeued++;
  }

  const stale = await db
    .select({ id: agentRun.id, tenantId: agentRun.tenantId })
    .from(agentRun)
    .where(and(eq(agentRun.status, "running"), lt(agentRun.startedAt, new Date(now.getTime() - RUN_STALE_MS))));
  for (const r of stale) {
    try {
      await transition(db, { machine: "run", id: r.id, tenantId: r.tenantId, to: "failed", actor: { type: "system", id: "job-monitor" }, patch: { error: "Abandoned: worker stopped before completion", finishedAt: now } });
      staleRuns++;
    } catch {
      /* concurrent completion */
    }
  }

  // Orphaned generations (worker died mid-call): close them so metrics and retries stay truthful.
  const orphans = await db
    .update(generation)
    .set({ status: "failed", error: "orphaned: the worker stopped before the generation finished" })
    .where(and(eq(generation.status, "running"), lt(generation.updatedAt, new Date(now.getTime() - OPERATIONAL_DEFAULTS.orphanGenerationMinutes * MIN))))
    .returning({ id: generation.id });
  const releasedReservations = await releaseStaleReservations(now);

  const lagging = await db
    .select({ id: opportunity.id, tenantId: opportunity.tenantId })
    .from(opportunity)
    .where(
      and(
        inArray(opportunity.status, ["new", "analysing"]),
        lt(opportunity.updatedAt, new Date(now.getTime() - 20 * MIN)),
        gte(opportunity.createdAt, new Date(now.getTime() - 3 * 86_400_000)),
      ),
    )
    .limit(200);
  for (const o of lagging) {
    await deps.queue.send(QUEUES.opportunityAnalyse, { tenantId: o.tenantId, opportunityId: o.id }, { singletonKey: o.id });
    requeued++;
  }

  const outbox = await runOutboxSweep(deps);
  return {
    deadlineAlerts,
    stuckSteps,
    staleRuns,
    requeued: requeued + outbox.requeued,
    outboxExhausted: outbox.exhausted,
    inputReminders,
    deliveriesRequeued,
    orphanGenerations: orphans.length,
    releasedReservations,
  };
}

// ---------------------------------------------------------------------------
// Metrics rollup
// ---------------------------------------------------------------------------

interface GenAgg {
  tenant_id: string;
  provider: string;
  model: string;
  capability: string;
  attempts: number;
  successes: number;
  qa_passes: number;
  qa_checked: number;
  repairs: number;
  total_cost: string | number | null;
  avg_latency: string | number | null;
}

export async function runMetricsRollup(_deps: AgentDeps) {
  const db = getDb();
  const gen = (await db.execute(sql`
    select tenant_id, provider, model, capability,
      count(*)::int as attempts,
      count(*) filter (where status = 'succeeded')::int as successes,
      count(*) filter (where qa_passed is true)::int as qa_passes,
      count(*) filter (where qa_passed is not null)::int as qa_checked,
      count(*) filter (where repair_of_id is not null)::int as repairs,
      coalesce(sum(actual_cost_usd), 0) as total_cost,
      coalesce(avg(latency_ms), 0) as avg_latency
    from generation
    where provider <> 'pending'
      and coalesce(params ->> 'simulated', 'false') <> 'true'
      and coalesce(params ->> 'history', 'false') <> 'true'
    group by tenant_id, provider, model, capability
  `)) as unknown as GenAgg[];
  const inf = (await db.execute(sql`
    select tenant_id, provider, model, 'inference' as capability,
      count(*)::int as attempts,
      count(*) filter (where status = 'succeeded')::int as successes,
      0 as qa_passes, 0 as qa_checked, 0 as repairs,
      coalesce(sum(cost_usd), 0) as total_cost,
      coalesce(avg(extract(epoch from (finished_at - started_at)) * 1000) filter (where finished_at is not null and started_at is not null), 0) as avg_latency
    from agent_run
    where provider is not null and model is not null and tenant_id is not null
    group by tenant_id, provider, model
  `)) as unknown as GenAgg[];
  let upserts = 0;
  for (const r of [...gen, ...inf]) {
    const totalCost = Number(r.total_cost ?? 0);
    const usableBase = r.qa_checked > 0 ? r.qa_passes : r.successes;
    const usableRate = r.attempts > 0 ? usableBase / r.attempts : null;
    const values = {
      tenantId: r.tenant_id,
      provider: r.provider,
      model: r.model,
      capability: r.capability,
      attempts: Number(r.attempts),
      successes: Number(r.successes),
      qaPasses: Number(r.qa_passes),
      repairs: Number(r.repairs),
      totalCostUsd: Math.round(totalCost * 10_000) / 10_000,
      avgLatencyMs: Math.round(Number(r.avg_latency ?? 0)),
      usableRate: usableRate === null ? null : Math.round(usableRate * 1000) / 1000,
      costPerUsableUsd: usableBase > 0 ? Math.round((totalCost / usableBase) * 10_000) / 10_000 : null,
    };
    await db
      .insert(providerMetric)
      .values(values)
      .onConflictDoUpdate({
        target: [providerMetric.tenantId, providerMetric.provider, providerMetric.model, providerMetric.capability],
        set: { ...values, updatedAt: new Date() },
      });
    upserts++;
  }
  // Creative metrics steer routing: drop rows no longer backed by real (non-simulated) generations
  // (e.g. rows seeded from demo history before simulated generations were excluded).
  const backed = new Set(gen.map((r) => `${r.tenant_id}|${r.provider}|${r.model}|${r.capability}`));
  const creativeRows = await db
    .select({ id: providerMetric.id, tenantId: providerMetric.tenantId, provider: providerMetric.provider, model: providerMetric.model, capability: providerMetric.capability })
    .from(providerMetric)
    .where(sql`${providerMetric.capability} <> 'inference'`);
  const stale = creativeRows.filter((m) => !backed.has(`${m.tenantId}|${m.provider}|${m.model}|${m.capability}`)).map((m) => m.id);
  if (stale.length) await db.delete(providerMetric).where(inArray(providerMetric.id, stale));
  return { upserts, pruned: stale.length };
}

// ---------------------------------------------------------------------------
// Notifications (internal only)
// ---------------------------------------------------------------------------

/**
 * Internal digest. GigPilot has no external notification channel in V1 —
 * nothing is emailed or messaged. This keeps the inbox tidy (purges read
 * notifications older than 30 days) and reports unread counts.
 */
export async function runNotificationsDispatch(deps: AgentDeps) {
  const db = getDb();
  const now = deps.now();
  const purged = await db
    .delete(notification)
    .where(and(isNotNull(notification.readAt), lt(notification.readAt, new Date(now.getTime() - 30 * 86_400_000))))
    .returning({ id: notification.id });
  const unread = (await db.execute(sql`select tenant_id, count(*)::int as n from notification where read_at is null group by tenant_id`)) as unknown as { tenant_id: string; n: number }[];
  return { purged: purged.length, tenantsWithUnread: unread.length, unread: unread.reduce((a, r) => a + Number(r.n), 0) };
}
