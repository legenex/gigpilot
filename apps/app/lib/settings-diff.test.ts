import { describe, expect, it } from "vitest";
import { changedPaths, diffSettings } from "./settings-diff";

describe("settings diff", () => {
  const current = { limits: { dailyPaidSpendLimitUsd: 0, perJobSpendLimitUsd: 50 }, routing: { allowedModelFamilies: ["gx", "grok"], preferLocalForCheapTasks: true }, economics: { platformFees: { upwork: 0.1 } } };

  it("keeps only changed leaves; arrays replace whole", () => {
    const next = { limits: { dailyPaidSpendLimitUsd: 5, perJobSpendLimitUsd: 50 }, routing: { allowedModelFamilies: ["gx"], preferLocalForCheapTasks: true }, economics: { platformFees: { upwork: 0.1 } } };
    expect(diffSettings(current, next)).toEqual({ limits: { dailyPaidSpendLimitUsd: 5 }, routing: { allowedModelFamilies: ["gx"] } });
    expect(changedPaths(diffSettings(current, next)).sort()).toEqual(["limits.dailyPaidSpendLimitUsd", "routing.allowedModelFamilies"]);
  });

  it("returns an empty patch when nothing changed and ignores undefined", () => {
    expect(diffSettings(current, JSON.parse(JSON.stringify(current)))).toEqual({});
    expect(diffSettings(current, { limits: { dailyPaidSpendLimitUsd: undefined } })).toEqual({});
  });

  it("includes new keys (e.g. a new platform fee)", () => {
    expect(diffSettings(current, { economics: { platformFees: { upwork: 0.1, contra: 0 } } })).toEqual({ economics: { platformFees: { contra: 0 } } });
  });
});
