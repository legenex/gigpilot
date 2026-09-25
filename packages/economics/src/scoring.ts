import type { EconomicsResult } from "./calculator";

export interface Thresholds {
  minGrossMargin: number;
  minExpectedProfitUsd: number;
  preferredMinBudgetUsd: number;
}

export interface QualitySignals {
  fit: number;
  complexity: number;
  revisionRisk: number;
  deadlineRisk: number;
  confidence: number;
  highRisks: number;
}

export interface Gates {
  budget: { pass: boolean; value: number | null; threshold: number; soft: true };
  profit: { pass: boolean; value: number; threshold: number };
  margin: { pass: boolean; value: number; threshold: number };
  complete: { pass: boolean };
}

export type Recommendation = "pursue" | "consider" | "skip";

export interface ScoreResult {
  gates: Gates;
  overall: number;
  recommendation: Recommendation;
  reasons: string[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** The client's stated budget used for the soft budget gate (max of range, else min). */
export function statedBudget(budgetMinUsd?: number | null, budgetMaxUsd?: number | null): number | null {
  const max = typeof budgetMaxUsd === "number" && budgetMaxUsd > 0 ? budgetMaxUsd : null;
  const min = typeof budgetMinUsd === "number" && budgetMinUsd > 0 ? budgetMinUsd : null;
  return max ?? min;
}

export function evaluateGates(econ: EconomicsResult, thresholds: Thresholds, budgetValue: number | null): Gates {
  const budgetForGate = budgetValue ?? (econ.priceUsd > 0 ? econ.priceUsd : null);
  return {
    budget: {
      pass: budgetForGate !== null && budgetForGate >= thresholds.preferredMinBudgetUsd,
      value: budgetForGate,
      threshold: thresholds.preferredMinBudgetUsd,
      soft: true,
    },
    profit: {
      pass: econ.grossProfitUsd >= thresholds.minExpectedProfitUsd,
      value: econ.grossProfitUsd,
      threshold: thresholds.minExpectedProfitUsd,
    },
    margin: {
      pass: econ.grossMargin >= thresholds.minGrossMargin,
      value: econ.grossMargin,
      threshold: thresholds.minGrossMargin,
    },
    complete: { pass: econ.complete },
  };
}

/**
 * Deterministic score & recommendation. Hard gates: profit and margin.
 * Budget is a soft gate (downgrades pursue → consider). Incomplete estimates
 * are never recommended for pursuit.
 */
export function scoreOpportunity(econ: EconomicsResult, signals: QualitySignals, thresholds: Thresholds, budgetValue: number | null): ScoreResult {
  const gates = evaluateGates(econ, thresholds, budgetValue);
  const reasons: string[] = [];

  const profitScore = clamp01(econ.grossProfitUsd / Math.max(1, thresholds.minExpectedProfitUsd * 2));
  const marginScore = clamp01((econ.grossMargin - thresholds.minGrossMargin * 0.5) / Math.max(0.01, 1 - thresholds.minGrossMargin * 0.5));
  const overall = clamp01(
    0.3 * clamp01(signals.fit) +
      0.25 * profitScore +
      0.2 * marginScore +
      0.1 * clamp01(signals.confidence) +
      0.05 * (1 - clamp01(signals.revisionRisk)) +
      0.05 * (1 - clamp01(signals.deadlineRisk)) +
      0.05 * (1 - clamp01(signals.complexity)),
  );

  let recommendation: Recommendation;
  if (!gates.complete.pass) {
    recommendation = gates.profit.pass && gates.margin.pass ? "consider" : "skip";
    reasons.push(`Estimate incomplete: ${econ.missing.join(", ")}`);
  } else if (!gates.profit.pass || !gates.margin.pass) {
    recommendation = "skip";
    if (!gates.profit.pass)
      reasons.push(`Expected profit $${econ.grossProfitUsd.toFixed(0)} is below the $${thresholds.minExpectedProfitUsd.toFixed(0)} minimum`);
    if (!gates.margin.pass)
      reasons.push(`Margin ${(econ.grossMargin * 100).toFixed(0)}% is below the ${(thresholds.minGrossMargin * 100).toFixed(0)}% target`);
  } else {
    recommendation = "pursue";
    reasons.push(
      `Clears profit ($${econ.grossProfitUsd.toFixed(0)} ≥ $${thresholds.minExpectedProfitUsd.toFixed(0)}) and margin (${(econ.grossMargin * 100).toFixed(0)}% ≥ ${(thresholds.minGrossMargin * 100).toFixed(0)}%)`,
    );
    if (!gates.budget.pass) {
      recommendation = "consider";
      reasons.push(`Budget below the preferred $${thresholds.preferredMinBudgetUsd.toFixed(0)} minimum`);
    }
    if (signals.fit < 0.55) {
      recommendation = "consider";
      reasons.push(`Capability fit is moderate (${Math.round(signals.fit * 100)}%)`);
    }
    if (signals.confidence < 0.5) {
      recommendation = "consider";
      reasons.push(`Low analysis confidence (${Math.round(signals.confidence * 100)}%)`);
    }
    if (signals.highRisks > 0) {
      recommendation = "consider";
      reasons.push(`${signals.highRisks} high-severity risk${signals.highRisks > 1 ? "s" : ""} flagged`);
    }
  }

  return { gates, overall: Math.round(overall * 1000) / 1000, recommendation, reasons };
}
