import type { ProviderHealth } from "@gigpilot/contracts";
import { integrationByKey } from "@gigpilot/contracts";
import { getAgentOSAdapter } from "./agentos";
import { HiggsfieldProvider } from "./creative/higgsfield";
import { KieProvider } from "./creative/kie";
import { FactoryProvider } from "./intelligence/factory";
import { GrokProvider } from "./intelligence/grok";
import { GxProvider } from "./intelligence/gx";
import { redactText } from "./lib/http";
import { ContraSource } from "./sources/contra";
import { DirectSource } from "./sources/direct";
import { FiverrSource } from "./sources/fiverr";
import { FreelancerSource } from "./sources/freelancer";
import { UpworkSource } from "./sources/upwork";
import { WebFeedSource } from "./sources/web";

/**
 * Zero-cost connection test for any integration key in INTEGRATIONS.
 * Honours tenant-stored credentials (adapters are bound with `withTenant`).
 * Never spends money, never returns secrets, never throws.
 *
 *   factory    `droid --version` + key presence (no billed call)
 *   gx         GET {GX_BASE_URL}/models (model ids in meta)
 *   grok       GET /v1/api-key (blocked/disabled flags)
 *   kie        GET /api/v1/chat/credit (credit balance in meta)
 *   higgsfield POST /estimate/higgsfield-ai/soul/v2/standard (free estimate)
 *   upwork     token presence; minimal authorized `user { id }` query when a token exists
 *   freelancer GET /users/0.1/self/
 *   contra/fiverr  the workspace's inbound webhook secret presence (no API exists)
 *   web        cached feed state only (feeds have strict request budgets)
 *   direct     always connected
 *   mock       demo/test mode
 *   agentos    status-snapshot adapter mode + last publish time
 */

const HEALTH_TIMEOUT_MS = 20_000;

async function run(key: string, tenantId: string | null): Promise<ProviderHealth> {
  switch (key) {
    case "factory":
      return new FactoryProvider().withTenant(tenantId).health();
    case "gx":
      return new GxProvider().withTenant(tenantId).health();
    case "grok":
      return new GrokProvider().withTenant(tenantId).health();
    case "kie":
      return new KieProvider().withTenant(tenantId).health();
    case "higgsfield":
      return new HiggsfieldProvider().withTenant(tenantId).health();
    case "upwork":
      return new UpworkSource().withTenant(tenantId).health();
    case "freelancer":
      return new FreelancerSource().withTenant(tenantId).health();
    case "contra":
      return new ContraSource().withTenant(tenantId).health();
    case "fiverr":
      return new FiverrSource().withTenant(tenantId).health();
    case "web":
      return new WebFeedSource().health();
    case "direct":
      return new DirectSource().health();
    case "mock":
      return { status: "mock", detail: "Demo marketplace — simulated opportunities run through the real pipeline.", checkedAt: new Date().toISOString() };
    case "agentos":
      return getAgentOSAdapter().health();
    default:
      return { status: "error", detail: `Unknown integration "${key.slice(0, 40)}".`, checkedAt: new Date().toISOString() };
  }
}

export async function checkIntegration(key: string, tenantId: string | null): Promise<ProviderHealth> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  if (!integrationByKey(key)) return { status: "error", detail: `Unknown integration "${key.slice(0, 40)}".`, checkedAt };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ProviderHealth>((resolve) => {
      timer = setTimeout(() => resolve({ status: "unavailable", detail: `Health check timed out after ${HEALTH_TIMEOUT_MS / 1000} s.`, checkedAt, latencyMs: HEALTH_TIMEOUT_MS }), HEALTH_TIMEOUT_MS);
    });
    const health = await Promise.race([run(key, tenantId), timeout]);
    return { ...health, detail: redactText(health.detail), latencyMs: health.latencyMs ?? Date.now() - started };
  } catch (err) {
    return { status: "error", detail: redactText(err instanceof Error ? err.message : "health check failed").slice(0, 300), latencyMs: Date.now() - started, checkedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
