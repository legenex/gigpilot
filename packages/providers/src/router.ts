import type {
  IntelligenceFamily,
  IntelligenceProvider,
  IntelligenceRequest,
  IntelligenceResult,
  IntelligenceTask,
} from "@gigpilot/contracts";
import { FactoryProvider } from "./intelligence/factory";
import { GrokProvider } from "./intelligence/grok";
import { GxProvider } from "./intelligence/gx";
import { MockIntelligenceProvider } from "./intelligence/mock";
import type { FallbackRecord, IntelligenceRouter, ProviderCallContext, RoutedIntelligenceResult } from "./types";

/**
 * ModelRouter. Chooses an intelligence provider per task class, enforcing
 * tenant model-family policy and paid-spend guardrails, and falls through to
 * the next provider on any failure. The deterministic mock is the terminal
 * fallback, so an unconfigured deployment still runs end to end ($0).
 */

export const CHEAP_TASKS: readonly IntelligenceTask[] = [
  "triage",
  "extract",
  "classify",
  "summarise",
  "dedupe",
  "tag",
  "qa_basic",
  "log_analysis",
  "analyse_opportunity",
];
export const RESEARCH_TASKS: readonly IntelligenceTask[] = ["web_research", "market_research"];
export const REASONING_TASKS: readonly IntelligenceTask[] = ["proposal", "plan_production", "recovery", "code", "qa_high", "client_message"];

export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly fallbacks: FallbackRecord[],
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

function errorReason(err: unknown): string {
  const raw = err instanceof Error ? `${err.name === "Error" ? "" : `${err.name}: `}${err.message}` : String(err);
  // Never leak credentials that a vendor error might echo back.
  return raw
    .replace(/(Bearer|Key)\s+[A-Za-z0-9._:-]+/gi, "$1 [redacted]")
    .replace(/\b(sk|fk|xai|gx)-[A-Za-z0-9_-]{6,}/gi, "[redacted]")
    .slice(0, 240);
}

type TenantAware = { isConfiguredFor?: (tenantId: string | null) => Promise<boolean> };

/**
 * Tenant-aware configuration check: adapters that accept tenant-stored
 * credentials expose `isConfiguredFor(tenantId)`; otherwise fall back to the
 * env-level `isConfigured()`.
 */
export async function isConfiguredForTenant(p: { isConfigured(): boolean }, tenantId: string | null | undefined): Promise<boolean> {
  const fn = (p as TenantAware).isConfiguredFor;
  if (typeof fn === "function") {
    try {
      return await fn.call(p, tenantId ?? null);
    } catch {
      return p.isConfigured();
    }
  }
  return p.isConfigured();
}

function formatUsd(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export class ModelRouter implements IntelligenceRouter {
  private readonly byFamily: Map<IntelligenceFamily, IntelligenceProvider>;

  constructor(private readonly list: IntelligenceProvider[]) {
    this.byFamily = new Map(list.map((p) => [p.family, p]));
    if (!this.byFamily.has("mock")) {
      const mock = new MockIntelligenceProvider();
      this.list = [...list, mock];
      this.byFamily.set("mock", mock);
    }
  }

  providers(): IntelligenceProvider[] {
    return [...this.list];
  }

  routeFor(task: IntelligenceTask, ctx: ProviderCallContext): IntelligenceFamily[] {
    if (RESEARCH_TASKS.includes(task)) return ["grok", "gx", "mock"];
    if (REASONING_TASKS.includes(task)) return ["factory", "gx", "mock"];
    // Cheap / repetitive work (and anything unclassified) prefers local GX compute.
    return ctx.preferLocalForCheapTasks === false ? ["factory", "gx", "mock"] : ["gx", "factory", "mock"];
  }

  /** Why a provider must be skipped for this request, or null when it is eligible. */
  private async skipReason(p: IntelligenceProvider, req: IntelligenceRequest, ctx: ProviderCallContext): Promise<string | null> {
    if (p.family === "mock") return null;
    if (ctx.allowedFamilies && !ctx.allowedFamilies.includes(p.family)) return "family not allowed by tenant routing policy";
    if (!(await isConfiguredForTenant(p, ctx.tenantId))) return "not configured";
    if (!p.supports(req.task)) return `does not support ${req.task}`;
    if (p.paid) {
      if (!ctx.budget.allowPaid) return "paid spend disabled (daily paid budget is $0)";
      const estimate = p.estimateCost(req);
      if (!Number.isFinite(estimate)) return "cost estimate unavailable";
      if (estimate > ctx.budget.remainingPaidUsd) {
        return `estimated ${formatUsd(estimate)} exceeds remaining paid budget ${formatUsd(Math.max(0, ctx.budget.remainingPaidUsd))}`;
      }
      if (req.maxCostUsd !== undefined && estimate > req.maxCostUsd) {
        return `estimated ${formatUsd(estimate)} exceeds this call's ${formatUsd(req.maxCostUsd)} ceiling`;
      }
    }
    return null;
  }

  async complete<T>(req: IntelligenceRequest<T>, ctx: ProviderCallContext): Promise<RoutedIntelligenceResult<T>> {
    const fallbacks: FallbackRecord[] = [];
    const order = this.routeFor(req.task, ctx);
    // Adapters resolve tenant-stored credentials from the request context.
    const request: IntelligenceRequest<T> = { ...req, context: { ...req.context, tenantId: req.context?.tenantId ?? ctx.tenantId ?? undefined } };

    for (const family of order) {
      const provider = this.byFamily.get(family);
      if (!provider) {
        fallbacks.push({ family, reason: "provider not registered" });
        continue;
      }
      const skip = await this.skipReason(provider, request, ctx);
      if (skip) {
        fallbacks.push({ family, reason: skip });
        continue;
      }
      try {
        const res = await provider.complete(request);
        const data = this.validate(request, res);
        return { ...res, data, fallbacks, paid: provider.paid };
      } catch (err) {
        if (family === "mock") {
          throw new RoutingError(`All intelligence providers failed for ${req.task}: ${errorReason(err)}`, [
            ...fallbacks,
            { family, reason: `failed: ${errorReason(err)}` },
          ]);
        }
        fallbacks.push({ family, reason: `failed: ${errorReason(err)}` });
      }
    }
    throw new RoutingError(`No intelligence provider available for ${req.task}`, fallbacks);
  }

  /** Defence in depth: validate structured output even if the provider already did. */
  private validate<T>(req: IntelligenceRequest<T>, res: IntelligenceResult<T>): T | undefined {
    if (!req.schema) return res.data;
    let candidate: unknown = res.data;
    if (candidate === undefined && res.text) {
      try {
        candidate = JSON.parse(res.text);
      } catch {
        throw new Error("malformed JSON output");
      }
    }
    const parsed = req.schema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(`output failed ${req.schemaName ?? "schema"} validation (${issues})`);
    }
    return parsed.data;
  }
}

let singleton: ModelRouter | undefined;

export function createIntelligenceRouter(providers?: IntelligenceProvider[]): ModelRouter {
  return new ModelRouter(providers ?? [new GxProvider(), new FactoryProvider(), new GrokProvider(), new MockIntelligenceProvider()]);
}

export function getIntelligenceRouter(): IntelligenceRouter {
  if (!singleton) singleton = createIntelligenceRouter();
  return singleton;
}
