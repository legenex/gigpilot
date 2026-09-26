import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities, SubmissionRequest, SubmissionResult } from "@gigpilot/contracts";
import { envValue, setting } from "../lib/config";
import { credentialSource, resolveCredential } from "../lib/credentials";
import { ProviderError } from "../lib/errors";
import { HttpError, bodySnippet, redactText, safeFetch, type FetchLike, type SafeResponse } from "../lib/http";
import { htmlToText, oneLine } from "../lib/text";

/**
 * Freelancer.com — official REST API (header `Freelancer-OAuth-V1`).
 *
 *  - Search: `GET {FREELANCER_BASE_URL}/projects/0.1/projects/active/` with
 *    full descriptions, job and owner details; budgets converted to USD with
 *    `currency.exchange_rate`. Background polling is allowed (≥ 30 min) and
 *    `RateLimit-Remaining` / `RateLimit-Reset` are respected (the adapter
 *    refuses calls until the reset when the remaining budget hits 0).
 *  - Submit: `POST /projects/0.1/bids/` — ONLY after an explicit owner
 *    approval (the caller's approval gate; `submitRequiresHumanConfirm`).
 *    Never retried. Before bidding the adapter resolves the bidder id
 *    (`GET /users/0.1/self/`), refuses when this user already bid on the
 *    project, and converts the USD amount into the project currency.
 *    GigPilot is a "work sourcer with human-approved bid drafting" — never an
 *    automatic bidder.
 *  - Sandbox: set FREELANCER_BASE_URL=https://www.freelancer-sandbox.com/api.
 *
 * Credentials (package-wide approach, see lib/credentials.ts):
 * FREELANCER_OAUTH_TOKEN per call from the bound tenant (`withTenant` — required
 * for submit(), whose signature has no tenant) or `fetchOpportunities({ tenantId })`
 * → env. `isConfigured()` = env token.
 */

const ALLOWED_HOSTS = ["www.freelancer.com", "www.freelancer-sandbox.com", "api.freelancer.com", "api.freelancer-sandbox.com"];

/** Documented bid error codes → owner-facing messages. */
export const FREELANCER_BID_ERRORS: Record<string, string> = {
  BID_LIMIT_EXCEEDED: "You have used all available bids on Freelancer — wait for bids to replenish or upgrade your membership.",
  BID_DESCRIPTION_CONTAINS_EMAIL: "Freelancer rejects bid descriptions that contain email addresses — remove contact details.",
  BID_DESCRIPTION_CONTAINS_PHONE: "Freelancer rejects bid descriptions that contain phone numbers — remove contact details.",
  BID_DESCRIPTION_CONTAINS_URL: "Freelancer rejects bid descriptions that contain external links.",
  BID_DESCRIPTION_TOO_SHORT: "The bid description is too short for Freelancer.",
  BID_DESCRIPTION_TOO_LONG: "The bid description is too long for Freelancer.",
  PROJECT_NOT_ACTIVE: "The project is no longer accepting bids.",
  PROJECT_NOT_FOUND: "The project no longer exists.",
  BID_ALREADY_PLACED: "You have already bid on this project.",
  DUPLICATE_BID: "You have already bid on this project.",
  BID_AMOUNT_TOO_LOW: "The bid amount is below the project's minimum.",
  BID_AMOUNT_TOO_HIGH: "The bid amount is above the project's maximum.",
  INVALID_BID_AMOUNT: "The bid amount is not valid for this project.",
  INVALID_BID_PERIOD: "The delivery period is not valid.",
  INSUFFICIENT_SKILLS: "Your Freelancer profile lacks the skills this project requires.",
  NOT_ENOUGH_SKILLS: "Your Freelancer profile lacks the skills this project requires.",
  ACCOUNT_NOT_VERIFIED: "Verify your Freelancer account before bidding.",
  USER_NOT_VERIFIED: "Verify your Freelancer account before bidding.",
  PREFERRED_FREELANCER_ONLY: "This project accepts bids from Preferred Freelancers only.",
  PROJECT_UPGRADE_REQUIRED: "This project requires a membership upgrade to bid.",
  UNAUTHORIZED: "The Freelancer token is invalid or lacks the fln:project_manage scope.",
};

export function describeFreelancerError(errorCode: string | undefined, message: string | undefined): string {
  const bare = (errorCode ?? "").split(".").pop()?.toUpperCase() ?? "";
  const known = FREELANCER_BID_ERRORS[bare] ?? Object.entries(FREELANCER_BID_ERRORS).find(([k]) => bare.includes(k))?.[1];
  const base = known ?? (message ? oneLine(message, 200) : "Freelancer rejected the request.");
  return bare ? `${base} (${bare})` : base;
}

interface FlEnvelope<T> {
  status?: "success" | "error";
  result?: T;
  message?: string;
  error_code?: string;
  request_id?: string;
}

export interface FreelancerProject {
  id?: number;
  owner_id?: number;
  title?: string;
  seo_url?: string;
  description?: string;
  preview_description?: string;
  type?: "fixed" | "hourly" | string;
  status?: string;
  frontend_project_status?: string;
  currency?: { code?: string; exchange_rate?: number; sign?: string };
  budget?: { minimum?: number | null; maximum?: number | null };
  bid_stats?: { bid_count?: number; bid_avg?: number };
  time_submitted?: number;
  time_updated?: number;
  jobs?: { name?: string }[];
  hourly_project_info?: { duration_enum?: string; commitment?: { hours?: number; interval?: string } };
}

interface FreelancerUser {
  id?: number;
  username?: string;
  display_name?: string;
  location?: { country?: { name?: string; code?: string } };
  employer_reputation?: { entire_history?: { overall?: number; reviews?: number } };
  reputation?: { entire_history?: { overall?: number } };
}

/** Convert a project-currency amount to USD (exchange_rate = USD per unit). */
export function toUsd(amount: number | null | undefined, currency: FreelancerProject["currency"]): number | undefined {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return undefined;
  const code = (currency?.code ?? "USD").toUpperCase();
  if (code === "USD") return Math.round(amount * 100) / 100;
  const rate = Number(currency?.exchange_rate);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return Math.round(amount * rate * 100) / 100;
}

function webBase(apiBase: string): string {
  return /freelancer-sandbox\.com/i.test(apiBase) ? "https://www.freelancer-sandbox.com" : "https://www.freelancer.com";
}

export function mapFreelancerProject(p: FreelancerProject, users: Record<string, FreelancerUser> = {}, apiBase = "https://www.freelancer.com/api"): RawOpportunity | null {
  if (!p.id || !p.title) return null;
  const owner = p.owner_id !== undefined ? users[String(p.owner_id)] : undefined;
  const type = p.type === "hourly" ? "hourly" : p.type === "fixed" ? "fixed" : "unknown";
  const min = toUsd(p.budget?.minimum, p.currency);
  const max = toUsd(p.budget?.maximum ?? p.budget?.minimum, p.currency);
  const description = p.description ?? p.preview_description ?? "";
  const rating = owner?.employer_reputation?.entire_history?.overall ?? owner?.reputation?.entire_history?.overall;
  return {
    sourceKey: "freelancer",
    externalId: String(p.id),
    url: p.seo_url ? `${webBase(apiBase)}/projects/${p.seo_url.replace(/^\/+/, "")}` : `${webBase(apiBase)}/projects/${p.id}`,
    title: oneLine(p.title, 300),
    description: (/<[a-z][\s\S]*>/i.test(description) ? htmlToText(description) : description).slice(0, 20_000),
    clientName: owner?.display_name ?? owner?.username,
    clientCountry: owner?.location?.country?.name,
    clientRating: typeof rating === "number" && rating > 0 ? rating : undefined,
    budgetType: type,
    budgetMinUsd: min,
    budgetMaxUsd: max,
    currency: p.currency?.code ?? "USD",
    skills: (p.jobs ?? []).map((j) => j.name).filter((s): s is string => Boolean(s)),
    postedAt: typeof p.time_submitted === "number" ? new Date(p.time_submitted * 1000).toISOString() : undefined,
    proposalsCount: p.bid_stats?.bid_count,
    raw: {
      projectId: p.id,
      ownerId: p.owner_id,
      currency: p.currency?.code,
      exchangeRate: p.currency?.exchange_rate,
      budgetOriginal: p.budget,
      bidAvg: p.bid_stats?.bid_avg,
      status: p.frontend_project_status ?? p.status,
    },
  };
}

// Process-wide rate-limit state per API base (shared by tenants using the same app/token host).
const rateState = new Map<string, { remaining?: number; resetAt?: number }>();

export interface FreelancerOptions {
  tenantId?: string | null;
  fetch?: FetchLike;
}

export class FreelancerSource implements SourceAdapter {
  readonly key = "freelancer";
  readonly name = "Freelancer";
  readonly capabilities: SourceCapabilities = {
    canSearch: true,
    canSubmit: true,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: true,
    ingestionMode: "api",
    backgroundPollingAllowed: true,
    minPollIntervalMinutes: 30,
    maxCacheTtlHours: null,
    compliance:
      "Official Freelancer API. GigPilot searches active projects and places a bid only after you approve that specific bid — one bid per approval, never automatic bidding. Rate limits are respected.",
    docsUrl: "https://developers.freelancer.com",
  };

  constructor(private readonly opts: FreelancerOptions = {}) {}

  withTenant(tenantId: string | null): FreelancerSource {
    return new FreelancerSource({ ...this.opts, tenantId });
  }

  isConfigured(): boolean {
    return Boolean(envValue("FREELANCER_OAUTH_TOKEN"));
  }

  /** Tenant-aware configuration check (tenant secret → env). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(await resolveCredential("freelancer", "FREELANCER_OAUTH_TOKEN", tenantId ?? this.opts.tenantId ?? null));
  }

  private apiBase(): string {
    const raw = (setting("FREELANCER_BASE_URL") || "https://www.freelancer.com/api").replace(/\/+$/, "");
    try {
      const host = new URL(raw).hostname;
      if (!ALLOWED_HOSTS.includes(host)) throw new Error("host");
    } catch {
      throw new ProviderError("freelancer", "validation", "FREELANCER_BASE_URL must point at freelancer.com or freelancer-sandbox.com");
    }
    return raw;
  }

  private checkRateLimit(base: string): void {
    const s = rateState.get(base);
    if (s?.remaining !== undefined && s.remaining <= 0 && s.resetAt && Date.now() < s.resetAt) {
      throw new ProviderError("freelancer", "rate_limited", `Freelancer rate limit exhausted — retry after ${new Date(s.resetAt).toISOString()}`, { meta: { resetAt: s.resetAt } });
    }
  }

  private recordRateLimit(base: string, res: SafeResponse): void {
    const remaining = Number(res.headers.get("ratelimit-remaining"));
    const reset = Number(res.headers.get("ratelimit-reset"));
    if (!Number.isFinite(remaining)) return;
    // RateLimit-Reset is delta-seconds (IETF draft); treat very large values as a unix timestamp.
    const resetAt = Number.isFinite(reset) ? (reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000) : Date.now() + 60_000;
    rateState.set(base, { remaining, resetAt });
  }

  private async call<T>(token: string, method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<{ res: SafeResponse; env: FlEnvelope<T> }> {
    const base = this.apiBase();
    this.checkRateLimit(base);
    let res: SafeResponse;
    try {
      res = await safeFetch(
        `${base}${pathAndQuery}`,
        {
          method,
          headers: { "freelancer-oauth-v1": token, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        // GETs retry transient errors; the bid POST is never retried.
        { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: [token], timeoutMs: 30_000, retries: method === "GET" ? 2 : 0, maxBytes: 16 * 1024 * 1024 },
      );
    } catch (err) {
      if (method === "POST" && err instanceof HttpError && (err.code === "timeout" || err.code === "network")) {
        throw new ProviderError("freelancer", "ambiguous_submission", "bid request outcome unknown (timeout/network) — check Freelancer before retrying; not retried automatically");
      }
      throw new ProviderError("freelancer", err instanceof HttpError && err.code === "timeout" ? "timeout" : "unavailable", err instanceof Error ? err.message : "request failed");
    }
    this.recordRateLimit(base, res);
    let env: FlEnvelope<T>;
    try {
      env = res.json<FlEnvelope<T>>();
    } catch {
      env = { status: "error", message: bodySnippet(res, [token]) };
    }
    return { res, env };
  }

  private fail(res: SafeResponse, env: FlEnvelope<unknown>, what: string): ProviderError {
    const msg = redactText(describeFreelancerError(env.error_code, env.message));
    if (res.status === 401) return new ProviderError("freelancer", "auth", `${what}: Freelancer token invalid or expired — reconnect Freelancer`, { status: 401 });
    if (res.status === 403) return new ProviderError("freelancer", "forbidden", `${what}: ${msg}`, { status: 403 });
    if (res.status === 429) return new ProviderError("freelancer", "rate_limited", `${what}: Freelancer rate limit reached`, { status: 429 });
    if (res.status === 404) return new ProviderError("freelancer", "not_found", `${what}: ${msg}`, { status: 404 });
    if (res.status >= 500) return new ProviderError("freelancer", "unavailable", `${what}: Freelancer server error (HTTP ${res.status})`, { status: res.status });
    return new ProviderError("freelancer", "validation", `${what}: ${msg}`, { status: res.status, meta: { errorCode: env.error_code, requestId: env.request_id } });
  }

  async fetchOpportunities(opts: { tenantId: string; query?: string; limit?: number; since?: Date }): Promise<RawOpportunity[]> {
    const token = await resolveCredential("freelancer", "FREELANCER_OAUTH_TOKEN", this.opts.tenantId ?? opts.tenantId);
    if (!token) throw new ProviderError("freelancer", "not_configured", "Connect Freelancer (OAuth token required)");
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const q = new URLSearchParams();
    if (opts.query?.trim()) q.set("query", opts.query.trim().slice(0, 200));
    q.set("full_description", "true");
    q.set("job_details", "true");
    q.set("user_details", "true");
    q.set("user_employer_reputation", "true");
    q.set("user_country_details", "true");
    q.set("limit", String(limit));
    q.append("project_types[]", "fixed");
    q.append("project_types[]", "hourly");
    if (opts.since) q.set("from_time", String(Math.floor(opts.since.getTime() / 1000)));
    const { res, env } = await this.call<{ projects?: FreelancerProject[]; users?: Record<string, FreelancerUser> }>(token, "GET", `/projects/0.1/projects/active/?${q.toString()}`);
    if (!res.ok || env.status === "error") throw this.fail(res, env, "project search failed");
    const base = this.apiBase();
    return (env.result?.projects ?? [])
      .map((p) => mapFreelancerProject(p, env.result?.users ?? {}, base))
      .filter((o): o is RawOpportunity => o !== null)
      .slice(0, limit);
  }

  /**
   * Place ONE bid. The caller must already hold the owner's approval for this
   * exact bid and guarantees one submission per application (idempotency key).
   * Use `withTenant(tenantId).submit(...)` so the tenant's token is used.
   */
  async submit(req: SubmissionRequest): Promise<SubmissionResult> {
    const token = await resolveCredential("freelancer", "FREELANCER_OAUTH_TOKEN", this.opts.tenantId ?? null);
    if (!token) return { status: "rejected", detail: "Freelancer is not connected (OAuth token missing)." };
    const projectId = Number(req.externalOpportunityId);
    if (!Number.isInteger(projectId) || projectId <= 0) return { status: "rejected", detail: "Invalid Freelancer project id." };
    if (!Number.isFinite(req.amountUsd) || req.amountUsd <= 0) return { status: "rejected", detail: "Bid amount must be positive." };
    const period = Math.max(1, Math.round(req.periodDays));
    const description = req.coverLetter.trim();
    if (description.length < 20) return { status: "rejected", detail: "Cover letter is too short." };

    try {
      // 1) bidder id
      const self = await this.call<{ id?: number }>(token, "GET", "/users/0.1/self/");
      if (!self.res.ok || self.env.status === "error" || !self.env.result?.id) throw this.fail(self.res, self.env, "could not resolve your Freelancer user");
      const bidderId = self.env.result.id;

      // 2) project must be active; currency for conversion
      const proj = await this.call<FreelancerProject>(token, "GET", `/projects/0.1/projects/${projectId}/`);
      if (!proj.res.ok || proj.env.status === "error" || !proj.env.result) throw this.fail(proj.res, proj.env, "could not load the project");
      const project = proj.env.result;
      const state = (project.frontend_project_status ?? project.status ?? "").toLowerCase();
      if (state && !["open", "active"].includes(state)) return { status: "rejected", detail: `${FREELANCER_BID_ERRORS.PROJECT_NOT_ACTIVE} (status: ${state})` };

      // 3) refuse a duplicate bid by this user
      const bidsQ = new URLSearchParams();
      bidsQ.append("projects[]", String(projectId));
      bidsQ.append("bidders[]", String(bidderId));
      bidsQ.set("limit", "100");
      const bids = await this.call<{ bids?: { id?: number; bidder_id?: number; project_id?: number }[] }>(token, "GET", `/projects/0.1/bids/?${bidsQ.toString()}`);
      if (!bids.res.ok || bids.env.status === "error") throw this.fail(bids.res, bids.env, "could not check existing bids");
      const existing = (bids.env.result?.bids ?? []).find((b) => b.bidder_id === bidderId && (b.project_id === undefined || b.project_id === projectId));
      if (existing) return { status: "rejected", externalRef: existing.id ? String(existing.id) : undefined, detail: FREELANCER_BID_ERRORS.BID_ALREADY_PLACED! };

      // 4) amount in project currency
      const code = (project.currency?.code ?? "USD").toUpperCase();
      const rate = Number(project.currency?.exchange_rate);
      let amount = req.amountUsd;
      if (code !== "USD") {
        if (!Number.isFinite(rate) || rate <= 0) return { status: "rejected", detail: `Cannot convert USD to ${code}: exchange rate unavailable.` };
        amount = req.amountUsd / rate;
      }
      amount = Math.round(amount * 100) / 100;

      // 5) place the bid — exactly one attempt
      const placed = await this.call<{ id?: number }>(token, "POST", "/projects/0.1/bids/", {
        project_id: projectId,
        bidder_id: bidderId,
        amount,
        period,
        milestone_percentage: 100,
        description,
      });
      if (!placed.res.ok || placed.env.status === "error") {
        const e = this.fail(placed.res, placed.env, "bid rejected");
        if (e.code === "auth" || e.code === "unavailable" || e.code === "rate_limited") throw e;
        return { status: "rejected", detail: e.message.replace(/^freelancer: /, "") };
      }
      const bidId = placed.env.result?.id;
      return { status: "submitted", externalRef: bidId ? String(bidId) : undefined, detail: `Bid placed: ${amount} ${code} over ${period} day(s).` };
    } catch (err) {
      if (err instanceof ProviderError && (err.code === "validation" || err.code === "not_found" || err.code === "forbidden")) {
        return { status: "rejected", detail: err.message.replace(/^freelancer: /, "") };
      }
      throw err;
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const token = await resolveCredential("freelancer", "FREELANCER_OAUTH_TOKEN", this.opts.tenantId ?? null);
    if (!token) return { status: "needs_configuration", detail: "Connect Freelancer: add an OAuth access token (scopes basic + fln:project_manage).", checkedAt };
    const started = Date.now();
    try {
      const { res, env } = await this.call<{ id?: number; username?: string }>(token, "GET", "/users/0.1/self/");
      const latencyMs = Date.now() - started;
      if (!res.ok || env.status === "error") {
        const e = this.fail(res, env, "health check");
        return { status: e.code === "auth" || e.code === "forbidden" ? "error" : "unavailable", detail: e.message, latencyMs, checkedAt };
      }
      const rl = rateState.get(this.apiBase());
      return {
        status: "connected",
        detail: `Freelancer token valid${env.result?.username ? ` (@${env.result.username})` : ""}.`,
        latencyMs,
        checkedAt,
        meta: { sandbox: /sandbox/.test(this.apiBase()), rateLimitRemaining: rl?.remaining ?? null, tokenSource: credentialSource("FREELANCER_OAUTH_TOKEN", token) },
      };
    } catch (err) {
      return { status: err instanceof ProviderError && err.code === "rate_limited" ? "degraded" : "unavailable", detail: err instanceof Error ? err.message : "Freelancer health check failed", latencyMs: Date.now() - started, checkedAt };
    }
  }
}

/** Test helper. */
export function resetFreelancerRateState(): void {
  rateState.clear();
}
