import { z } from "zod";
import { BUSINESS_DEFAULTS, PLATFORM_FEE_DEFAULTS } from "@gigpilot/config/defaults";

const D = BUSINESS_DEFAULTS;

const range = z.object({ min: z.number().min(0), max: z.number().min(0) });

export const platformFeeSchema = z.object({
  pct: z.number().min(0).max(1),
  fixedUsd: z.number().min(0),
  minUsd: z.number().min(0),
  note: z.string().optional(),
});
export type PlatformFee = z.infer<typeof platformFeeSchema>;

export const tenantSettingsSchema = z.object({
  thresholds: z
    .object({
      minGrossMargin: z.number().min(0).max(0.99).default(D.thresholds.minGrossMargin),
      minExpectedProfitUsd: z.number().min(0).default(D.thresholds.minExpectedProfitUsd),
      preferredMinBudgetUsd: z.number().min(0).default(D.thresholds.preferredMinBudgetUsd),
      minFitScore: z.number().min(0).max(1).default(D.thresholds.minFitScore),
      minConfidence: z.number().min(0).max(1).default(D.thresholds.minConfidence),
    })
    .prefault({}),
  economics: z
    .object({
      shadowHourlyRateUsd: z.number().min(0).default(D.economics.shadowHourlyRateUsd),
      contingencyPct: z.number().min(0).max(1).default(D.economics.contingencyPct),
      expectedRevisionRounds: z.number().min(0).max(10).default(D.economics.expectedRevisionRounds),
      revisionCostFraction: z.number().min(0).max(2).default(D.economics.revisionCostFraction),
      defaultHourlyRateUsd: z.number().min(0).default(D.economics.defaultHourlyRateUsd),
      platformFees: z.record(z.string(), platformFeeSchema).default(PLATFORM_FEE_DEFAULTS),
    })
    .prefault({}),
  goals: z
    .object({
      viableOpportunitiesPerDay: range.default(D.goals.viableOpportunitiesPerDay),
      pursueWorthyPerDay: range.default(D.goals.pursueWorthyPerDay),
      paidJobsFirst30Days: range.default(D.goals.paidJobsFirst30Days),
      costEstimateAccuracyPct: z.number().min(1).max(100).default(D.goals.costEstimateAccuracyPct),
      ownerTouchpointsPerJob: z.number().min(0).default(D.goals.ownerTouchpointsPerJob),
    })
    .prefault({}),
  autonomy: z
    .object({
      requireOpportunityApproval: z.boolean().default(D.autonomy.requireOpportunityApproval),
      requireProposalApproval: z.boolean().default(D.autonomy.requireProposalApproval),
      autoSubmitWhenPermitted: z.boolean().default(D.autonomy.autoSubmitWhenPermitted),
      requireFinalDeliveryApproval: z.boolean().default(D.autonomy.requireFinalDeliveryApproval),
      autoRepairWithinLimits: z.boolean().default(D.autonomy.autoRepairWithinLimits),
      autoSendClientMessages: z.boolean().default(D.autonomy.autoSendClientMessages),
    })
    .prefault({}),
  limits: z
    .object({
      perJobSpendLimitUsd: z.number().min(0).default(D.limits.perJobSpendLimitUsd),
      dailyPaidSpendLimitUsd: z.number().min(0).default(D.limits.dailyPaidSpendLimitUsd),
      maxStepAttempts: z.number().int().min(1).max(10).default(D.limits.maxStepAttempts),
      maxRepairsPerJob: z.number().int().min(0).max(20).default(D.limits.maxRepairsPerJob),
      maxGenerationsPerStep: z.number().int().min(1).max(50).default(D.limits.maxGenerationsPerStep),
      dailyLocalModelCalls: z.number().int().min(0).max(100_000).default(D.limits.dailyLocalModelCalls),
      maxRefinesPerHour: z.number().int().min(0).max(1000).default(D.limits.maxRefinesPerHour),
    })
    .prefault({}),
  routing: z
    .object({
      creativeProviderPreference: z.array(z.string()).default([...D.routing.creativeProviderPreference]),
      creativeQualityThreshold: z.number().min(0).max(1).default(D.routing.creativeQualityThreshold),
      allowedModelFamilies: z.array(z.string()).default([...D.routing.allowedModelFamilies]),
      preferLocalForCheapTasks: z.boolean().default(D.routing.preferLocalForCheapTasks),
    })
    .prefault({}),
  sourcing: z
    .object({
      refreshIntervalMinutes: z.number().int().min(5).max(1440).default(D.sourcing.refreshIntervalMinutes),
      opportunityMaxAgeHours: z.number().int().min(1).max(24 * 30).default(D.sourcing.opportunityMaxAgeHours),
    })
    .prefault({}),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type TenantSettingsInput = z.input<typeof tenantSettingsSchema>;

export function defaultTenantSettings(): TenantSettings {
  return tenantSettingsSchema.parse({});
}

/** Parse stored settings, filling any missing keys with defaults. */
export function resolveTenantSettings(stored: unknown): TenantSettings {
  const parsed = tenantSettingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : defaultTenantSettings();
}
