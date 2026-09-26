/**
 * Deterministic opportunity economics. LLMs may estimate quantities and
 * attempt counts; every dollar figure here is computed from explicit inputs
 * and the price catalog. Missing prices never get invented — the estimate is
 * flagged incomplete and the missing inputs are listed.
 */

export interface PriceInput {
  budgetType: "fixed" | "hourly" | "unknown";
  budgetMinUsd?: number | null;
  budgetMaxUsd?: number | null;
  /** Explicit price (e.g. from an approved proposal) overrides the budget. */
  proposedPriceUsd?: number | null;
  /** Hours used to value hourly work. */
  billableHours?: number | null;
  /** Our target hourly rate. */
  hourlyRateUsd: number;
}

export interface LineItemInput {
  category: "creative" | "inference" | "tool" | "subcontractor";
  label: string;
  provider: string | null;
  model: string | null;
  unit: string;
  /** null = price unknown → estimate incomplete. */
  unitCostUsd: number | null;
  quantity: number;
  attempts: number;
  priceSource: string;
}

export interface FeeSchedule {
  key: string;
  pct: number;
  fixedUsd: number;
  minUsd: number;
}

export interface EconomicsInput {
  price: PriceInput;
  lineItems: LineItemInput[];
  /** null = no fee schedule known for this source → estimate incomplete. */
  platformFee: FeeSchedule | null;
  revision: { expectedRounds: number; costFraction: number };
  contingencyPct: number;
  shadow: { hours: number; hourlyRateUsd: number };
}

export interface LineItemResult extends LineItemInput {
  totalUsd: number | null;
}

export interface EconomicsResult {
  priceUsd: number;
  priceBasis: "fixed_budget" | "hourly_estimate" | "proposal" | "unknown";
  lineItems: LineItemResult[];
  fulfilmentCostUsd: number;
  revisionContingencyUsd: number;
  contingencyUsd: number;
  shadowCostUsd: number;
  platformFeesUsd: number;
  platformFeeKey: string;
  totalCostUsd: number;
  grossProfitUsd: number;
  grossMargin: number;
  breakEvenPriceUsd: number;
  complete: boolean;
  missing: string[];
}

/** Round to cents for presentation-stable values (internal math stays full precision). */
export function cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function resolvePrice(p: PriceInput): { priceUsd: number; basis: EconomicsResult["priceBasis"]; missing: string[] } {
  if (finite(p.proposedPriceUsd) && p.proposedPriceUsd > 0) {
    return { priceUsd: p.proposedPriceUsd, basis: "proposal", missing: [] };
  }
  const min = finite(p.budgetMinUsd) && p.budgetMinUsd > 0 ? p.budgetMinUsd : null;
  const max = finite(p.budgetMaxUsd) && p.budgetMaxUsd > 0 ? p.budgetMaxUsd : null;

  if (p.budgetType === "fixed") {
    if (min !== null && max !== null) return { priceUsd: (min + max) / 2, basis: "fixed_budget", missing: [] };
    const single = max ?? min;
    if (single !== null) return { priceUsd: single, basis: "fixed_budget", missing: [] };
    return { priceUsd: 0, basis: "unknown", missing: ["client budget"] };
  }

  if (p.budgetType === "hourly") {
    let rate = p.hourlyRateUsd;
    if (max !== null && rate > max) rate = max;
    if (min !== null && rate < min) rate = min;
    if (!finite(p.billableHours) || p.billableHours <= 0) {
      return { priceUsd: 0, basis: "unknown", missing: ["billable hours estimate"] };
    }
    return { priceUsd: rate * p.billableHours, basis: "hourly_estimate", missing: [] };
  }

  return { priceUsd: 0, basis: "unknown", missing: ["client budget"] };
}

/** Marketplace fee for a given price: max(price × pct + fixed, minimum). Zero for zero price. */
export function platformFee(priceUsd: number, fee: FeeSchedule): number {
  if (priceUsd <= 0) return 0;
  return Math.max(priceUsd * fee.pct + fee.fixedUsd, fee.minUsd);
}

/**
 * Price at which gross profit is exactly zero, given non-fee costs C:
 *   P − max(P·pct + fixed, min) − C = 0
 */
export function breakEvenPrice(nonFeeCostsUsd: number, fee: FeeSchedule): number {
  if (fee.pct >= 1) return Number.POSITIVE_INFINITY;
  const proportional = (nonFeeCostsUsd + fee.fixedUsd) / (1 - fee.pct);
  if (proportional * fee.pct + fee.fixedUsd >= fee.minUsd) return proportional;
  return nonFeeCostsUsd + fee.minUsd;
}

export function calculateEconomics(input: EconomicsInput): EconomicsResult {
  const missing: string[] = [];
  const price = resolvePrice(input.price);
  missing.push(...price.missing);

  const lineItems: LineItemResult[] = input.lineItems.map((li) => {
    const attempts = Math.max(1, li.attempts);
    const quantity = Math.max(0, li.quantity);
    if (li.unitCostUsd === null || !finite(li.unitCostUsd)) {
      missing.push(`price for ${li.provider ?? "unassigned provider"}${li.model ? `/${li.model}` : ""} (${li.label})`);
      return { ...li, attempts, quantity, totalUsd: null };
    }
    return { ...li, attempts, quantity, totalUsd: li.unitCostUsd * quantity * attempts };
  });

  const fulfilmentCostUsd = lineItems.reduce((acc, li) => acc + (li.totalUsd ?? 0), 0);
  const revisionContingencyUsd =
    fulfilmentCostUsd * Math.max(0, input.revision.expectedRounds) * Math.max(0, input.revision.costFraction);
  const contingencyUsd = (fulfilmentCostUsd + revisionContingencyUsd) * Math.max(0, input.contingencyPct);
  const shadowCostUsd = Math.max(0, input.shadow.hours) * Math.max(0, input.shadow.hourlyRateUsd);
  if (!input.platformFee) missing.push("platform fee schedule for this source");
  const fee: FeeSchedule = input.platformFee ?? { key: "unknown", pct: 0, fixedUsd: 0, minUsd: 0 };
  const platformFeesUsd = platformFee(price.priceUsd, fee);

  const nonFee = fulfilmentCostUsd + revisionContingencyUsd + contingencyUsd + shadowCostUsd;
  const totalCostUsd = nonFee + platformFeesUsd;
  const grossProfitUsd = price.priceUsd - totalCostUsd;
  const grossMargin = price.priceUsd > 0 ? grossProfitUsd / price.priceUsd : 0;

  return {
    priceUsd: cents(price.priceUsd),
    priceBasis: price.basis,
    lineItems: lineItems.map((li) => ({ ...li, totalUsd: li.totalUsd === null ? null : cents(li.totalUsd) })),
    fulfilmentCostUsd: cents(fulfilmentCostUsd),
    revisionContingencyUsd: cents(revisionContingencyUsd),
    contingencyUsd: cents(contingencyUsd),
    shadowCostUsd: cents(shadowCostUsd),
    platformFeesUsd: cents(platformFeesUsd),
    platformFeeKey: fee.key,
    totalCostUsd: cents(totalCostUsd),
    grossProfitUsd: cents(grossProfitUsd),
    grossMargin: Math.round(grossMargin * 10_000) / 10_000,
    breakEvenPriceUsd: cents(breakEvenPrice(nonFee, fee)),
    complete: missing.length === 0,
    missing,
  };
}
