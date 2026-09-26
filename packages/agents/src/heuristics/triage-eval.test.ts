import { describe, expect, it } from "vitest";
import { defaultTenantSettings } from "@gigpilot/contracts";
import { estimateOpportunity } from "@gigpilot/economics";
import { analyseOpportunityHeuristically, reconcileMissingInputs, sanitiseAnalysis } from "./analysis";
import { briefRequiresTests, detectModalities, parseDeadlineDays } from "./features";
import { TRIAGE_FIXTURES, TRIAGE_NOW } from "./triage-fixtures";

function triage(f: (typeof TRIAGE_FIXTURES)[number]) {
  return analyseOpportunityHeuristically(
    {
      title: f.title,
      description: f.description,
      skills: [],
      sourceKey: "mock",
      budgetType: f.budget.type,
      budgetMinUsd: f.budget.min,
      budgetMaxUsd: f.budget.max,
      deadlineAt: null,
      postedAt: TRIAGE_NOW,
      clientName: "Fixture Client",
      clientRating: 4.8,
      clientSpendUsd: 20_000,
      proposalsCount: 5,
      marketKey: null,
    },
    { preferredMinBudgetUsd: 300, now: TRIAGE_NOW },
  );
}

describe("triage evaluation set", () => {
  it("has at least 10 realistic briefs incl. the explainer-with-voiceover case", () => {
    expect(TRIAGE_FIXTURES.length).toBeGreaterThanOrEqual(10);
    expect(TRIAGE_FIXTURES.some((f) => /60s animated explainer with voiceover, 16:9 \+ 9:16/.test(f.description) && /14 days/.test(f.description))).toBe(true);
  });

  for (const f of TRIAGE_FIXTURES) {
    it(`${f.key}: extracts capabilities, deadline and completeness`, () => {
      const a = triage(f);
      const caps = a.productionEstimates.map((e) => e.capability);
      for (const c of f.capabilities) expect(caps, `${f.key} capabilities ${caps.join(",")}`).toContain(c);
      expect(a.deadlineDays, `${f.key} deadline`).toBe(f.deadlineDays);
      if (f.family) expect(a.serviceFamily).toBe(f.family);
      if (f.durationSec) expect(a.productionEstimates.some((e) => e.capability.startsWith("video.") && e.label.includes(`${f.durationSec}s`))).toBe(true);
      for (const feature of f.features ?? []) expect(a.requestedFeatures ?? [], `${f.key} features`).toContain(feature);
      if (f.requiresTests !== undefined) expect(briefRequiresTests(`${f.title}\n${f.description}`)).toBe(f.requiresTests);
      // Every production estimate says how it is priced ("priced via inference" for text/code/qa).
      for (const e of a.productionEstimates) expect(e.pricedVia).toBeDefined();
      const { economics } = estimateOpportunity(a, { sourceKey: "mock", budgetType: f.budget.type, budgetMinUsd: f.budget.min, budgetMaxUsd: f.budget.max }, defaultTenantSettings());
      expect(economics.complete, `${f.key} complete? missing: ${economics.missing.join("; ")}`).toBe(!f.incomplete);
      // Missing inputs are consistent with required − supplied.
      expect(a.missingInputs).toEqual(reconcileMissingInputs(a.requiredAssets, a.suppliedAssets, a.missingInputs, `${f.title}\n${f.description}`.toLowerCase()));
    });
  }

  it("the explainer is multi-format and its voiceover is never dropped by a model refinement", () => {
    const a = triage(TRIAGE_FIXTURES.find((f) => f.key === "explainer-voiceover")!);
    const video = a.productionEstimates.find((e) => e.capability === "video.generate")!;
    expect(video.units).toBe(2); // one render per aspect ratio (16:9 + 9:16)
    expect(video.label).toMatch(/16:9 \+ 9:16/);
    // A model that "forgets" the voiceover gets it re-added (so the estimate stays incomplete).
    const model = { ...a, productionEstimates: [video], missingInputs: [] };
    const clean = sanitiseAnalysis(model, a);
    expect(clean.productionEstimates.map((e) => e.capability)).toContain("audio.voiceover");
    expect(clean.productionEstimates.find((e) => e.capability === "audio.voiceover")!.pricedVia).toBe("unpriced");
  });

  it("detects modalities and parses deadline phrasings", () => {
    expect(detectModalities("60s animated explainer with voiceover").map((m) => m.capability).sort()).toEqual(["audio.voiceover", "video.generate"]);
    expect(detectModalities("podcast with music and sound design").map((m) => m.capability)).toEqual(["audio.music"]);
    expect(parseDeadlineDays("please deliver within 14 days", TRIAGE_NOW)).toBe(14);
    expect(parseDeadlineDays("turnaround 2 weeks", TRIAGE_NOW)).toBe(14);
    expect(parseDeadlineDays("needed by October 12", TRIAGE_NOW)).toBe(16);
    expect(parseDeadlineDays("deadline: 2026-10-06", TRIAGE_NOW)).toBe(10);
    expect(parseDeadlineDays("we have the last 30 days of data; deliver in 5 days", TRIAGE_NOW)).toBe(5);
    expect(parseDeadlineDays("a 30-day trial of our tool", TRIAGE_NOW)).toBeNull();
  });

  it("never reports 0 missing inputs while a required asset is not supplied", () => {
    expect(reconcileMissingInputs(["Final copy", "Hosting / domain access"], [], [], "build our site. figma designs are ready.")).toEqual(["Final copy", "Hosting / domain access"]);
    expect(reconcileMissingInputs(["Brand guidelines", "Logo (SVG)"], ["Brand kit (logo, fonts)"], [], "we supply our brand kit.")).toEqual([]);
  });
});
