import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { SERVICE_FAMILIES } from "@gigpilot/config/defaults";
import { INTEGRATIONS, SOURCE_KEYS, defaultTenantSettings, resolveTenantSettings, type TenantSettings } from "@gigpilot/contracts";
import type { Executor } from "./client";
import { market, membership, providerIntegration, session, sourceIntegration, tenant, user } from "./schema";
import { audit } from "./transitions";

const MARKET_KEYWORDS: Record<string, string[]> = {
  "paid-social-ugc": ["ugc", "ad creative", "tiktok", "meta ads", "facebook ads", "hooks", "paid social", "reels"],
  "image-design": ["product photo", "design", "thumbnail", "illustration", "brand", "social graphics", "mockup"],
  "localization-repurposing": ["translate", "localization", "dubbing", "subtitles", "repurpose", "voiceover"],
  "ai-automation": ["automation", "ai agent", "n8n", "zapier", "make.com", "llm", "chatbot", "integration", "workflow"],
  "web-app-builds": ["website", "landing page", "next.js", "react", "web app", "mvp", "webflow", "shopify"],
  "research-content": ["research", "content", "seo", "blog", "market research", "newsletter", "knowledge base"],
};

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export interface BootstrapResult {
  tenantId: string;
  created: boolean;
}

/**
 * Creates a workspace for a new user: tenant, owner membership, default
 * settings, markets and integration rows. Idempotent per user.
 */
export async function bootstrapTenantForUser(
  db: Executor,
  input: { userId: string; name: string; email: string; mode?: "demo" | "live" },
): Promise<BootstrapResult> {
  const existing = await db
    .select({ tenantId: membership.tenantId })
    .from(membership)
    .where(eq(membership.userId, input.userId))
    .limit(1);
  if (existing[0]) return { tenantId: existing[0].tenantId, created: false };

  const base = slugify(input.name || input.email.split("@")[0] || "workspace");
  const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceName = input.name ? `${input.name.split(" ")[0]}'s workspace` : "My workspace";

  const [t] = await db
    .insert(tenant)
    .values({ name: workspaceName, slug, mode: input.mode ?? "demo", settings: defaultTenantSettings() })
    .returning({ id: tenant.id });
  if (!t) throw new Error("tenant insert failed");

  await db.insert(membership).values({ tenantId: t.id, userId: input.userId, role: "owner" });

  await db.insert(market).values(
    SERVICE_FAMILIES.map((f) => ({
      tenantId: t.id,
      key: f.key,
      name: f.name,
      description: f.description,
      enabled: true,
      allocationPct: f.defaultAllocationPct,
      keywords: MARKET_KEYWORDS[f.key] ?? [],
    })),
  );

  const demo = (input.mode ?? "demo") === "demo";
  await db.insert(sourceIntegration).values(
    SOURCE_KEYS.map((key) => ({
      tenantId: t.id,
      sourceKey: key,
      enabled: key === "mock" ? demo : key === "direct",
      status: key === "mock" ? ("mock" as const) : key === "direct" ? ("connected" as const) : ("needs_configuration" as const),
      config: {},
    })),
  );

  await db.insert(providerIntegration).values(
    INTEGRATIONS.filter((i) => i.kind !== "marketplace").map((i) => ({
      tenantId: t.id,
      providerKey: i.key,
      kind: i.kind,
      enabled: true,
      status: "needs_configuration" as const,
      config: {},
    })),
  );

  await audit(db, {
    tenantId: t.id,
    actor: { type: "user", id: input.userId },
    action: "tenant.created",
    subjectType: "tenant",
    subjectId: t.id,
    data: { mode: input.mode ?? "demo" },
  });

  return { tenantId: t.id, created: true };
}

export async function getTenantSettings(db: Executor, tenantId: string): Promise<TenantSettings> {
  const rows = await db.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)).limit(1);
  return resolveTenantSettings(rows[0]?.settings);
}

export async function getMembership(db: Executor, userId: string) {
  const rows = await db
    .select({ tenantId: membership.tenantId, role: membership.role, tenantName: tenant.name, tenantMode: tenant.mode, slug: tenant.slug })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .where(eq(membership.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function assertMember(db: Executor, userId: string, tenantId: string): Promise<void> {
  const rows = await db
    .select({ id: membership.id })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new Error("Forbidden: not a member of this workspace");
}

export async function listTenantIds(db: Executor): Promise<string[]> {
  const rows = await db.select({ id: tenant.id }).from(tenant);
  return rows.map((r) => r.id);
}

/**
 * Tenants with a member session active within `days`. Used to keep
 * demo-marketplace sourcing and market research (local GX inference) from
 * running forever for abandoned/test workspaces.
 */
export async function listActiveTenantIds(db: Executor, days: number, now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await db
    .selectDistinct({ id: membership.tenantId })
    .from(membership)
    .innerJoin(session, eq(session.userId, membership.userId))
    .where(gt(session.updatedAt, since));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Operator workspaces (security review H1)
// ---------------------------------------------------------------------------

/**
 * Exact, lower-cased operator emails from OPERATOR_EMAILS (comma list). Only
 * full addresses count — "@domain" or malformed entries are ignored.
 */
export function parseOperatorEmails(raw: string | undefined = process.env.OPERATOR_EMAILS): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s)),
    ),
  );
}

/** Operator status is cached per tenant for at most this long. */
export const OPERATOR_CACHE_TTL_MS = 60_000;
const operatorCache = new Map<string, { value: boolean; expires: number }>();

/** Drop cached operator decisions (tests; after membership changes). */
export function clearOperatorTenantCache(tenantId?: string): void {
  if (!tenantId) {
    operatorCache.clear();
    return;
  }
  for (const k of operatorCache.keys()) if (k.startsWith(`${tenantId}\u0000`)) operatorCache.delete(k);
}

/**
 * True when any owner/admin member of the tenant has an email listed in
 * OPERATOR_EMAILS. Operator workspaces may use server-wide env credentials
 * and paid budgets; every other workspace must bring its own credentials.
 * Cached ≤ 60 s. Fails closed (false) when OPERATOR_EMAILS is empty.
 */
export async function isOperatorTenant(db: Executor, tenantId: string, now: number = Date.now()): Promise<boolean> {
  const emails = parseOperatorEmails();
  if (emails.length === 0 || !tenantId) return false;
  const key = `${tenantId}\u0000${emails.join(",")}`;
  const hit = operatorCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const rows = await db
    .select({ id: membership.id })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.tenantId, tenantId), inArray(membership.role, ["owner", "admin"]), inArray(sql`lower(${user.email})`, emails)))
    .limit(1);
  const value = rows.length > 0;
  if (operatorCache.size > 5000) operatorCache.clear();
  operatorCache.set(key, { value, expires: now + OPERATOR_CACHE_TTL_MS });
  return value;
}

/** Server-wide real-money cap (PAID_PROVIDER_DAILY_BUDGET_USD). */
export function serverPaidBudgetUsd(): number {
  const n = Number(process.env.PAID_PROVIDER_DAILY_BUDGET_USD ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Operator-controlled ceiling for NON-operator workspaces (TENANT_MAX_DAILY_PAID_USD, default 0). */
export function tenantMaxDailyPaidUsd(): number {
  const n = Number(process.env.TENANT_MAX_DAILY_PAID_USD ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Highest `limits.dailyPaidSpendLimitUsd` a workspace may configure:
 * operator workspaces → PAID_PROVIDER_DAILY_BUDGET_USD; everyone else →
 * min(TENANT_MAX_DAILY_PAID_USD, PAID_PROVIDER_DAILY_BUDGET_USD). Runtime
 * budget checks should clamp the tenant limit with this value too.
 */
export function paidSpendCeilingUsd(operator: boolean): number {
  const server = serverPaidBudgetUsd();
  return operator ? server : Math.min(server, tenantMaxDailyPaidUsd());
}

export async function tenantPaidSpendCeilingUsd(db: Executor, tenantId: string): Promise<number> {
  return paidSpendCeilingUsd(await isOperatorTenant(db, tenantId));
}
