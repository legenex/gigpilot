import type { CreativeModelOption, OpportunityAnalysis, TenantSettings } from "@gigpilot/contracts";
import { calculateEconomics, type EconomicsResult, type LineItemInput } from "./calculator";
import { CREATIVE_CATALOG, creativeOptionsFor, inferenceCostUsd, unitsFor } from "./catalog";

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
 * ≥ 5 attempts of history, prior otherwise).
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
    const units = unitsFor(o, opts.durationSec);
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

/**
 * Build line items from an analysis (model-estimated quantities) + catalog
 * prices, then run the deterministic calculator with tenant settings.
 */
export function estimateOpportunity(
  analysis: OpportunityAnalysis,
  opp: OpportunityPricingInput,
  settings: TenantSettings,
  opts: { availableCreativeProviders?: string[]; metrics?: ObservedMetric[] } = {},
): { economics: EconomicsResult; routes: RouteChoice[] } {
  const lineItems: LineItemInput[] = [];
  const routes: RouteChoice[] = [];

  for (const est of analysis.productionEstimates) {
    const isCreative = est.capability.startsWith("image.") || est.capability.startsWith("video.");
    if (isCreative) {
      const durationSec = /(\d+)\s*s\b/.exec(est.label)?.[1];
      const route = chooseCreativeRoute(est.capability, {
        qualityThreshold: settings.routing.creativeQualityThreshold,
        preference: settings.routing.creativeProviderPreference,
        availableProviders: opts.availableCreativeProviders,
        metrics: opts.metrics,
        durationSec: durationSec ? Number(durationSec) : undefined,
      });
      if (route) routes.push(route);
      const units = route ? unitsFor(route.option, durationSec ? Number(durationSec) : undefined) : 1;
      lineItems.push({
        category: "creative",
        label: est.label,
        provider: route?.option.provider ?? null,
        model: route?.option.model ?? null,
        unit: route?.option.unit ?? "unit",
        unitCostUsd: route?.option.unitCostUsd ?? null,
        quantity: est.units * units,
        attempts: est.attemptsPerUnit,
        priceSource: route?.option.priceVerifiedAt ? `catalog ${route.option.priceVerifiedAt}` : "unknown",
      });
    } else {
      // Non-creative production (code, copy, research…) is priced as inference below.
    }
  }

  for (const inf of analysis.inferenceEstimates) {
    const model = inf.family === "gx" ? "gx-code" : inf.family === "grok" ? "grok-4.3" : "auto";
    const perCall = inferenceCostUsd(inf.family, model, inf.kTokensIn * 1000, inf.kTokensOut * 1000);
    lineItems.push({
      category: "inference",
      label: inf.task,
      provider: inf.family,
      model,
      unit: "call",
      unitCostUsd: perCall,
      quantity: inf.calls,
      attempts: 1,
      priceSource: perCall === null ? "unknown" : "inference catalog",
    });
  }

  const fee = settings.economics.platformFees[opp.sourceKey] ?? settings.economics.platformFees["direct"] ?? { pct: 0, fixedUsd: 0, minUsd: 0 };

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
    platformFee: { key: opp.sourceKey, pct: fee.pct, fixedUsd: fee.fixedUsd, minUsd: fee.minUsd },
    revision: { expectedRounds: settings.economics.expectedRevisionRounds, costFraction: settings.economics.revisionCostFraction },
    contingencyPct: settings.economics.contingencyPct,
    shadow: { hours: analysis.humanHours, hourlyRateUsd: settings.economics.shadowHourlyRateUsd },
  });

  return { economics, routes };
}
