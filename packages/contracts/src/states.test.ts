import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, InvalidTransitionError, isTerminal, JOB_STATES, JOB_TRANSITIONS } from "./states";
import { defaultTenantSettings, resolveTenantSettings } from "./settings";

describe("state machines", () => {
  it("allows the canonical job lifecycle", () => {
    const path = ["intake", "planning", "ready", "executing", "qa", "repairing", "qa", "awaiting_final_approval", "delivered", "closed"];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition("job", path[i]!, path[i + 1]!)).toBe(true);
  });

  it("rejects silent jumps", () => {
    expect(canTransition("job", "intake", "delivered")).toBe(false);
    expect(canTransition("job", "executing", "awaiting_final_approval")).toBe(false);
    expect(() => assertTransition("application", "draft", "submitted")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("proposal", "draft", "approved")).toThrow(InvalidTransitionError);
  });

  it("every declared target is itself a valid state", () => {
    for (const [from, tos] of Object.entries(JOB_TRANSITIONS)) {
      expect(JOB_STATES).toContain(from);
      for (const to of tos) expect(JOB_STATES).toContain(to);
    }
  });

  it("knows terminal states", () => {
    expect(isTerminal("job", "closed")).toBe(true);
    expect(isTerminal("run", "failed")).toBe(true);
    expect(isTerminal("job", "qa")).toBe(false);
  });
});

describe("tenant settings", () => {
  it("defaults to the canonical business thresholds", () => {
    const s = defaultTenantSettings();
    expect(s.thresholds.minGrossMargin).toBe(0.5);
    expect(s.thresholds.minExpectedProfitUsd).toBe(300);
    expect(s.thresholds.preferredMinBudgetUsd).toBe(300);
    expect(s.limits.dailyPaidSpendLimitUsd).toBe(0);
    expect(s.autonomy.requireProposalApproval).toBe(true);
    expect(s.autonomy.requireFinalDeliveryApproval).toBe(true);
    expect(s.autonomy.autoSendClientMessages).toBe(false);
  });

  it("merges partial stored settings with defaults and survives garbage", () => {
    const s = resolveTenantSettings({ thresholds: { minExpectedProfitUsd: 500 } });
    expect(s.thresholds.minExpectedProfitUsd).toBe(500);
    expect(s.thresholds.minGrossMargin).toBe(0.5);
    expect(resolveTenantSettings("nonsense").thresholds.minGrossMargin).toBe(0.5);
  });
});
