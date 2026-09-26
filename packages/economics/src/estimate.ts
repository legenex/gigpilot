import type { CreativeModelOption, OpportunityAnalysis, TenantSettings } from "@gigpilot/contracts";
import { calculateEconomics, type CoverageItem, type EconomicsResult, type LineItemInput } from "./calculator";
import { CREATIVE_CATALOG, creativeOptionsFor, deliverableUnitsFor, inferenceCostUsd } from "./catalog";

/** Capabilities fulfilled by model calls and therefore priced via inference estimates. */
export const INFERENCE_DELIVERED_CAPABILITIES: ReadonlySet<string> = new Set(["text.copy", "text.translate", "text.research", "code.build", "code.automation", "qa.review"]);
const INFERENCE_DELIVERED = INFERENCE_DELIVERED_CAPABILITIES;

/** True when a capability is delivered by model calls (UI label: "priced via inference"). */
export function isInferenceDelivered(capability: string): boolean {
  return INFERENCE_DELIVERED.has(capability);
}

/** Capabilities rendered by creative providers (image/video) and priced from the creative catalog. */
export function isCreativeCapability(capability: string): boolean {
  return capability.startsWith("image.") || capability.startsWith("video.");
}

export interface RouteChoice {
  option: CreativeModelOption;
  expectedCostPerUsableUsd: number | null;
  predictedQuality: number;
  rationale: string;
}

export interface ObservedMetric {
  provider: string;
  model: string;
  capability: string;
  usableRate: number | null;
  attempts: number;
}

/**
 * Choose the cheapest creative route predicted to clear the quality
 * threshold — NOT simply the cheapest request price. Expected cost per
 * usable asset = unit cost × units ÷ usable rate (observed when we have
 * ≥ 5 attempts of history, prior otherwise). Per-clip routes are priced for
 * the whole deliverable length (ceil(duration / clip length) clips).
 */
export function chooseCreativeRoute(
  capability: OpportunityAnalysis["productionEstimates"][number]["capability"],
  opts: {
    qualityThreshold: number;
    preference: string[];
    availableProviders?: string[];
    metrics?: ObservedMetric[];
    durationSec?: number;
    catalog?: CreativeModelOption[];
  },
): RouteChoice | null {
  const candidates = creativeOptionsFor(capability, opts.catalog ?? CREATIVE_CATALOG).filter(
    (o) => !opts.availableProviders || opts.availableProviders.includes(o.provider),
  );
  if (candidates.length === 0) return null;

  const scored = candidates.map((o) => {
    const m = opts.metrics?.find((x) => x.provider === o.provider && x.model === o.model && x.capability === capability);
    const usable = m && m.attempts >= 5 && m.usableRate !== null ? m.usableRate : o.usableRatePrior;
    const units = deliverableUnitsFor(o, opts.durationSec);
    const perUsable = o.unitCostUsd === null ? null : (o.unitCostUsd * units) / Math.max(0.05, usable);
    const quality = o.qualityPrior;
    return { o, usable, perUsable, quality, observed: Boolean(m && m.attempts >= 5) };
  });

  const clearing = scored.filter((s) => s.quality >= opts.qualityThreshold);
  const pool = clearing.length > 0 ? clearing : scored;
  pool.sort((a, b) => {
    // known prices first, then cheapest per usable asset, then provider preference
    if (a.perUsable === null && b.perUsable !== null) return 1;
    if (b.perUsable === null && a.perUsable !== null) return -1;
    const diff = (a.perUsable ?? 0) - (b.perUsable ?? 0);
    if (Math.abs(diff) > 1e-9) return diff;
    return opts.preference.indexOf(a.o.provider) - opts.preference.indexOf(b.o.provider);
  });
  const best = pool[0]!;
  const rationale =
    clearing.length > 0
      ? `${best.o.provider}/${best.o.model}: cheapest route clearing quality ${opts.qualityThreshold.toFixed(2)} ` +
        `(predicted ${best.quality.toFixed(2)}; ${best.perUsable === null ? "price unknown" : `$${best.perUsable.toFixed(3)}/usable asset`}; ` +
        `usable rate ${(best.usable * 100).toFixed(0)}% ${best.observed ? "observed" : "prior"})`
      : `${best.o.provider}/${best.o.model}: no route clears quality ${opts.qualityThreshold.toFixed(2)}; best available selected`;
  return { option: best.o, expectedCostPerUsableUsd: best.perUsable, predictedQuality: best.quality, rationale };
}

export interface OpportunityPricingInput {
  sourceKey: string;
  budgetType: "fixed" | "hourly" | "unknown";
  budgetMinUsd?: number | null;
  budgetMaxUsd?: number | null;
  proposedPriceUsd?: number | null;
}

export interface EstimateOptions {
  /**
   * Creative providers that can ACTUALLY run for this tenant now (configured AND paid spend
   * allowed). When given, creative lines are priced on these routes; with none available the
   * catalog route is priced as "simulated" (what the mock renderer simulates).
   */
  availableCreativeProviders?: string[];
  metrics?: ObservedMetric[];
  /**
   * Intelligence families the router would ACTUALLY use for this tenant (allowed by settings ∩
   * configured ∩ affordable), e.g. ["gx"]. When given, inference is priced on the family the
   * router would pick (factory unconfigured → gx at $0); with none, on the deterministic mock
   * ($0, "simulated").
   */
  availableIntelligenceFamilies?: string[];
  /**
   * Live workspaces: a required production capability without a connected provider makes the
   * estimate incomplete ("no connected provider for <capability>"), so it is never recommended
   * for pursuit. Demo workspaces keep simulated (mock) routes.
   */
  requireConnectedProviders?: boolean;
}

/** Router preference per requested inference family (mirrors ModelRouter.routeFor). */
const INFERENCE_FALLBACKS: Record<string, string[]> = {
  gx: ["gx", "factory"],
  factory: ["factory", "gx"],
  grok: ["grok", "gx"],
};

function inferenceModel(family: string): string {
  return family === "gx" ? "gx-code" : family === "grok" ? "grok-4.3" : family === "factory" ? "auto" : "mock-deterministic";
}

function durationOf(label: string): number | undefined {
  const m = /(\d{1,4})\s*s\b/.exec(label);
  return m ? Number(m[1]) : undefined;
}

/**
 * Build line items from an analysis (model-estimated quantities) + catalog
 * prices, then run the deterministic calculator with tenant settings. Every
 * line records the route it was priced on; when route availability is passed
 * (analyst), prices reflect what would actually run for the tenant.
 */
export function estimateOpportunity(
  analysis: OpportunityAnalysis,
  opp: OpportunityPricingInput,
  settings: TenantSettings,
  opts: EstimateOptions = {},
): { economics: EconomicsResult; routes: RouteChoice[] } {
  const lineItems: LineItemInput[] = [];
  const routes: RouteChoice[] = [];
  const coverage: CoverageItem[] = [];
  const extraMissing: string[] = [];
  const knowsCreative = opts.availableCreativeProviders !== undefined;
  const knowsInference = opts.availableIntelligenceFamilies !== undefined;
  const liveInference = (opts.availableIntelligenceFamilies ?? []).filter((f) => f !== "mock");
  const noConnected = (capability: string, why: string) => {
    const m = `no connected provider for ${capability}${why ? ` (${why})` : ""}`;
    if (!extraMissing.includes(m)) extraMissing.push(m);
  };

  for (const est of analysis.productionEstimates) {
    const durationSec = durationOf(est.label);
    if (isCreativeCapability(est.capability)) {
      const routeOpts = {
        qualityThreshold: settings.routing.creativeQualityThreshold,
        preference: settings.routing.creativeProviderPreference,
        metrics: opts.metrics,
        durationSec,
      };
      const available = chooseCreativeRoute(est.capability, { ...routeOpts, availableProviders: opts.availableCreativeProviders });
      const ideal = available ?? (knowsCreative ? chooseCreativeRoute(est.capability, routeOpts) : null);
      const route = available ?? ideal;
      if (route) routes.push(route);
      const perDeliverable = route ? deliverableUnitsFor(route.option, durationSec) : 1;
      const simulated = knowsCreative && !available && Boolean(ideal);
      const unavailable = !route || (simulated && opts.requireConnectedProviders === true);
      const routeStatus: LineItemInput["routeStatus"] = !knowsCreative ? undefined : unavailable ? "unavailable" : simulated ? "simulated" : "available";
      const idealName = route ? `${route.option.provider}/${route.option.model}` : null;
      const note = !route
        ? `no catalog route for ${est.capability}`
        : simulated
          ? `${idealName} not connected for this workspace — priced at its catalog rate; rendered by the mock provider (simulated)`
          : undefined;
      lineItems.push({
        category: "creative",
        label: est.label,
        provider: simulated ? "mock" : (route?.option.provider ?? null),
        model: simulated ? `simulates ${idealName}` : (route?.option.model ?? null),
        unit: route?.option.unit ?? "unit",
        unitCostUsd: route?.option.unitCostUsd ?? null,
        quantity: est.units * perDeliverable,
        attempts: est.attemptsPerUnit,
        priceSource: route?.option.priceVerifiedAt ? `catalog ${route.option.priceVerifiedAt}${simulated ? " (simulated route)" : ""}` : "unknown",
        capability: est.capability,
        ...(routeStatus ? { routeStatus } : {}),
        ...(simulated ? { requestedProvider: idealName } : {}),
        ...(note ? { routeNote: note } : {}),
      });
      coverage.push({
        label: est.label,
        capability: est.capability,
        units: est.units,
        pricedVia: route ? "creative" : "unpriced",
        provider: simulated ? "mock" : (route?.option.provider ?? null),
        model: simulated ? `simulates ${idealName}` : (route?.option.model ?? null),
        routeStatus: routeStatus ?? (route ? "available" : "unavailable"),
        ...(note ? { note } : {}),
      });
      if (opts.requireConnectedProviders && (simulated || !route)) noConnected(est.capability, simulated ? `${idealName} is not connected or paid spend is off` : "");
    } else if (INFERENCE_DELIVERED.has(est.capability)) {
      // Delivered by model calls (copy, research, translation, code, review): priced
      // through analysis.inferenceEstimates below, so no separate line item here.
      const none = knowsInference && liveInference.length === 0;
      coverage.push({
        label: est.label,
        capability: est.capability,
        units: est.units,
        pricedVia: "inference",
        provider: knowsInference ? (liveInference[0] ?? "mock") : null,
        model: null,
        routeStatus: !knowsInference ? "available" : none ? (opts.requireConnectedProviders ? "unavailable" : "simulated") : liveInference[0] === "gx" ? "local" : "available",
        note: "priced via inference estimates",
      });
      if (opts.requireConnectedProviders && none) noConnected(est.capability, "no GX / Factory / Grok configured");
    } else if (est.capability === "media.finishing") {
      // Assembly/formatting runs on local tooling (no per-unit provider charge).
      lineItems.push({
        category: "tool",
        label: est.label,
        provider: "local",
        model: null,
        unit: "unit",
        unitCostUsd: 0,
        quantity: est.units,
        attempts: est.attemptsPerUnit,
        priceSource: "local tooling",
        capability: est.capability,
        routeStatus: "local",
      });
      coverage.push({ label: est.label, capability: est.capability, units: est.units, pricedVia: "local", provider: "local", model: null, routeStatus: "local" });
    } else {
      // No priced route exists (e.g. audio voiceover/dubbing/music, 3D): never price it at $0 —
      // keep the line item unpriced so the estimate is flagged incomplete.
      lineItems.push({
        category: "tool",
        label: est.label,
        provider: null,
        model: est.capability,
        unit: "unit",
        unitCostUsd: null,
        quantity: est.units,
        attempts: est.attemptsPerUnit,
        priceSource: "no priced route in catalog",
        capability: est.capability,
        routeStatus: "unavailable",
        routeNote: `no priced provider route for ${est.capability}`,
      });
      coverage.push({ label: est.label, capability: est.capability, units: est.units, pricedVia: "unpriced", provider: null, model: null, routeStatus: "unavailable", note: `no priced provider route for ${est.capability}` });
      if (opts.requireConnectedProviders) noConnected(est.capability, "");
    }
  }

  for (const inf of analysis.inferenceEstimates) {
    let family: string = inf.family;
    let routeStatus: LineItemInput["routeStatus"];
    let note: string | undefined;
    if (knowsInference) {
      const chosen = (INFERENCE_FALLBACKS[inf.family] ?? [inf.family]).find((f) => liveInference.includes(f));
      if (chosen) {
        family = chosen;
        routeStatus = chosen === "gx" ? "local" : "available";
        if (chosen !== inf.family) {
          note = `${inf.family} not available for this workspace → priced on ${chosen}${chosen === "gx" ? " (local, $0)" : ""}${inf.family === "grok" ? "; no live web research (model knowledge only)" : ""}`;
        }
      } else {
        family = "mock";
        routeStatus = opts.requireConnectedProviders ? "unavailable" : "simulated";
        note = `no intelligence provider available (${inf.family} requested) — deterministic mock at $0`;
      }
    }
    const model = inferenceModel(family);
    const perCall = family === "mock" ? 0 : inferenceCostUsd(family, model, inf.kTokensIn * 1000, inf.kTokensOut * 1000);
    lineItems.push({
      category: "inference",
      label: inf.task,
      provider: family,
      model,
      unit: "call",
      unitCostUsd: perCall,
      quantity: inf.calls,
      attempts: 1,
      priceSource: family === "mock" ? "simulated (deterministic mock, $0)" : perCall === null ? "unknown" : "inference catalog",
      ...(routeStatus ? { routeStatus } : {}),
      ...(family !== inf.family ? { requestedProvider: inf.family } : {}),
      ...(note ? { routeNote: note } : {}),
    });
  }

  const fee = settings.economics.platformFees[opp.sourceKey] ?? null;

  const economics = calculateEconomics({
    price: {
      budgetType: opp.budgetType,
      budgetMinUsd: opp.budgetMinUsd,
      budgetMaxUsd: opp.budgetMaxUsd,
      proposedPriceUsd: opp.proposedPriceUsd,
      billableHours: analysis.billableHours,
      hourlyRateUsd: settings.economics.defaultHourlyRateUsd,
    },
    lineItems,
    platformFee: fee ? { key: opp.sourceKey, pct: fee.pct, fixedUsd: fee.fixedUsd, minUsd: fee.minUsd } : null,
    revision: { expectedRounds: settings.economics.expectedRevisionRounds, costFraction: settings.economics.revisionCostFraction },
    contingencyPct: settings.economics.contingencyPct,
    shadow: { hours: analysis.humanHours, hourlyRateUsd: settings.economics.shadowHourlyRateUsd },
    extraMissing,
  });

  return { economics: { ...economics, coverage }, routes };
}
