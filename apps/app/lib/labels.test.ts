import { describe, expect, it } from "vitest";
import { cleanMessage, findingLabel, routeLabel, serviceFamilyLabel, taskLabel } from "./labels";

describe("routeLabel", () => {
  it("maps plumbing ids to owner labels", () => {
    expect(routeLabel("gx", "gx-code")).toBe("Local model · free");
    expect(routeLabel("mock", "mock-deterministic")).toBe("Simulated");
    expect(routeLabel("heuristic", "deterministic-triage")).toBe("Preliminary triage");
    expect(routeLabel("kie", "veo-3-1")).toBe("Kie · Veo 3.1");
    expect(routeLabel("kie", "kling-3.0/video")).toBe("Kie · Kling 3.0");
    expect(routeLabel("kie", "google/nano-banana-edit")).toBe("Kie · Nano banana edit");
    expect(routeLabel(null)).toBe("—");
  });
});

describe("taskLabel", () => {
  it("humanises raw task identifiers", () => {
    expect(taskLabel("analyse_opportunity.refine")).toBe("Deep analysis");
    expect(taskLabel("analyse_opportunity")).toBe("Triage & pricing");
    expect(taskLabel("step.finalize")).toBe("Packaging");
    expect(taskLabel("Normalise listing from mock")).toBe("Normalise Demo listing");
    expect(taskLabel("Draft proposal: Foo")).toBe("Draft proposal: Foo");
  });
});

describe("serviceFamilyLabel", () => {
  it("never returns slugs", () => {
    expect(serviceFamilyLabel("paid-social-ugc")).toBe("Paid social creatives & UGC");
    expect(serviceFamilyLabel("paid-social-ugc", true)).toBe("Paid social & UGC");
    expect(serviceFamilyLabel("new-thing")).toBe("New thing");
  });
});

describe("findingLabel", () => {
  it("labels demo and unverified-test findings", () => {
    expect(findingLabel("demo_injected_defect")).toBe("Simulated defect — demo");
    expect(findingLabel("failing_tests", "assertion failed (demo defect injected on first attempt)")).toBe("Simulated defect — demo");
    expect(findingLabel("tests_not_executed")).toBe("Tests generated, not executed");
    expect(findingLabel("whatever")).toBeNull();
  });
});

describe("cleanMessage", () => {
  it("drops the repeated title clause", () => {
    expect(cleanMessage("Analysis of 'Zapier fix: duplicate rows in Google Sheets' finished — Analysed 'Zapier fix: duplicate rows in…' — $90.00 budget, 21% margin → skip")).toBe(
      "Analysed 'Zapier fix: duplicate rows in Google Sheets' — $90.00 budget, 21% margin → skip",
    );
  });
  it("keeps messages with a single title", () => {
    expect(cleanMessage("Scored 'Resize bakery logo': 29/100 — Expected profit $-33 is below the $300 minimum")).toBe("Scored 'Resize bakery logo': 29/100 — Expected profit −$33 is below the $300 minimum");
  });
  it("replaces route ids, paths, mock refs and duplicated demo labels", () => {
    expect(cleanMessage("Video generation started on kie/kling-3.0/video")).toBe("Video generation started on Kie · Kling 3.0");
    expect(cleanMessage("Package contents: 01-scope/scope-pages.md (Scope pages & requirements), 02-plan/plan.md")).toBe("Package contents: Scope pages & requirements, plan.md");
    expect(cleanMessage("Submitted 'X' to Demo marketplace at $420 (demo marketplace)")).toBe("Submitted 'X' to Demo marketplace at $420");
    expect(cleanMessage("Submitted (mock-7bda29ac) to Demo marketplace")).toBe("Submitted to Demo marketplace");
  });
});
