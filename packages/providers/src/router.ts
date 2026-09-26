import { OPERATIONAL_DEFAULTS } from "@gigpilot/config";
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
import { ProviderError } from "./lib/errors";
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

/** Codes that say nothing about provider availability (bad input, policy, output quality). */
const NON_AVAILABILITY_CODES = new Set(["validation", "structured_output", "budget_exceeded", "not_configured", "unsupported", "compliance", "auth", "forbidden", "insufficient_credits", "not_found"]);

/** Whether a failure indicates the provider family is browning out (timeouts, 5xx, network). */
export function isAvailabilityFailure(err: unknown): boolean {
  if (err instanceof ProviderError) return !NON_AVAILABILITY_CODES.has(err.code);
  if (err instanceof Error && /validation|malformed JSON/i.test(err.message)) return false;
  return true;
}

export interface CircuitBreakerOptions {
  /** Consecutive availability failures that open the circuit. */
  failureThreshold?: number;
  /** How long an open circuit skips the family before one half-open probe. */
  cooldownMs?: number;
  now?: () => number;
}

interface CircuitState {
  failures: number;
  openedAt: number | null;
  probeInFlight: boolean;
}

/**
 * Per-family circuit breaker. closed → (N consecutive availability failures)
 * → open (skip for cooldown) → half-open (exactly one probe call) → closed on
 * success / open again on failure. Stops a GX brown-out from making every
 * call wait for its full timeout before falling through.
 */
export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = Math.max(1, opts.failureThreshold ?? OPERATIONAL_DEFAULTS.circuitBreakerFailures);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? OPERATIONAL_DEFAULTS.circuitBreakerCooldownSeconds * 1000);
    this.now = opts.now ?? Date.now;
  }

  private state(family: string): CircuitState {
    let s = this.states.get(family);
    if (!s) {
      s = { failures: 0, openedAt: null, probeInFlight: false };
      this.states.set(family, s);
    }
    return s;
  }

  /** null when a call may proceed (claims the half-open probe slot), else the skip reason. */
  admit(family: string): string | null {
    const s = this.state(family);
    if (s.openedAt === null) return null;
    const waited = this.now() - s.openedAt;
    if (waited < this.cooldownMs) {
      return `circuit open after ${s.failures} consecutive failures (retry in ${Math.ceil((this.cooldownMs - waited) / 1000)}s)`;
    }
    if (s.probeInFlight) return "circuit half-open (probe in flight)";
    s.probeInFlight = true;
    return null;
  }

  success(family: string): void {
    const s = this.state(family);
    s.failures = 0;
    s.openedAt = null;
    s.probeInFlight = false;
  }

  failure(family: string): void {
    const s = this.state(family);
    s.failures++;
    if (s.probeInFlight || s.failures >= this.threshold) s.openedAt = this.now();
    s.probeInFlight = false;
  }

  /** A call that neither proved nor disproved availability (e.g. caller abort). */
  neutral(family: string): void {
    this.state(family).probeInFlight = false;
  }

  status(family: string): "closed" | "open" | "half-open" {
    const s = this.states.get(family);
    if (!s || s.openedAt === null) return "closed";
    return this.now() - s.openedAt < this.cooldownMs ? "open" : "half-open";
  }

  reset(): void {
    this.states.clear();
  }
}

function formatUsd(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export class ModelRouter implements IntelligenceRouter {
  private readonly byFamily: Map<IntelligenceFamily, IntelligenceProvider>;
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly list: IntelligenceProvider[],
    opts: { breaker?: CircuitBreaker | CircuitBreakerOptions } = {},
  ) {
    this.breaker = opts.breaker instanceof CircuitBreaker ? opts.breaker : new CircuitBreaker(opts.breaker);
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
      if (req.signal?.aborted) throw new RoutingError(`${req.task} aborted`, [...fallbacks, { family, reason: "aborted by caller" }]);
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
      const circuit = family === "mock" ? null : this.breaker.admit(family);
      if (circuit) {
        fallbacks.push({ family, reason: circuit });
        continue;
      }
      let res: IntelligenceResult<T>;
      try {
        res = await provider.complete(request);
      } catch (err) {
        if (family !== "mock") {
          if (req.signal?.aborted) this.breaker.neutral(family);
          else if (isAvailabilityFailure(err)) this.breaker.failure(family);
          else this.breaker.success(family); // it answered — the request itself was the problem
        }
        if (req.signal?.aborted) throw new RoutingError(`${req.task} aborted`, [...fallbacks, { family, reason: `aborted: ${errorReason(err)}` }]);
        if (family === "mock") {
          throw new RoutingError(`All intelligence providers failed for ${req.task}: ${errorReason(err)}`, [
            ...fallbacks,
            { family, reason: `failed: ${errorReason(err)}` },
          ]);
        }
        fallbacks.push({ family, reason: `failed: ${errorReason(err)}` });
        continue;
      }
      if (family !== "mock") this.breaker.success(family);
      try {
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

export function createIntelligenceRouter(providers?: IntelligenceProvider[], opts: { breaker?: CircuitBreaker | CircuitBreakerOptions } = {}): ModelRouter {
  return new ModelRouter(providers ?? [new GxProvider(), new FactoryProvider(), new GrokProvider(), new MockIntelligenceProvider()], opts);
}

export function getIntelligenceRouter(): IntelligenceRouter {
  if (!singleton) singleton = createIntelligenceRouter();
  return singleton;
}
