import { INTEGRATIONS, QUEUES } from "@gigpilot/contracts";
import {
  agentRun,
  and,
  audit,
  emitEvent,
  eq,
  getDb,
  getTenantSettings,
  gte,
  inArray,
  isNotNull,
  job,
  listActiveTenantIds,
  listTenantIds,
  lt,
  notification,
  opportunity,
  providerIntegration,
  providerMetric,
  sourceIntegration,
  sql,
  transition,
  workflowStep,
} from "@gigpilot/db";
import { isExpired } from "@gigpilot/economics";
import { checkIntegration, listSourceAdapters } from "@gigpilot/providers";
import type { ProviderHealth } from "@gigpilot/contracts";
import { sourceOf, type AgentDeps } from "../deps";
import { forTenant, isConfiguredFor } from "../lib/adapters";
import { notify } from "../lib/notify";
import { quote, safeError } from "../lib/util";

/** step-execute expireInSeconds (keep in sync with QUEUE_CONFIG). */
const STEP_STUCK_MS = 30 * 60_000;
const RUN_STALE_MS = 2 * 60 * 60_000;
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
// Job monitor
// ---------------------------------------------------------------------------

export async function runJobMonitor(deps: AgentDeps) {
  const db = getDb();
  const now = deps.now();
  let deadlineAlerts = 0;
  let stuckSteps = 0;
  let staleRuns = 0;
  let requeued = 0;

  const active = await db.select().from(job).where(inArray(job.status, ["ready", "executing", "qa", "repairing", "planning", "intake"]));
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
    if (j.status === "intake" || j.status === "planning") {
      if (now.getTime() - j.updatedAt.getTime() > 10 * 60_000) {
        await deps.queue.send(QUEUES.jobPlan, { tenantId: j.tenantId, jobId: j.id }, { singletonKey: j.id });
        requeued++;
      }
    } else {
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
        patch: { error: "Timed out: running longer than 30 minutes", finishedAt: now },
        event: { type: "step.failed", level: "error", agent: "orchestrator", subjectType: "step", subjectId: s.id, jobId: s.jobId, message: `${s.name} timed out after 30 min — Recovery will retry within its attempt limit` },
      });
      await deps.queue.send(QUEUES.workflowTick, { tenantId: s.tenantId, jobId: s.jobId }, { singletonKey: s.jobId });
      stuckSteps++;
    } catch (err) {
      deps.log.warn({ stepId: s.id, error: safeError(err) }, "stuck step transition skipped");
    }
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

  const lagging = await db
    .select({ id: opportunity.id, tenantId: opportunity.tenantId })
    .from(opportunity)
    .where(
      and(
        inArray(opportunity.status, ["new", "analysing"]),
        lt(opportunity.updatedAt, new Date(now.getTime() - 20 * 60_000)),
        gte(opportunity.createdAt, new Date(now.getTime() - 3 * 86_400_000)),
      ),
    )
    .limit(200);
  for (const o of lagging) {
    await deps.queue.send(QUEUES.opportunityAnalyse, { tenantId: o.tenantId, opportunityId: o.id }, { singletonKey: o.id });
    requeued++;
  }
  return { deadlineAlerts, stuckSteps, staleRuns, requeued };
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
  return { upserts };
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
