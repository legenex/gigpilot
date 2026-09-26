import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";
import { and, eq, getDb, sourceIntegration } from "@gigpilot/db";
import { ProviderError } from "../lib/errors";
import { safeFetch, type FetchLike, type LookupFn } from "../lib/http";
import { parseBudget } from "../lib/inbound";
import { parseFeed, type FeedItem } from "../lib/rss";
import { htmlToText, oneLine } from "../lib/text";
import { createHash } from "node:crypto";

/**
 * Public web feeds — official job APIs / RSS feeds intended for programmatic
 * use, each with attribution and a minimum fetch interval:
 *
 *   wwr       We Work Remotely RSS          ≥ 60 min   link back + credit
 *   remotive  Remotive API                  ≥ 360 min  (≤ 4 requests/day) link back + credit
 *   hn        HN Algolia API, monthly "Freelancer? Seeking freelancer?" thread,
 *             top-level "SEEKING FREELANCER" comments only (never HTML)   ≥ 60 min
 *   remoteok  Remote OK API (element 0 = legal notice, skipped) ≥ 60 min, link back (follow) + credit
 *
 * Fetches go through `safeFetch` with a host allow-list; results are cached
 * PROCESS-WIDE per feed for its minimum interval, so any number of tenants /
 * scheduler ticks produce at most one upstream request per interval.
 *
 * CONFIG CHOICE: the SourceAdapter signature only carries {tenantId, query,
 * limit, since}, so the adapter reads the tenant's `source_integration.config`
 * (sourceKey "web") through an injectable loader (default: DB query):
 *   { feeds?: ("wwr"|"remotive"|"hn"|"remoteok")[], query?: string,
 *     contractOnly?: boolean (default true), customFeeds?: string[] (≤ 5 RSS/Atom URLs) }
 * `opts.query` overrides `config.query`. Query = comma-separated phrases,
 * matched case-insensitively (any phrase). Custom feed URLs are user-supplied,
 * so they are fetched with the full SSRF guard.
 *
 * Credentials: none.
 */

export type FeedKey = "wwr" | "remotive" | "hn" | "remoteok";
export const FEED_KEYS: FeedKey[] = ["wwr", "remotive", "hn", "remoteok"];

export interface WebFeedConfig {
  feeds?: string[];
  query?: string;
  contractOnly?: boolean;
  customFeeds?: string[];
}

export type WebConfigLoader = (tenantId: string) => Promise<WebFeedConfig>;

const USER_AGENT = "GigPilot/0.1 (+https://gigpilot.ai; official feed ingestion)";

interface FeedDef {
  name: string;
  url: string;
  host: string[];
  minIntervalMinutes: number;
  homepage: string;
}

export const FEEDS: Record<FeedKey, FeedDef> = {
  wwr: { name: "We Work Remotely", url: "https://weworkremotely.com/remote-jobs.rss", host: ["weworkremotely.com"], minIntervalMinutes: 60, homepage: "https://weworkremotely.com" },
  remotive: { name: "Remotive", url: "https://remotive.com/api/remote-jobs?limit=200", host: ["remotive.com"], minIntervalMinutes: 360, homepage: "https://remotive.com" },
  hn: { name: "Hacker News", url: "https://hn.algolia.com/api/v1/search_by_date", host: ["hn.algolia.com"], minIntervalMinutes: 60, homepage: "https://news.ycombinator.com" },
  remoteok: { name: "Remote OK", url: "https://remoteok.com/api", host: ["remoteok.com"], minIntervalMinutes: 60, homepage: "https://remoteok.com" },
};

/** Flag stored on each item: does it look like contract/freelance work? */
interface FeedOpportunity extends RawOpportunity {
  raw: Record<string, unknown> & { contract: boolean; attribution: { name: string; url?: string; linkRequired: true } };
}

const CONTRACT_RE = /\b(freelanc\w*|contract(?:or)?|contract[- ]to[- ]hire|project[- ]based|fixed[- ]price|part[- ]time|gig|consultant|hourly)\b/i;

function id(prefix: string, v: string): string {
  return `${prefix}:${createHash("sha256").update(v).digest("hex").slice(0, 20)}`;
}

function attribution(name: string, url?: string) {
  return { name, url, linkRequired: true as const };
}

// ---------------------------------------------------------------------------
// Mappers (exported for tests)
// ---------------------------------------------------------------------------

export function mapWwrItem(item: FeedItem): FeedOpportunity | null {
  if (!item.title) return null;
  const idx = item.title.indexOf(":");
  const company = idx > 0 ? item.title.slice(0, idx).trim() : undefined;
  const role = idx > 0 ? item.title.slice(idx + 1).trim() : item.title.trim();
  const description = htmlToText(item.description, 20_000);
  const type = item.fields.type ?? "";
  const contract = /contract|freelance|part[- ]time/i.test(type) || CONTRACT_RE.test(`${role}\n${description.slice(0, 3000)}`);
  const skills = (item.fields.skills ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    sourceKey: "web",
    externalId: `wwr:${item.guid ?? item.link ?? id("wwr", item.title)}`.slice(0, 300),
    url: item.link,
    title: oneLine(role, 300),
    description,
    clientName: company,
    clientCountry: item.fields.country || undefined,
    budgetType: "unknown",
    skills: skills.length ? skills : item.categories.length ? item.categories : undefined,
    postedAt: item.published,
    raw: { feed: "wwr", type, region: item.fields.region, category: item.categories[0], contract, attribution: attribution("We Work Remotely", item.link) },
  };
}

interface RemotiveJob {
  id?: number | string;
  url?: string;
  title?: string;
  company_name?: string;
  category?: string;
  tags?: string[] | string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export function mapRemotiveJob(j: RemotiveJob): FeedOpportunity | null {
  if (!j.title || j.id === undefined) return null;
  const description = htmlToText(j.description ?? "", 20_000);
  const tags = Array.isArray(j.tags) ? j.tags : typeof j.tags === "string" ? j.tags.replace(/[[\]']/g, "").split(",").map((t) => t.trim()).filter(Boolean) : [];
  const contract = /contract|freelance/i.test(j.job_type ?? "");
  const budget = j.salary ? parseBudget(j.salary) : undefined;
  const hourly = budget?.type === "hourly" && budget.currency === "USD";
  return {
    sourceKey: "web",
    externalId: `remotive:${j.id}`,
    url: j.url,
    title: oneLine(j.title, 300),
    description,
    clientName: j.company_name,
    clientCountry: j.candidate_required_location || undefined,
    budgetType: hourly ? "hourly" : "unknown",
    budgetMinUsd: hourly ? budget?.min : undefined,
    budgetMaxUsd: hourly ? budget?.max : undefined,
    skills: tags.length ? tags.slice(0, 20) : undefined,
    postedAt: j.publication_date && !Number.isNaN(Date.parse(j.publication_date)) ? new Date(j.publication_date.endsWith("Z") ? j.publication_date : `${j.publication_date}Z`).toISOString() : undefined,
    raw: { feed: "remotive", jobType: j.job_type, category: j.category, salary: j.salary || undefined, contract, attribution: attribution("Remotive", j.url) },
  };
}

interface HnHit {
  objectID?: string;
  author?: string;
  comment_text?: string;
  created_at?: string;
  parent_id?: number | string;
  story_id?: number | string;
  title?: string;
}

export function mapHnComment(h: HnHit, storyId: string): FeedOpportunity | null {
  if (!h.objectID || !h.comment_text) return null;
  if (String(h.parent_id) !== String(storyId)) return null; // top-level comments only
  const text = htmlToText(h.comment_text, 20_000);
  if (!/^\s*seeking\s+freelancers?\b/i.test(text)) return null; // only people HIRING freelancers
  const firstLine = text.split("\n")[0] ?? text;
  const title = oneLine(firstLine.replace(/^\s*seeking\s+freelancers?\s*[|:\-–—.]?\s*/i, ""), 160) || "Seeking freelancer (Hacker News)";
  const budget = parseBudget(text);
  const usd = budget.currency === "USD";
  const url = `https://news.ycombinator.com/item?id=${encodeURIComponent(h.objectID)}`;
  return {
    sourceKey: "web",
    externalId: `hn:${h.objectID}`,
    url,
    title,
    description: text,
    clientName: h.author,
    budgetType: usd ? budget.type : "unknown",
    budgetMinUsd: usd ? budget.min : undefined,
    budgetMaxUsd: usd ? budget.max : undefined,
    postedAt: h.created_at,
    raw: { feed: "hn", storyId, contract: true, attribution: attribution("Hacker News", url) },
  };
}

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  url?: string;
  position?: string;
  company?: string;
  tags?: string[];
  description?: string;
  date?: string;
  location?: string;
  salary_min?: number | string;
  salary_max?: number | string;
  legal?: string;
}

export function mapRemoteOkJob(j: RemoteOkJob): FeedOpportunity | null {
  if (j.legal !== undefined || !j.position || j.id === undefined) return null;
  const description = htmlToText(j.description ?? "", 20_000);
  const tags = Array.isArray(j.tags) ? j.tags : [];
  const contract = tags.some((t) => /contract|freelance|part[- ]time/i.test(t)) || CONTRACT_RE.test(`${j.position}\n${description.slice(0, 3000)}`);
  const url = j.url ?? (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : undefined);
  return {
    sourceKey: "web",
    externalId: `remoteok:${j.id}`,
    url,
    title: oneLine(j.position, 300),
    description,
    clientName: j.company,
    clientCountry: j.location || undefined,
    budgetType: "unknown",
    skills: tags.length ? tags.slice(0, 20) : undefined,
    postedAt: j.date && !Number.isNaN(Date.parse(j.date)) ? new Date(j.date).toISOString() : undefined,
    raw: { feed: "remoteok", salaryMin: Number(j.salary_min) || undefined, salaryMax: Number(j.salary_max) || undefined, contract, attribution: attribution("Remote OK", url) },
  };
}

export function mapCustomItem(item: FeedItem, feedUrl: string): FeedOpportunity | null {
  if (!item.title) return null;
  const host = (() => {
    try {
      return new URL(feedUrl).hostname;
    } catch {
      return "custom feed";
    }
  })();
  const description = htmlToText(item.description, 20_000);
  return {
    sourceKey: "web",
    externalId: `custom:${createHash("sha256").update(`${feedUrl}\u0000${item.guid ?? item.link ?? item.title}`).digest("hex").slice(0, 24)}`,
    url: item.link && /^https?:\/\//i.test(item.link) ? item.link : undefined,
    title: oneLine(item.title, 300),
    description,
    budgetType: "unknown",
    skills: item.categories.length ? item.categories.slice(0, 20) : undefined,
    postedAt: item.published,
    raw: { feed: "custom", feedHost: host, contract: CONTRACT_RE.test(`${item.title}\n${description.slice(0, 3000)}`), attribution: attribution(host, item.link) },
  };
}

// ---------------------------------------------------------------------------
// Process-wide feed cache (enforces minimum intervals)
// ---------------------------------------------------------------------------

interface FeedState {
  fetchedAt?: number;
  items: FeedOpportunity[];
  lastError?: string;
  lastErrorAt?: number;
}
const feedState = new Map<string, FeedState>();

/** Test helper. */
export function resetWebFeedCache(): void {
  feedState.clear();
}

async function defaultConfigLoader(tenantId: string): Promise<WebFeedConfig> {
  const rows = await getDb()
    .select({ config: sourceIntegration.config })
    .from(sourceIntegration)
    .where(and(eq(sourceIntegration.tenantId, tenantId), eq(sourceIntegration.sourceKey, "web")))
    .limit(1);
  return (rows[0]?.config ?? {}) as WebFeedConfig;
}

export interface WebFeedOptions {
  fetch?: FetchLike;
  lookup?: LookupFn;
  configLoader?: WebConfigLoader;
  now?: () => number;
}

export class WebFeedSource implements SourceAdapter {
  readonly key = "web";
  readonly name = "Public web feeds";
  readonly capabilities: SourceCapabilities = {
    canSearch: true,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "rss",
    backgroundPollingAllowed: true,
    minPollIntervalMinutes: 60,
    maxCacheTtlHours: null,
    attribution: { name: "We Work Remotely, Remotive, Hacker News, Remote OK", linkRequired: true },
    compliance:
      "Only official public APIs and RSS feeds are used, never page scraping. Each listing links back to and credits its source. Feeds are fetched at most once per their stated interval (Remotive at most 4 times a day). Applications are made on the original site.",
  };

  constructor(private readonly opts: WebFeedOptions = {}) {}

  withTenant(_tenantId: string | null): WebFeedSource {
    return this;
  }

  isConfigured(): boolean {
    return true;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async get(url: string, hosts: string[] | null, maxBytes = 5 * 1024 * 1024) {
    const res = await safeFetch(
      url,
      { headers: { "user-agent": USER_AGENT, accept: "application/json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } },
      hosts ? { allowHosts: hosts, fetch: this.opts.fetch, timeoutMs: 20_000, retries: 1, maxBytes } : { ssrfGuard: true, fetch: this.opts.fetch, lookup: this.opts.lookup, timeoutMs: 20_000, retries: 1, maxBytes },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  private async fetchFeed(key: FeedKey): Promise<FeedOpportunity[]> {
    const def = FEEDS[key];
    switch (key) {
      case "wwr": {
        const res = await this.get(def.url, def.host);
        return parseFeed(res.text(), 300).map(mapWwrItem).filter((x): x is FeedOpportunity => x !== null);
      }
      case "remotive": {
        const res = await this.get(def.url, def.host, 20 * 1024 * 1024);
        const data = res.json<{ jobs?: RemotiveJob[] }>();
        return (data.jobs ?? []).map(mapRemotiveJob).filter((x): x is FeedOpportunity => x !== null);
      }
      case "hn": {
        const q = new URLSearchParams({ query: '"Freelancer? Seeking freelancer?"', tags: "story,author_whoishiring", hitsPerPage: "5" });
        const stories = (await this.get(`${def.url}?${q.toString()}`, def.host)).json<{ hits?: HnHit[] }>();
        const story = (stories.hits ?? []).find((h) => /freelancer\?\s*seeking freelancer\?/i.test(h.title ?? ""));
        if (!story?.objectID) return [];
        const c = new URLSearchParams({ tags: `comment,story_${story.objectID}`, hitsPerPage: "500" });
        const comments = (await this.get(`https://hn.algolia.com/api/v1/search?${c.toString()}`, def.host)).json<{ hits?: HnHit[] }>();
        return (comments.hits ?? []).map((h) => mapHnComment(h, story.objectID!)).filter((x): x is FeedOpportunity => x !== null);
      }
      case "remoteok": {
        const res = await this.get(def.url, def.host, 20 * 1024 * 1024);
        const data = res.json<RemoteOkJob[]>();
        if (!Array.isArray(data)) throw new Error("unexpected Remote OK payload");
        return data.slice(1).map(mapRemoteOkJob).filter((x): x is FeedOpportunity => x !== null);
      }
    }
  }

  /** Cached fetch honouring the feed's minimum interval. */
  private async cached(cacheKey: string, minIntervalMinutes: number, load: () => Promise<FeedOpportunity[]>): Promise<{ items: FeedOpportunity[]; error?: string }> {
    const state = feedState.get(cacheKey) ?? { items: [] };
    const now = this.now();
    const fresh = state.fetchedAt !== undefined && now - state.fetchedAt < minIntervalMinutes * 60_000;
    // Also back off after an error for the same interval (never hammer a failing feed).
    const recentError = state.lastErrorAt !== undefined && now - state.lastErrorAt < Math.min(minIntervalMinutes, 60) * 60_000;
    if (fresh || recentError) return { items: state.items, error: recentError && !fresh ? state.lastError : undefined };
    try {
      const items = await load();
      feedState.set(cacheKey, { fetchedAt: now, items });
      return { items };
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : "fetch failed";
      feedState.set(cacheKey, { ...state, lastError: message, lastErrorAt: now });
      return { items: state.items, error: message };
    }
  }

  async fetchOpportunities(opts: { tenantId: string; query?: string; limit?: number; since?: Date }): Promise<RawOpportunity[]> {
    let config: WebFeedConfig = {};
    try {
      config = await (this.opts.configLoader ?? defaultConfigLoader)(opts.tenantId);
    } catch {
      config = {};
    }
    const feeds = (Array.isArray(config.feeds) ? config.feeds : FEED_KEYS).filter((f): f is FeedKey => (FEED_KEYS as string[]).includes(f));
    const custom = (config.customFeeds ?? [])
      .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u) && URL.canParse(u))
      .slice(0, 5);
    const contractOnly = config.contractOnly !== false;
    const query = (opts.query ?? config.query ?? "").trim();
    const phrases = query
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);

    const results = await Promise.all([
      ...feeds.map((f) => this.cached(f, FEEDS[f].minIntervalMinutes, () => this.fetchFeed(f)).then((r) => ({ key: f as string, ...r }))),
      ...custom.map((u) =>
        this.cached(`custom:${u}`, 60, async () => {
          const res = await this.get(u, null);
          return parseFeed(res.text(), 200)
            .map((i) => mapCustomItem(i, u))
            .filter((x): x is FeedOpportunity => x !== null);
        }).then((r) => ({ key: `custom:${new URL(u).hostname}`, ...r })),
      ),
    ]);
    const errors = results.filter((r) => r.error && !r.items.length);
    if (results.length && errors.length === results.length) {
      throw new ProviderError("web", "unavailable", `all feeds failed: ${errors.map((e) => `${e.key}: ${e.error}`).join("; ")}`);
    }

    const since = opts.since?.getTime();
    const seen = new Set<string>();
    const out: RawOpportunity[] = [];
    for (const r of results) {
      for (const item of r.items) {
        if (seen.has(item.externalId)) continue;
        if (contractOnly && !item.raw.contract) continue;
        if (since && item.postedAt && Date.parse(item.postedAt) < since) continue;
        if (phrases.length) {
          const hay = `${item.title}\n${item.description}\n${(item.skills ?? []).join(" ")}`.toLowerCase();
          if (!phrases.some((p) => hay.includes(p))) continue;
        }
        seen.add(item.externalId);
        out.push(item);
      }
    }
    out.sort((a, b) => (Date.parse(b.postedAt ?? "") || 0) - (Date.parse(a.postedAt ?? "") || 0));
    return out.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  async health(): Promise<ProviderHealth> {
    // Zero network calls: feeds have strict request budgets (Remotive ≤ 4/day).
    const checkedAt = new Date().toISOString();
    const feeds = FEED_KEYS.map((k) => {
      const s = feedState.get(k);
      return {
        feed: k,
        name: FEEDS[k].name,
        minIntervalMinutes: FEEDS[k].minIntervalMinutes,
        lastFetchedAt: s?.fetchedAt ? new Date(s.fetchedAt).toISOString() : null,
        cachedItems: s?.items.length ?? 0,
        lastError: s?.lastError ?? null,
      };
    });
    const failing = feeds.filter((f) => f.lastError && !f.lastFetchedAt);
    if (failing.length === feeds.length) return { status: "degraded", detail: "All public feeds failed on their last fetch.", checkedAt, meta: { feeds } };
    return { status: "connected", detail: "Official public feeds (no credentials needed); fetched at most once per stated interval.", checkedAt, meta: { feeds } };
  }
}
