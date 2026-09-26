import { QUEUES, type MarketWeight, type QueuePayloads, type RawOpportunity } from "@gigpilot/contracts";
import {
  and,
  desc,
  emitEvent,
  eq,
  getDb,
  getTenantSettings,
  gte,
  inArray,
  market,
  opportunity,
  sourceIntegration,
  transition,
} from "@gigpilot/db";
import { dedupeHash, findDuplicate, isExpired, matchServiceFamily, triageBudget, type DedupeCandidate } from "@gigpilot/economics";
import { sourceOf, type AgentDeps } from "../deps";
import { runAgent } from "../runtime";
import { isConfiguredFor } from "../lib/adapters";
import { detectFamily } from "../heuristics/analysis";
import { familyLabel, money, quote, safeError } from "../lib/util";

/** Payload extension: scheduled fan-out marks runs as `schedule`; missing = user/system directed. */
export type SourceRefreshPayload = QueuePayloads["source-refresh"] & { trigger?: "user" | "schedule" | "signup" };

export interface ScoutResult {
  status: "refreshed" | "skipped";
  reason?: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  expired: number;
  known: number;
  lowBudget: number;
  opportunityIds: string[];
}

const empty = (status: ScoutResult["status"], reason?: string): ScoutResult => ({
  status,
  reason,
  fetched: 0,
  inserted: 0,
  duplicates: 0,
  expired: 0,
  known: 0,
  lowBudget: 0,
  opportunityIds: [],
});

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function date(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normaliseRaw(raw: RawOpportunity) {
  let min = num(raw.budgetMinUsd);
  let max = num(raw.budgetMaxUsd);
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  return {
    externalId: String(raw.externalId).slice(0, 200),
    title: raw.title.replace(/\s+/g, " ").trim().slice(0, 300),
    description: raw.description.trim().slice(0, 20_000),
    url: raw.url && /^https?:\/\//.test(raw.url) ? raw.url.slice(0, 2000) : null,
    clientName: raw.clientName?.slice(0, 200) ?? null,
    clientCountry: raw.clientCountry?.slice(0, 100) ?? null,
    clientRating: typeof raw.clientRating === "number" && raw.clientRating >= 0 && raw.clientRating <= 5 ? raw.clientRating : null,
    clientSpendUsd: num(raw.clientSpendUsd),
    budgetType: raw.budgetType,
    budgetMinUsd: min,
    budgetMaxUsd: max ?? min,
    currency: (raw.currency ?? "USD").slice(0, 8),
    skills: (raw.skills ?? []).map((s) => s.slice(0, 60)).slice(0, 30),
    postedAt: date(raw.postedAt),
    deadlineAt: date(raw.deadlineAt),
    proposalsCount: typeof raw.proposalsCount === "number" && raw.proposalsCount >= 0 ? Math.round(raw.proposalsCount) : null,
    raw: raw.raw ?? {},
  };
}

/** Market (service family) for a normalised listing: detector hits first, then keyword match. */
export function matchMarket(
  n: { title: string; description: string; skills: string[] },
  markets: { key: string; enabled: boolean; keywords: string[] }[],
): { key: string; score: number } | null {
  const keywordMatch = matchServiceFamily(`${n.title} ${n.description}`, n.skills, markets);
  const detected = detectFamily({ title: n.title, description: n.description, skills: n.skills, marketKey: keywordMatch?.key ?? null });
  const enabledKeys = new Set(markets.filter((m) => m.enabled).map((m) => m.key));
  const detectedMatch = enabledKeys.has(detected.family) ? { key: detected.family, score: detected.hits } : null;
  return detected.hits >= 2 && detectedMatch ? detectedMatch : (keywordMatch ?? (detected.hits >= 1 ? detectedMatch : null));
}

/**
 * Market Lab allocation → sourcing weights: enabled markets with allocationPct > 0, as
 * adapter weights (share of the refresh) with their keywords for query-capable adapters.
 */
export function marketWeights(markets: { key: string; enabled: boolean; allocationPct: number; keywords: string[] }[]): MarketWeight[] {
  return markets.filter((m) => m.enabled && m.allocationPct > 0).map((m) => ({ key: m.key, weight: m.allocationPct, keywords: m.keywords }));
}

/**
 * Analysis priority for a new brief: budget-driven base, scaled by its market's share of
 * the allocation (a market allocated 2× the average is analysed first; a 0% / unmatched
 * market last among equals).
 */
export function analysisPriority(base: number, marketKey: string | null, weights: MarketWeight[]): number {
  if (!weights.length) return base;
  const total = weights.reduce((a, w) => a + w.weight, 0);
  const share = marketKey ? (weights.find((w) => w.key === marketKey)?.weight ?? 0) / Math.max(1e-9, total) : 0;
  const avg = 1 / weights.length;
  const factor = Math.min(2, Math.max(0.25, share / avg));
  return Math.max(0, Math.round(base * factor));
}

/**
 * Opportunity Scout. Pulls from a permitted source adapter (respecting its
 * SourceCapabilities) with the tenant's Market Lab allocation as sourcing
 * weights, normalises, matches markets, dedupes, triages budget, inserts
 * idempotently and queues analysis (priority scaled by market weight).
 */
export async function runSourceRefresh(payload: SourceRefreshPayload, deps: AgentDeps): Promise<ScoutResult> {
  const db = getDb();
  const { tenantId, sourceKey } = payload;
  const trigger = payload.trigger ?? "user";
  const now = deps.now();

  const [row] = await db
    .select()
    .from(sourceIntegration)
    .where(and(eq(sourceIntegration.tenantId, tenantId), eq(sourceIntegration.sourceKey, sourceKey)))
    .limit(1);
  if (!row) return empty("skipped", "source not set up for this workspace");
  if (!row.enabled) return empty("skipped", "source disabled");

  const adapter = sourceOf(deps, sourceKey);
  if (!adapter) {
    await db.update(sourceIntegration).set({ status: "error", statusDetail: "No adapter registered", lastError: "No adapter registered" }).where(eq(sourceIntegration.id, row.id));
    return empty("skipped", "no adapter");
  }
  const caps = adapter.capabilities;
  if (!caps.canSearch) return empty("skipped", `${adapter.name} does not support search (${caps.ingestionMode} ingestion)`);
  if (trigger === "schedule" && !caps.backgroundPollingAllowed) {
    return empty("skipped", `${adapter.name} does not permit background polling — user-directed refresh only`);
  }
  if (row.lastSyncAt) {
    const elapsedMin = (now.getTime() - row.lastSyncAt.getTime()) / 60_000;
    if (elapsedMin < caps.minPollIntervalMinutes) {
      const wait = Math.ceil(caps.minPollIntervalMinutes - elapsedMin);
      const reason = `${adapter.name} was refreshed ${Math.floor(elapsedMin)} min ago; source policy allows the next refresh in ${wait} min`;
      if (trigger !== "schedule") {
        await emitEvent(db, { tenantId, type: "source.refreshed", level: "info", agent: "scout", subjectType: "source", subjectId: row.id, message: reason });
      }
      return empty("skipped", reason);
    }
  }
  if (!(await isConfiguredFor(adapter, tenantId))) {
    await db.update(sourceIntegration).set({ status: "needs_configuration", statusDetail: `${adapter.name} needs credentials` }).where(eq(sourceIntegration.id, row.id));
    return empty("skipped", "not configured");
  }

  try {
    return await runAgent(
      { deps, tenantId, agent: "scout", task: "source.refresh", subjectType: "source", subjectId: row.id, label: `Scout refresh of ${adapter.name}` },
      async (ctx) => {
        const settings = await getTenantSettings(db, tenantId);
        const markets = await db
          .select({ key: market.key, enabled: market.enabled, keywords: market.keywords, allocationPct: market.allocationPct })
          .from(market)
          .where(eq(market.tenantId, tenantId));
        const weights = marketWeights(markets);
        const raws = await adapter.fetchOpportunities({
          tenantId,
          limit: 50,
          since: row.lastSyncAt ?? undefined,
          query: typeof row.config.query === "string" ? row.config.query : undefined,
          weights,
        });
        const recent: DedupeCandidate[] = await db
          .select({ id: opportunity.id, title: opportunity.title, description: opportunity.description, dedupeHash: opportunity.dedupeHash })
          .from(opportunity)
          .where(and(eq(opportunity.tenantId, tenantId), gte(opportunity.createdAt, new Date(now.getTime() - 14 * 86_400_000))))
          .orderBy(desc(opportunity.createdAt))
          .limit(600);

        const externalIds = raws.map((r) => String(r.externalId));
        const knownRows = externalIds.length
          ? await db
              .select({ externalId: opportunity.externalId })
              .from(opportunity)
              .where(and(eq(opportunity.tenantId, tenantId), eq(opportunity.sourceKey, sourceKey), inArray(opportunity.externalId, externalIds)))
          : [];
        const known = new Set(knownRows.map((r) => r.externalId));

        const result = empty("refreshed");
        result.fetched = raws.length;
        const toAnalyse: { id: string; priority: number }[] = [];

        for (const raw of raws) {
          const n = normaliseRaw(raw);
          if (!n.title || !n.description) continue;
          if (known.has(n.externalId)) {
            result.known++;
            continue;
          }
          if (isExpired({ postedAt: n.postedAt, deadlineAt: n.deadlineAt }, settings.sourcing.opportunityMaxAgeHours, now)) {
            result.expired++;
            continue;
          }
          const hash = dedupeHash(n.title, n.description);
          const dupOf = findDuplicate({ title: n.title, description: n.description }, recent);
          const match = matchMarket(n, markets);
          const triage = triageBudget(n, settings.thresholds.preferredMinBudgetUsd);
          if (triage === "low_budget") result.lowBudget++;
          const expiresAt =
            n.deadlineAt ?? new Date((n.postedAt ?? now).getTime() + settings.sourcing.opportunityMaxAgeHours * 3_600_000);

          const [inserted] = await db
            .insert(opportunity)
            .values({
              tenantId,
              sourceKey,
              externalId: n.externalId,
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
              postedAt: n.postedAt,
              deadlineAt: n.deadlineAt,
              expiresAt,
              status: "new",
              dedupeHash: hash,
              raw: { ...n.raw, triageBudget: triage, ingestion: caps.ingestionMode, marketMatchScore: match?.score ?? 0, sourceName: adapter.name },
            })
            .onConflictDoNothing()
            .returning({ id: opportunity.id });
          if (!inserted) {
            result.known++;
            continue;
          }
          const budgetText =
            n.budgetType === "hourly"
              ? `${money(n.budgetMinUsd)}–${money(n.budgetMaxUsd)}/h`
              : n.budgetMaxUsd
                ? `${money(n.budgetMaxUsd)} fixed`
                : "no budget stated";
          if (dupOf) {
            result.duplicates++;
            await transition(db, {
              machine: "opportunity",
              id: inserted.id,
              tenantId,
              to: "archived",
              actor: { type: "agent", id: "scout" },
              reason: "near-duplicate of an existing opportunity",
              patch: { duplicateOfId: dupOf },
              event: {
                type: "opportunity.duplicate",
                level: "debug",
                agent: "scout",
                runId: ctx.runId,
                subjectType: "opportunity",
                subjectId: inserted.id,
                message: `Skipped duplicate ${quote(n.title)} — same brief already on the radar`,
                data: { duplicateOfId: dupOf },
              },
            });
            continue;
          }
          result.inserted++;
          result.opportunityIds.push(inserted.id);
          recent.unshift({ id: inserted.id, title: n.title, description: n.description, dedupeHash: hash });
          // Analyse the most valuable briefs first (local GX analysis takes ~30–60 s each).
          const budget = n.budgetMaxUsd ?? n.budgetMinUsd ?? 0;
          const base = triage === "low_budget" ? 0 : triage === "unknown_budget" ? 5 : 10 + Math.min(40, Math.floor(budget / 100));
          const priority = analysisPriority(base, match?.key ?? null, weights);
          toAnalyse.push({ id: inserted.id, priority });
          await emitEvent(db, {
            tenantId,
            type: "opportunity.discovered",
            level: "info",
            agent: "scout",
            runId: ctx.runId,
            subjectType: "opportunity",
            subjectId: inserted.id,
            message: `Discovered ${quote(n.title)} on ${adapter.name} — ${budgetText}${match ? ` · ${familyLabel(match.key)}` : ""}${triage === "low_budget" ? " · low budget" : ""}`,
          });
        }

        await db
          .update(sourceIntegration)
          .set({
            lastSyncAt: now,
            status: caps.ingestionMode === "mock" ? "mock" : "connected",
            statusDetail: `Last refresh: ${result.inserted} new of ${result.fetched} fetched`,
            lastError: null,
          })
          .where(eq(sourceIntegration.id, row.id));

        await emitEvent(db, {
          tenantId,
          type: "source.refreshed",
          level: result.inserted > 0 ? "success" : "info",
          agent: "scout",
          runId: ctx.runId,
          subjectType: "source",
          subjectId: row.id,
          message: `${adapter.name}: ${result.fetched} fetched · ${result.inserted} new · ${result.duplicates} duplicate${result.duplicates === 1 ? "" : "s"} · ${result.expired} expired on arrival · ${result.known} already known`,
          data: { ...result, opportunityIds: undefined, trigger, weights: weights.map((w) => ({ key: w.key, weight: w.weight })) },
        });
        ctx.summary = `${result.inserted} new, ${result.duplicates} duplicates, ${result.expired} expired, ${result.known} known`;

        for (const { id, priority } of toAnalyse) {
          await deps.queue.send(QUEUES.opportunityAnalyse, { tenantId, opportunityId: id }, { singletonKey: id, priority });
        }
        return result;
      },
    );
  } catch (err) {
    const message = safeError(err, 300);
    await db.update(sourceIntegration).set({ status: "error", statusDetail: "Last refresh failed", lastError: message }).where(eq(sourceIntegration.id, row.id));
    await emitEvent(db, { tenantId, type: "source.failed", level: "error", agent: "scout", subjectType: "source", subjectId: row.id, message: `${adapter.name} refresh failed: ${message}` });
    throw err;
  }
}
