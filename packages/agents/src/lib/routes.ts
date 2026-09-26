import type { TenantSettings } from "@gigpilot/contracts";
import { eq, getDb, tenant } from "@gigpilot/db";
import { brokerOf, routerOf, type AgentDeps } from "../deps";
import { computeBudget } from "../runtime";
import { configuredCreativeProviders, isConfiguredFor } from "./adapters";

/**
 * What can ACTUALLY run for a tenant right now — used to price estimates on
 * the routes production will really take (H4) and to flag live-workspace
 * estimates that have no connected provider (H5).
 */
export interface RouteAvailability {
  /** Workspace mode: live workspaces must never rely on mock routes. */
  live: boolean;
  /** Paid providers may be called (env + tenant daily budget > 0). */
  allowPaid: boolean;
  /** Non-mock intelligence families: allowed by settings ∩ configured ∩ affordable. */
  intelligenceFamilies: string[];
  /** Creative providers that would run: configured AND affordable (all live creative providers are paid). */
  creativeProviders: string[];
  /** Creative providers configured for the tenant (regardless of paid spend). */
  configuredCreativeProviders: string[];
  /** A web-search family (Grok) is usable. */
  webSearch: boolean;
}

export async function routeAvailability(deps: AgentDeps, tenantId: string, settings: TenantSettings): Promise<RouteAvailability> {
  const db = getDb();
  const [t] = await db.select({ mode: tenant.mode }).from(tenant).where(eq(tenant.id, tenantId)).limit(1);
  const budget = await computeBudget(db, tenantId, settings);
  const allowed = settings.routing.allowedModelFamilies;
  const families: string[] = [];
  for (const p of routerOf(deps).providers()) {
    if (p.family === "mock" || families.includes(p.family) || !allowed.includes(p.family)) continue;
    if (p.paid && !budget.allowPaid) continue;
    if (await isConfiguredFor(p, tenantId)) families.push(p.family);
  }
  const broker = brokerOf(deps);
  const configured = (await configuredCreativeProviders(broker, tenantId)) ?? broker.providers().filter((p) => p.key !== "mock" && p.isConfigured()).map((p) => p.key);
  const usable = configured.filter((key) => {
    const p = broker.providers().find((x) => x.key === key);
    return Boolean(p) && (!p!.paid || budget.allowPaid);
  });
  return {
    live: t?.mode === "live",
    allowPaid: budget.allowPaid,
    intelligenceFamilies: families,
    creativeProviders: usable,
    configuredCreativeProviders: configured,
    webSearch: families.includes("grok"),
  };
}
