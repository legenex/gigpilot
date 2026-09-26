import { describe, expect, it } from "vitest";
import { defaultTenantSettings, type OpportunityAnalysis } from "@gigpilot/contracts";
import { chooseCreativeRoute, estimateOpportunity, isInferenceDelivered } from "./estimate";
import { deliverableUnitsFor } from "./catalog";

const settings = defaultTenantSettings();

function analysis(over: Partial<OpportunityAnalysis> = {}): OpportunityAnalysis {
  return {
    summary: "x",
    clientRequest: "x",
    serviceFamily: "paid-social-ugc",
    deliverables: [],
    suppliedAssets: [],
    requiredAssets: [],
    missingInputs: [],
    skills: [],
    risks: [],
    deadlineDays: null,
    productionEstimates: [{ label: "8× 1:1 static ad", capability: "image.generate", units: 8, attemptsPerUnit: 1.5 }],
    inferenceEstimates: [{ task: "hooks, scripts & prompts", family: "factory", kTokensIn: 6, kTokensOut: 3, calls: 5 }],
    humanHours: 2,
    billableHours: null,
    proposedWorkflow: [],
    fitScore: 0.8,
    complexity: 0.4,
    revisionRisk: 0.3,
    deadlineRisk: 0.3,
    confidence: 0.8,
    rationale: [],
    buyerPriorities: [],
    ...over,
  };
}

const opp = { sourceKey: "mock", budgetType: "fixed" as const, budgetMinUsd: 1200, budgetMaxUsd: 1200 };

describe("estimates priced on the routes that actually run (H4)", () => {
  it("prices inference on the family the router would use: factory unconfigured → gx at $0", () => {
    const { economics } = estimateOpportunity(analysis(), opp, settings, { availableIntelligenceFamilies: ["gx"], availableCreativeProviders: ["kie"] });
    const inf = economics.lineItems.find((l) => l.category === "inference")!;
    expect(inf).toMatchObject({ provider: "gx", model: "gx-code", unitCostUsd: 0, routeStatus: "local", requestedProvider: "factory" });
    expect(inf.routeNote).toMatch(/factory not available.*gx \(local, \$0\)/);
    expect(economics.complete).toBe(true);
  });

  it("without availability info keeps the requested family (backward compatible)", () => {
    const { economics } = estimateOpportunity(analysis(), opp, settings);
    const inf = economics.lineItems.find((l) => l.category === "inference")!;
    expect(inf.provider).toBe("factory");
    expect(inf.unitCostUsd).toBeGreaterThan(0);
    expect(inf.routeStatus).toBeUndefined();
  });

  it("no intelligence provider at all → deterministic mock at $0, labelled simulated", () => {
    const { economics } = estimateOpportunity(analysis(), opp, settings, { availableIntelligenceFamilies: [], availableCreativeProviders: [] });
    const inf = economics.lineItems.find((l) => l.category === "inference")!;
    expect(inf).toMatchObject({ provider: "mock", unitCostUsd: 0, routeStatus: "simulated" });
  });

  it("creative on connected providers, else the catalog route marked simulated (mock renders it)", () => {
    const live = estimateOpportunity(analysis(), opp, settings, { availableIntelligenceFamilies: ["gx"], availableCreativeProviders: ["higgsfield"] }).economics;
    const li = live.lineItems.find((l) => l.category === "creative")!;
    expect(li.provider).toBe("higgsfield");
    expect(li.routeStatus).toBe("available");
    const sim = estimateOpportunity(analysis(), opp, settings, { availableIntelligenceFamilies: ["gx"], availableCreativeProviders: [] }).economics;
    const s = sim.lineItems.find((l) => l.category === "creative")!;
    expect(s).toMatchObject({ provider: "mock", routeStatus: "simulated" });
    expect(s.requestedProvider).toMatch(/^(kie|higgsfield)\//);
    expect(s.unitCostUsd).toBeGreaterThan(0); // still priced at the catalog rate of the simulated route
    expect(sim.complete).toBe(true); // demo workspaces keep mock routes
    expect(sim.coverage?.[0]).toMatchObject({ pricedVia: "creative", routeStatus: "simulated" });
  });

  it("live workspaces: a capability without a connected provider makes the estimate incomplete (H5)", () => {
    const a = analysis({ productionEstimates: [{ label: "1× explainer (60s, 16:9)", capability: "video.generate", units: 1, attemptsPerUnit: 2 }, { label: "voiceover (60s)", capability: "audio.voiceover", units: 1, attemptsPerUnit: 1 }] });
    const { economics } = estimateOpportunity(a, opp, settings, { availableIntelligenceFamilies: ["gx"], availableCreativeProviders: [], requireConnectedProviders: true });
    expect(economics.complete).toBe(false);
    expect(economics.missing).toEqual(expect.arrayContaining([expect.stringMatching(/^no connected provider for video\.generate/), expect.stringMatching(/^no connected provider for audio\.voiceover/)]));
    const codeOnly = analysis({ serviceFamily: "ai-automation", productionEstimates: [{ label: "Automation build", capability: "code.automation", units: 1, attemptsPerUnit: 1.3 }] });
    const noModel = estimateOpportunity(codeOnly, opp, settings, { availableIntelligenceFamilies: [], availableCreativeProviders: [], requireConnectedProviders: true }).economics;
    expect(noModel.missing).toContain("no connected provider for code.automation (no GX / Factory / Grok configured)");
    const withGx = estimateOpportunity(codeOnly, opp, settings, { availableIntelligenceFamilies: ["gx"], availableCreativeProviders: [], requireConnectedProviders: true }).economics;
    expect(withGx.complete).toBe(true);
    expect(withGx.coverage?.[0]).toMatchObject({ pricedVia: "inference", routeStatus: "local" });
  });

  it("marks inference-delivered capabilities and prices a 60s per-clip route as several clips", () => {
    expect(isInferenceDelivered("code.build")).toBe(true);
    expect(isInferenceDelivered("image.generate")).toBe(false);
    const veo = { provider: "kie", model: "veo-3-1", capability: "video.generate" as const, unitCostUsd: 0.3, unit: "clip" as const, qualityPrior: 0.86, usableRatePrior: 0.6, avgLatencySec: 120, notes: "Fast tier, 720p, ~8s clip" };
    expect(deliverableUnitsFor(veo, 60)).toBe(8);
    expect(deliverableUnitsFor(veo, 8)).toBe(1);
    const route = chooseCreativeRoute("video.generate", { qualityThreshold: 0.72, preference: ["kie"], durationSec: 60 })!;
    expect(route.expectedCostPerUsableUsd).toBeGreaterThan(1); // never a single 8s clip for a 60s video
  });
});
