import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";
import { envValue } from "../lib/config";
import { credentialSource, resolveCredential } from "../lib/credentials";
import { ProviderError } from "../lib/errors";
import { HttpError, bodySnippet, redactText, safeFetch, type FetchLike } from "../lib/http";
import { htmlToText, oneLine } from "../lib/text";

/**
 * Upwork — official GraphQL API (`https://api.upwork.com/graphql`,
 * `marketplaceJobPostingsSearch`) with the OWNER'S user OAuth bearer token.
 *
 * Compliance (docs/research/marketplaces.md): search ONLY for a specific,
 * user-directed task — never continuous monitoring or scheduled polling
 * (`backgroundPollingAllowed: false`); cache Upwork content ≤ 24 h
 * (`maxCacheTtlHours: 24`, each item carries `raw.cacheExpiresAt`); no
 * programmatic proposal submission (`canSubmit: false`) — GigPilot prepares
 * the proposal and the owner submits it on Upwork. `fetchOpportunities`
 * refuses to run without an explicit query.
 *
 * Credentials (package-wide approach, see lib/credentials.ts):
 * UPWORK_ACCESS_TOKEN per call from the bound tenant (`withTenant`) or
 * `fetchOpportunities({ tenantId })` (tenant secret) → env. Obtaining the
 * token is a human OAuth step (client id/secret + consent) — never automated.
 * `isConfigured()` = env client id + secret, or an env access token.
 */

const GRAPHQL_URL = "https://api.upwork.com/graphql";
const ALLOWED_HOSTS = ["api.upwork.com"];

const SEARCH_QUERY = `query gigpilotJobSearch($filter: MarketplaceJobPostingsSearchFilter, $searchType: MarketplaceJobPostingSearchType, $sort: [MarketplaceJobPostingSearchSortAttribute]) {
  marketplaceJobPostingsSearch(marketPlaceJobFilter: $filter, searchType: $searchType, sortAttributes: $sort) {
    totalCount
    edges {
      node {
        id
        title
        description
        ciphertext
        amount { rawValue currency }
        hourlyBudgetType
        hourlyBudgetMin { rawValue currency }
        hourlyBudgetMax { rawValue currency }
        skills { name prettyName }
        totalApplicants
        publishedDateTime
        createdDateTime
        experienceLevel
        duration
        client {
          totalHires
          totalPostedJobs
          totalReviews
          totalFeedback
          verificationStatus
          totalSpent { rawValue currency }
          location { country city }
        }
      }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

interface Money {
  rawValue?: string | number | null;
  currency?: string | null;
}

export interface UpworkJobNode {
  id?: string;
  title?: string;
  description?: string;
  ciphertext?: string;
  amount?: Money | null;
  hourlyBudgetType?: string | null;
  hourlyBudgetMin?: Money | null;
  hourlyBudgetMax?: Money | null;
  skills?: { name?: string; prettyName?: string }[] | null;
  totalApplicants?: number | null;
  publishedDateTime?: string | null;
  createdDateTime?: string | null;
  experienceLevel?: string | null;
  duration?: string | null;
  client?: {
    totalHires?: number | null;
    totalPostedJobs?: number | null;
    totalReviews?: number | null;
    totalFeedback?: number | null;
    verificationStatus?: string | null;
    totalSpent?: Money | null;
    location?: { country?: string | null; city?: string | null } | null;
  } | null;
}

function money(m: Money | null | undefined): { value?: number; currency?: string } {
  if (!m) return {};
  const v = Number(m.rawValue);
  return { value: Number.isFinite(v) && v > 0 ? v : undefined, currency: m.currency ?? undefined };
}

function usd(m: { value?: number; currency?: string }): number | undefined {
  if (m.value === undefined) return undefined;
  return !m.currency || m.currency.toUpperCase() === "USD" ? m.value : undefined;
}

/** Map one GraphQL node to a RawOpportunity. */
export function mapUpworkJob(node: UpworkJobNode, fetchedAt = new Date()): RawOpportunity | null {
  const externalId = node.ciphertext ?? node.id;
  if (!externalId || !node.title) return null;
  const fixed = money(node.amount);
  const hMin = money(node.hourlyBudgetMin);
  const hMax = money(node.hourlyBudgetMax);
  const isHourly = hMin.value !== undefined || hMax.value !== undefined || /hourly/i.test(node.hourlyBudgetType ?? "");
  const isFixed = !isHourly && fixed.value !== undefined;
  const budgetType: RawOpportunity["budgetType"] = isHourly ? "hourly" : isFixed ? "fixed" : "unknown";
  const currency = (isHourly ? (hMin.currency ?? hMax.currency) : fixed.currency) ?? "USD";
  const spent = money(node.client?.totalSpent);
  const skills = (node.skills ?? []).map((s) => s.prettyName ?? s.name).filter((s): s is string => Boolean(s));
  const description = node.description ? (/<[a-z][\s\S]*>/i.test(node.description) ? htmlToText(node.description) : node.description) : "";
  return {
    sourceKey: "upwork",
    externalId,
    url: node.ciphertext ? `https://www.upwork.com/jobs/${encodeURIComponent(node.ciphertext)}` : undefined,
    title: oneLine(node.title, 300),
    description: description.slice(0, 20_000),
    clientCountry: node.client?.location?.country ?? undefined,
    clientRating: typeof node.client?.totalFeedback === "number" && node.client.totalFeedback > 0 ? node.client.totalFeedback : undefined,
    clientSpendUsd: usd(spent),
    budgetType,
    budgetMinUsd: isHourly ? usd(hMin) : isFixed ? usd(fixed) : undefined,
    budgetMaxUsd: isHourly ? (usd(hMax) ?? usd(hMin)) : isFixed ? usd(fixed) : undefined,
    currency,
    skills: skills.length ? skills : undefined,
    postedAt: node.publishedDateTime ?? node.createdDateTime ?? undefined,
    proposalsCount: typeof node.totalApplicants === "number" ? node.totalApplicants : undefined,
    raw: {
      upworkId: node.id,
      experienceLevel: node.experienceLevel ?? undefined,
      duration: node.duration ?? undefined,
      clientTotalHires: node.client?.totalHires ?? undefined,
      clientVerification: node.client?.verificationStatus ?? undefined,
      // Upwork ToU: cached API content must be purged within 24 h.
      cacheExpiresAt: new Date(fetchedAt.getTime() + 24 * 3600_000).toISOString(),
    },
  };
}

export interface UpworkOptions {
  tenantId?: string | null;
  fetch?: FetchLike;
}

export class UpworkSource implements SourceAdapter {
  readonly key = "upwork";
  readonly name = "Upwork";
  readonly capabilities: SourceCapabilities = {
    canSearch: true,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: true,
    ingestionMode: "api",
    backgroundPollingAllowed: false,
    minPollIntervalMinutes: 60,
    maxCacheTtlHours: 24,
    compliance:
      "Upwork API search is on-demand only: GigPilot searches when you ask for a specific task and never polls in the background. Upwork content is purged after 24 hours. Proposals are prepared for you to review and submit yourself on Upwork — GigPilot never submits to Upwork.",
    docsUrl: "https://www.upwork.com/developer/documentation/graphql/api/docs/index.html",
  };

  constructor(private readonly opts: UpworkOptions = {}) {}

  withTenant(tenantId: string | null): UpworkSource {
    return new UpworkSource({ ...this.opts, tenantId });
  }

  isConfigured(): boolean {
    return Boolean((envValue("UPWORK_CLIENT_ID") && envValue("UPWORK_CLIENT_SECRET")) || envValue("UPWORK_ACCESS_TOKEN"));
  }

  /** Tenant-aware check: an OAuth access token is available (tenant secret → env). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(await resolveCredential("upwork", "UPWORK_ACCESS_TOKEN", tenantId ?? this.opts.tenantId ?? null));
  }

  private async graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    let res;
    try {
      res = await safeFetch(
        GRAPHQL_URL,
        { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query, variables }) },
        // Read-only query → safe to retry transient failures once.
        { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: [token], timeoutMs: 30_000, retries: 1, idempotent: true, maxBytes: 8 * 1024 * 1024 },
      );
    } catch (err) {
      throw new ProviderError("upwork", err instanceof HttpError && err.code === "timeout" ? "timeout" : "unavailable", err instanceof Error ? err.message : "request failed");
    }
    if (res.status === 401) throw new ProviderError("upwork", "auth", "Upwork rejected the access token (expired or revoked) — reconnect Upwork", { status: 401 });
    if (res.status === 403) throw new ProviderError("upwork", "forbidden", "token lacks the required scope (Marketplace job search / Common Entities read)", { status: 403 });
    if (res.status === 429) throw new ProviderError("upwork", "rate_limited", "Upwork rate limit reached", { status: 429 });
    if (!res.ok) throw new ProviderError("upwork", "provider_error", `Upwork returned HTTP ${res.status}: ${bodySnippet(res, [token])}`, { status: res.status });
    let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
    try {
      body = res.json();
    } catch (err) {
      throw new ProviderError("upwork", "bad_response", err instanceof Error ? err.message : "invalid JSON");
    }
    if (body.errors?.length && !body.data) {
      const msg = redactText(body.errors.map((e) => e.message ?? e.extensions?.code ?? "error").join("; "), [token]).slice(0, 300);
      const code = /auth|token|permission|scope|forbidden/i.test(msg) ? "auth" : "provider_error";
      throw new ProviderError("upwork", code, `GraphQL error: ${msg}`);
    }
    if (!body.data) throw new ProviderError("upwork", "bad_response", "GraphQL response has no data");
    return body.data;
  }

  async fetchOpportunities(opts: { tenantId: string; query?: string; limit?: number; since?: Date }): Promise<RawOpportunity[]> {
    const query = opts.query?.trim();
    if (!query) throw new ProviderError("upwork", "compliance", "Upwork search must be user-directed: provide a specific search query (background polling is not permitted)");
    const token = await resolveCredential("upwork", "UPWORK_ACCESS_TOKEN", this.opts.tenantId ?? opts.tenantId);
    if (!token) throw new ProviderError("upwork", "not_configured", "Connect Upwork (OAuth access token required) before searching");
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const data = await this.graphql<{ marketplaceJobPostingsSearch?: { edges?: { node?: UpworkJobNode }[] } }>(token, SEARCH_QUERY, {
      filter: { searchExpression_eq: query.slice(0, 500), pagination_eq: { first: limit } },
      searchType: "USER_JOBS_SEARCH",
      sort: [{ field: "RECENCY" }],
    });
    const now = new Date();
    const since = opts.since?.getTime();
    return (data.marketplaceJobPostingsSearch?.edges ?? [])
      .map((e) => (e.node ? mapUpworkJob(e.node, now) : null))
      .filter((o): o is RawOpportunity => o !== null)
      .filter((o) => !since || !o.postedAt || Date.parse(o.postedAt) >= since)
      .slice(0, limit);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const tenantId = this.opts.tenantId ?? null;
    const [token, clientId] = await Promise.all([resolveCredential("upwork", "UPWORK_ACCESS_TOKEN", tenantId), resolveCredential("upwork", "UPWORK_CLIENT_ID", tenantId)]);
    if (!token) {
      return clientId
        ? { status: "needs_configuration", detail: "Upwork app credentials present — complete the OAuth connection (owner login) to enable on-demand search.", checkedAt, meta: { clientIdPresent: true, tokenPresent: false } }
        : { status: "needs_configuration", detail: "Add Upwork API credentials (client id/secret) and connect your account via OAuth.", checkedAt, meta: { clientIdPresent: false, tokenPresent: false } };
    }
    const started = Date.now();
    try {
      // Minimal authorized query (no job data fetched).
      await this.graphql<{ user?: { id?: string } }>(token, "query gigpilotHealth { user { id } }", {});
      return { status: "connected", detail: "Upwork token valid — on-demand, user-directed search only.", latencyMs: Date.now() - started, checkedAt, meta: { tokenSource: credentialSource("UPWORK_ACCESS_TOKEN", token) } };
    } catch (err) {
      const e = err instanceof ProviderError ? err : undefined;
      const status = e?.code === "auth" || e?.code === "forbidden" ? "error" : "unavailable";
      return { status, detail: e?.message ?? "Upwork health check failed", latencyMs: Date.now() - started, checkedAt };
    }
  }
}
