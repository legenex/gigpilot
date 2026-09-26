import { describe, expect, it } from "vitest";
import { defaultTenantSettings, type OpportunityAnalysis } from "@gigpilot/contracts";
import { breakEvenPrice, calculateEconomics, platformFee, resolvePrice, type EconomicsInput } from "./calculator";
import { scoreOpportunity, statedBudget } from "./scoring";
import { chooseCreativeRoute, estimateOpportunity } from "./estimate";

const baseInput = (over: Partial<EconomicsInput> = {}): EconomicsInput => ({
  price: { budgetType: "fixed", budgetMinUsd: 1000, budgetMaxUsd: 1000, hourlyRateUsd: 85 },
  lineItems: [
    { category: "creative", label: "images", provider: "kie", model: "m", unit: "image", unitCostUsd: 0.5, quantity: 20, attempts: 2, priceSource: "t" },
  ],
  platformFee: { key: "upwork", pct: 0.1, fixedUsd: 0, minUsd: 0 },
  revision: { expectedRounds: 1, costFraction: 0.5 },
  contingencyPct: 0.1,
  shadow: { hours: 2, hourlyRateUsd: 50 },
  ...over,
});

describe("calculateEconomics", () => {
  it("computes fulfilment, contingency, fees, profit and margin deterministically", () => {
    const r = calculateEconomics(baseInput());
    expect(r.fulfilmentCostUsd).toBe(20); // 0.5 × 20 × 2
    expect(r.revisionContingencyUsd).toBe(10); // 20 × 1 × 0.5
    expect(r.contingencyUsd).toBe(3); // (20 + 10) × 0.1
    expect(r.shadowCostUsd).toBe(100);
    expect(r.platformFeesUsd).toBe(100); // 10% of 1000
    expect(r.totalCostUsd).toBe(233);
    expect(r.grossProfitUsd).toBe(767);
    expect(r.grossMargin).toBeCloseTo(0.767, 4);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("applies the marketplace minimum fee", () => {
    expect(platformFee(30, { key: "freelancer", pct: 0.1, fixedUsd: 0, minUsd: 5 })).toBe(5);
    expect(platformFee(300, { key: "freelancer", pct: 0.1, fixedUsd: 0, minUsd: 5 })).toBe(30);
    expect(platformFee(0, { key: "freelancer", pct: 0.1, fixedUsd: 0, minUsd: 5 })).toBe(0);
  });

  it("computes break-even price including proportional fees", () => {
    // non-fee costs 133 at 10% fee → 133 / 0.9
    const be = breakEvenPrice(133, { key: "upwork", pct: 0.1, fixedUsd: 0, minUsd: 0 });
    expect(be).toBeCloseTo(147.78, 2);
    // profit at break-even is ~0
    const r = calculateEconomics(baseInput({ price: { budgetType: "fixed", budgetMaxUsd: be, hourlyRateUsd: 85 } }));
    expect(Math.abs(r.grossProfitUsd)).toBeLessThan(0.02);
  });

  it("break-even respects a minimum fee floor", () => {
    expect(breakEvenPrice(20, { key: "freelancer", pct: 0.1, fixedUsd: 0, minUsd: 5 })).toBe(25);
  });

  it("marks the estimate incomplete (never invents) when a price is missing", () => {
    const r = calculateEconomics(
      baseInput({
        lineItems: [
          { category: "creative", label: "upscale", provider: "kie", model: "topaz", unit: "image", unitCostUsd: null, quantity: 10, attempts: 1, priceSource: "unknown" },
        ],
      }),
    );
    expect(r.complete).toBe(false);
    expect(r.missing.join(" ")).toContain("kie/topaz");
    expect(r.fulfilmentCostUsd).toBe(0);
  });

  it("marks hourly work without an hours estimate incomplete", () => {
    const p = resolvePrice({ budgetType: "hourly", budgetMinUsd: 40, budgetMaxUsd: 90, hourlyRateUsd: 85 });
    expect(p.basis).toBe("unknown");
    expect(p.missing).toContain("billable hours estimate");
  });

  it("clamps hourly rate into the client's range", () => {
    expect(resolvePrice({ budgetType: "hourly", budgetMaxUsd: 50, billableHours: 10, hourlyRateUsd: 85 }).priceUsd).toBe(500);
    expect(resolvePrice({ budgetType: "hourly", budgetMinUsd: 120, billableHours: 10, hourlyRateUsd: 85 }).priceUsd).toBe(1200);
  });

  it("uses the midpoint of a fixed budget range, and proposals override budgets", () => {
    expect(resolvePrice({ budgetType: "fixed", budgetMinUsd: 400, budgetMaxUsd: 800, hourlyRateUsd: 85 }).priceUsd).toBe(600);
    expect(resolvePrice({ budgetType: "fixed", budgetMinUsd: 400, budgetMaxUsd: 800, proposedPriceUsd: 750, hourlyRateUsd: 85 })).toMatchObject({
      priceUsd: 750,
      basis: "proposal",
    });
  });

  it("revision contingency scales with expected rounds", () => {
    const none = calculateEconomics(baseInput({ revision: { expectedRounds: 0, costFraction: 0.5 } }));
    const two = calculateEconomics(baseInput({ revision: { expectedRounds: 2, costFraction: 0.5 } }));
    expect(none.revisionContingencyUsd).toBe(0);
    expect(two.revisionContingencyUsd).toBe(20);
  });
});

describe("scoreOpportunity gates", () => {
  const thresholds = { minGrossMargin: 0.5, minExpectedProfitUsd: 300, preferredMinBudgetUsd: 300 };
  const good = { fit: 0.8, complexity: 0.3, revisionRisk: 0.2, deadlineRisk: 0.2, confidence: 0.8, highRisks: 0 };

  it("recommends pursue when profit ≥ $300 and margin ≥ 50%", () => {
    const econ = calculateEconomics(baseInput());
    const s = scoreOpportunity(econ, good, thresholds, 1000);
    expect(s.gates.profit.pass).toBe(true);
    expect(s.gates.margin.pass).toBe(true);
    expect(s.recommendation).toBe("pursue");
  });

  it("skips when expected profit is below the minimum (profit gate)", () => {
    const econ = calculateEconomics(baseInput({ price: { budgetType: "fixed", budgetMaxUsd: 350, hourlyRateUsd: 85 } }));
    const s = scoreOpportunity(econ, good, thresholds, 350);
    expect(s.gates.profit.pass).toBe(false);
    expect(s.recommendation).toBe("skip");
  });

  it("skips when margin is below target even if profit clears", () => {
    const econ = calculateEconomics(
      baseInput({
        price: { budgetType: "fixed", budgetMaxUsd: 2000, hourlyRateUsd: 85 },
        lineItems: [{ category: "creative", label: "video", provider: "higgsfield", model: "x", unit: "clip", unitCostUsd: 50, quantity: 16, attempts: 1, priceSource: "t" }],
      }),
    );
    const s = scoreOpportunity(econ, good, thresholds, 2000);
    expect(econ.grossProfitUsd).toBeGreaterThan(300);
    expect(s.gates.margin.pass).toBe(false);
    expect(s.recommendation).toBe("skip");
  });

  it("thresholds are configuration, not constants", () => {
    const econ = calculateEconomics(baseInput());
    const strict = scoreOpportunity(econ, good, { ...thresholds, minExpectedProfitUsd: 900 }, 1000);
    expect(strict.recommendation).toBe("skip");
  });

  it("downgrades to consider for low-budget or incomplete estimates", () => {
    const lowBudget = scoreOpportunity(calculateEconomics(baseInput()), good, { ...thresholds, preferredMinBudgetUsd: 1500 }, 1000);
    expect(lowBudget.recommendation).toBe("consider");
    const incomplete = calculateEconomics(
      baseInput({
        lineItems: [{ category: "creative", label: "u", provider: "kie", model: "t", unit: "image", unitCostUsd: null, quantity: 1, attempts: 1, priceSource: "?" }],
      }),
    );
    expect(scoreOpportunity(incomplete, good, thresholds, 1000).recommendation).toBe("consider");
  });

  it("statedBudget prefers the range maximum", () => {
    expect(statedBudget(200, 500)).toBe(500);
    expect(statedBudget(200, null)).toBe(200);
    expect(statedBudget(null, null)).toBeNull();
  });
});

describe("creative routing", () => {
  it("chooses the cheapest route that clears the quality threshold, not the cheapest request", () => {
    const route = chooseCreativeRoute("image.generate", { qualityThreshold: 0.8, preference: ["kie", "higgsfield"] });
    expect(route).not.toBeNull();
    expect(route!.predictedQuality).toBeGreaterThanOrEqual(0.8);
    // z-image/turbo and imagen4-fast are cheap but below 0.8 quality → excluded
    expect(["google/imagen4-fast", "z-image/turbo"]).not.toContain(route!.option.model);
  });

  it("uses observed usable rates once there is enough history", () => {
    const withHistory = chooseCreativeRoute("image.generate", {
      qualityThreshold: 0.8,
      preference: ["kie", "higgsfield"],
      metrics: [{ provider: "higgsfield", model: "higgsfield-ai/soul/v2/standard", capability: "image.generate", usableRate: 0.01, attempts: 50 }],
    });
    expect(withHistory!.option.model).not.toBe("higgsfield-ai/soul/v2/standard");
  });

  it("respects provider availability", () => {
    const route = chooseCreativeRoute("image.generate", { qualityThreshold: 0.7, preference: ["kie"], availableProviders: ["kie"] });
    expect(route!.option.provider).toBe("kie");
  });
});

describe("estimateOpportunity", () => {
  const analysis: OpportunityAnalysis = {
    summary: "UGC ad set",
    clientRequest: "10 UGC videos",
    serviceFamily: "paid-social-ugc",
    deliverables: [{ item: "UGC video 15s", quantity: 10 }],
    suppliedAssets: [],
    requiredAssets: [],
    missingInputs: [],
    skills: [],
    risks: [],
    deadlineDays: 7,
    productionEstimates: [{ label: "9:16 UGC video 8s", capability: "video.generate", units: 10, attemptsPerUnit: 2 }],
    inferenceEstimates: [{ task: "scripts", family: "gx", kTokensIn: 4, kTokensOut: 2, calls: 10 }],
    humanHours: 2,
    billableHours: null,
    proposedWorkflow: [],
    fitScore: 0.8,
    complexity: 0.4,
    revisionRisk: 0.3,
    deadlineRisk: 0.2,
    confidence: 0.75,
    rationale: [],
    buyerPriorities: [],
  };

  it("prices quantities from the catalog using tenant settings", () => {
    const settings = defaultTenantSettings();
    const { economics, routes } = estimateOpportunity(analysis, { sourceKey: "upwork", budgetType: "fixed", budgetMaxUsd: 1200 }, settings);
    expect(routes.length).toBe(1);
    expect(economics.priceUsd).toBe(1200);
    expect(economics.platformFeesUsd).toBe(120);
    expect(economics.complete).toBe(true);
    expect(economics.lineItems.find((l) => l.category === "inference")!.totalUsd).toBe(0); // GX local
    expect(economics.grossProfitUsd).toBeGreaterThan(300);
  });
});

describe("pricing completeness (never invent prices)", () => {
  const base = {
    summary: "Dub 4 videos",
    clientRequest: "dubbing",
    serviceFamily: "localization-repurposing",
    deliverables: [{ item: "Dubbed video", quantity: 4 }],
    suppliedAssets: [],
    requiredAssets: [],
    missingInputs: [],
    skills: [],
    risks: [],
    deadlineDays: 7,
    inferenceEstimates: [],
    humanHours: 1,
    billableHours: null,
    proposedWorkflow: [],
    fitScore: 0.8,
    complexity: 0.3,
    revisionRisk: 0.2,
    deadlineRisk: 0.2,
    confidence: 0.8,
    rationale: [],
    buyerPriorities: [],
  } satisfies Omit<OpportunityAnalysis, "productionEstimates">;

  it("flags audio production with no priced route as incomplete instead of $0", () => {
    const { economics } = estimateOpportunity(
      { ...base, productionEstimates: [{ label: "Spanish dub", capability: "audio.dub", units: 4, attemptsPerUnit: 1 }] },
      { sourceKey: "upwork", budgetType: "fixed", budgetMaxUsd: 1500 },
      defaultTenantSettings(),
    );
    expect(economics.complete).toBe(false);
    expect(economics.missing.join(" ")).toContain("audio.dub");
    expect(scoreOpportunity(economics, { fit: 0.8, complexity: 0.3, revisionRisk: 0.2, deadlineRisk: 0.2, confidence: 0.8, highRisks: 0 }, defaultTenantSettings().thresholds, 1500).recommendation).not.toBe("pursue");
  });

  it("does not double count text/code production that is priced via inference", () => {
    const { economics } = estimateOpportunity(
      { ...base, productionEstimates: [{ label: "Landing copy", capability: "text.copy", units: 3, attemptsPerUnit: 1 }] },
      { sourceKey: "upwork", budgetType: "fixed", budgetMaxUsd: 1500 },
      defaultTenantSettings(),
    );
    expect(economics.complete).toBe(true);
    expect(economics.lineItems).toHaveLength(0);
  });

  it("flags an unknown marketplace fee schedule as incomplete", () => {
    const { economics } = estimateOpportunity(
      { ...base, productionEstimates: [] },
      { sourceKey: "some-new-marketplace", budgetType: "fixed", budgetMaxUsd: 1500 },
      defaultTenantSettings(),
    );
    expect(economics.complete).toBe(false);
    expect(economics.missing.join(" ")).toContain("platform fee");
  });
});
