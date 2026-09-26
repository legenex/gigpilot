import { describe, expect, it } from "vitest";
import { generateAutomationArtifact, generateWebArtifact } from "./code";
import { detectRequestedFeatures, featureCoverage } from "./features";

const MVP_BRIEF =
  "Build an MVP client portal for our bookkeeping practice: magic-link login, document upload/download, request tracking, and Stripe subscription billing with customer portal. " +
  "Stack: Next.js + Supabase. Include tests for billing webhooks and a deployment guide.";

describe("deterministic code artifacts attempt every requested feature", () => {
  it("web generator provides evidence for each feature the brief names", () => {
    const art = generateWebArtifact({ title: "MVP client portal", brief: MVP_BRIEF, clientName: "Beacon Books", defect: null, repairHint: null });
    const cov = featureCoverage(detectRequestedFeatures(MVP_BRIEF, "web-app-builds"), art.files);
    expect(cov.missing.map((f) => f.label)).toEqual([]);
    // The scaffold is honest about not being executed.
    expect(art.files.some((f) => /un-executed/i.test(f.content))).toBe(true);
    expect(art.testReport.simulated).toBe(true);
  });

  it("automation generator covers an integration brief's features", () => {
    const brief =
      "Shopify → HubSpot sync in n8n: webhook triggers, dedupe contacts by email, retry with backoff on 429s, dead-letter log, Slack alerts, README + runbook. Include tests.";
    const art = generateAutomationArtifact({ title: "Shopify → HubSpot sync", brief, defect: null, repairHint: null });
    const cov = featureCoverage(detectRequestedFeatures(brief, "ai-automation"), art.files);
    expect(cov.missing.map((f) => f.label)).toEqual([]);
  });

  it("never overwrites a real implementation with a scaffold", () => {
    const art = generateWebArtifact({ title: "Marketing site", brief: MVP_BRIEF, clientName: "Beacon Books", defect: null, repairHint: null });
    const cms = art.files.filter((f) => f.path === "lib/cms.ts");
    expect(cms).toHaveLength(1);
  });
});
