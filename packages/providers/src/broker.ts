import type { Capability, CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest } from "@gigpilot/contracts";
import { chooseCreativeRoute, unitsFor } from "@gigpilot/economics";
import { HiggsfieldProvider } from "./creative/higgsfield";
import { KieProvider } from "./creative/kie";
import { MOCK_MODELS, MockCreativeProvider } from "./creative/mock";
import { isConfiguredForTenant } from "./router";
import type { CreativeBroker, CreativeGenerateOptions, CreativeRouteDecision } from "./types";

/**
 * CreativeProviderBroker. Picks the cheapest creative route predicted to
 * clear the tenant's quality threshold (via @gigpilot/economics
 * `chooseCreativeRoute`) among providers that are configured AND affordable
 * under the current spend authority. When nothing qualifies it renders with
 * the deterministic mock provider but keeps the rationale of the route that
 * WOULD have been chosen, so the owner can see exactly what real spend buys.
 */

export interface BrokerPlanOptions extends CreativeGenerateOptions {
  /** Per-generation hard ceiling (from the request). */
  maxCostUsd?: number;
  /** Video duration used to convert per-second prices into a per-deliverable cost. */
  durationSec?: number;
  /**
   * Provider keys configured for this tenant (tenant-stored or env credentials),
   * resolved asynchronously via `configuredProviders()`. When omitted, the
   * env-level `isConfigured()` is used.
   */
  configuredProviders?: string[];
}

const PROVIDER_NAMES: Record<string, string> = { kie: "Kie", higgsfield: "Higgsfield", mock: "Mock" };

function providerName(key: string): string {
  return PROVIDER_NAMES[key] ?? key;
}

function usd(n: number): string {
  return `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
}

export function expectedRequestCost(option: CreativeModelOption, durationSec?: number): number | null {
  if (option.unitCostUsd === null) return null;
  return option.unitCostUsd * unitsFor(option, durationSec);
}

export class CreativeProviderBroker implements CreativeBroker {
  constructor(
    private readonly live: CreativeProvider[],
    private readonly mock: MockCreativeProvider = new MockCreativeProvider(),
  ) {}

  providers(): CreativeProvider[] {
    return [...this.live, this.mock];
  }

  /** Keys of live providers usable for this tenant (tenant secrets → env). */
  async configuredProviders(tenantId: string | null | undefined): Promise<string[]> {
    const flags = await Promise.all(this.live.map(async (p) => ((await isConfiguredForTenant(p, tenantId)) ? p.key : null)));
    return flags.filter((k): k is string => k !== null);
  }

  private isConfigured(p: CreativeProvider, opts: BrokerPlanOptions): boolean {
    return opts.configuredProviders ? opts.configuredProviders.includes(p.key) : p.isConfigured();
  }

  private candidates(capability: Capability, opts: BrokerPlanOptions) {
    const excluded = (m: CreativeModelOption) => opts.exclude?.some((e) => e.provider === m.provider && e.model === m.model) ?? false;
    const all = this.live.flatMap((p) =>
      p
        .models()
        .filter((m) => m.capability === capability && m.provider === p.key)
        .map((m) => ({ provider: p, option: m, excluded: excluded(m) })),
    );
    return all;
  }

  private affordable(provider: CreativeProvider, option: CreativeModelOption, opts: BrokerPlanOptions): boolean {
    if (!provider.paid) return true;
    if (!opts.budget.allowPaid) return false;
    const expected = expectedRequestCost(option, opts.durationSec);
    if (expected === null) return false; // never spend against an unknown price
    if (expected > opts.budget.remainingPaidUsd) return false;
    if (opts.maxCostUsd !== undefined && expected > opts.maxCostUsd) return false;
    return true;
  }

  plan(capability: Capability, opts: BrokerPlanOptions): CreativeRouteDecision {
    const all = this.candidates(capability, opts);
    const usable = all.filter((c) => !c.excluded);
    const eligible = usable.filter((c) => this.isConfigured(c.provider, opts) && this.affordable(c.provider, c.option, opts));

    const routeOpts = {
      qualityThreshold: opts.qualityThreshold,
      preference: opts.preference,
      metrics: opts.metrics,
      durationSec: opts.durationSec,
    };

    if (eligible.length > 0) {
      const choice = chooseCreativeRoute(capability, { ...routeOpts, catalog: eligible.map((c) => c.option) });
      if (choice) {
        return {
          option: choice.option,
          rationale: choice.rationale,
          expectedCostPerUsableUsd: choice.expectedCostPerUsableUsd,
          predictedQuality: choice.predictedQuality,
          mode: "live",
        };
      }
    }

    // Mock mode — explain which route would have been used and why it was not.
    const ideal = usable.length > 0 ? chooseCreativeRoute(capability, { ...routeOpts, catalog: usable.map((c) => c.option) }) : null;
    const why = this.mockReason(capability, all, usable, opts, ideal?.option);
    const base = MOCK_MODELS.find((m) => m.capability === capability) ?? MOCK_MODELS[0]!;
    const option: CreativeModelOption = {
      ...base,
      capability,
      unitCostUsd: ideal ? ideal.option.unitCostUsd : 0,
      unit: ideal ? ideal.option.unit : base.unit,
      notes: ideal ? `simulates ${ideal.option.provider}/${ideal.option.model}` : "simulates no catalog route",
      priceVerifiedAt: ideal?.option.priceVerifiedAt,
    };
    const rationale = ideal
      ? `${providerName(ideal.option.provider)} ${ideal.option.model} would be selected (${
          ideal.expectedCostPerUsableUsd === null ? "price unknown" : `${usd(ideal.expectedCostPerUsableUsd)}/usable`
        }); running in mock mode because ${why}`
      : `No catalog route available for ${capability}; running in mock mode because ${why}`;
    return {
      option,
      rationale,
      expectedCostPerUsableUsd: ideal?.expectedCostPerUsableUsd ?? null,
      predictedQuality: base.qualityPrior,
      mode: "mock",
    };
  }

  private mockReason(
    capability: Capability,
    all: { provider: CreativeProvider; option: CreativeModelOption; excluded: boolean }[],
    usable: { provider: CreativeProvider; option: CreativeModelOption }[],
    opts: BrokerPlanOptions,
    idealOption?: CreativeModelOption,
  ): string {
    if (all.length === 0) return `no provider offers ${capability}`;
    if (usable.length === 0) return "every route was excluded after earlier failures";
    const configured = usable.filter((c) => this.isConfigured(c.provider, opts));
    if (configured.length === 0) {
      const names = [...new Set(usable.map((c) => providerName(c.provider.key)))];
      return `no creative provider is configured (${names.join(", ")} need API keys)`;
    }
    if (configured.some((c) => c.provider.paid) && !opts.budget.allowPaid) return "paid spend is disabled";
    const ref = idealOption && configured.some((c) => c.option === idealOption) ? idealOption : configured[0]!.option;
    const expected = expectedRequestCost(ref, opts.durationSec);
    if (expected === null) return `the price for ${ref.provider}/${ref.model} is unknown, so it cannot be authorised`;
    if (opts.maxCostUsd !== undefined && expected > opts.maxCostUsd) {
      return `its expected ${usd(expected)} exceeds this generation's ${usd(opts.maxCostUsd)} cap`;
    }
    if (expected > opts.budget.remainingPaidUsd) {
      return `its expected ${usd(expected)} exceeds the remaining paid budget (${usd(Math.max(0, opts.budget.remainingPaidUsd))})`;
    }
    return "no configured route is affordable";
  }

  async generate(req: CreativeRequest, opts: CreativeGenerateOptions): Promise<CreativeOutput & { decision: CreativeRouteDecision }> {
    const tenantId = req.context?.tenantId ?? opts.tenantId ?? undefined;
    const configuredProviders = (opts as BrokerPlanOptions).configuredProviders ?? (await this.configuredProviders(tenantId));
    const decision = this.plan(req.capability, { ...opts, maxCostUsd: req.maxCostUsd, durationSec: req.durationSec, configuredProviders });
    // Adapters resolve tenant-stored credentials from the request context.
    req = { ...req, context: { ...req.context, tenantId } };
    if (decision.mode === "mock") {
      const out = await this.mock.render(req, decision.option, opts.simulateDefect);
      return { ...out, decision };
    }
    const provider = this.live.find((p) => p.key === decision.option.provider);
    if (!provider) throw new Error(`Creative provider ${decision.option.provider} is not registered`);
    const expected = expectedRequestCost(decision.option, req.durationSec);
    if (provider.paid && (expected === null || expected > req.maxCostUsd)) {
      throw new Error(`Refusing ${provider.key}/${decision.option.model}: expected cost exceeds the $${req.maxCostUsd.toFixed(2)} cap`);
    }
    const out = await provider.generate(req, decision.option);
    return { ...out, decision };
  }
}

let singleton: CreativeProviderBroker | undefined;

export function createCreativeBroker(providers?: CreativeProvider[], mock?: MockCreativeProvider): CreativeProviderBroker {
  return new CreativeProviderBroker(providers ?? [new KieProvider(), new HiggsfieldProvider()], mock ?? new MockCreativeProvider());
}

export function getCreativeBroker(): CreativeBroker {
  if (!singleton) singleton = createCreativeBroker();
  return singleton;
}
