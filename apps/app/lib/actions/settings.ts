"use server";

import type { TenantSettingsInput } from "@gigpilot/contracts";
import { CommandError, updateSettings } from "@gigpilot/agents";
import { getDb, getTenantSettings, isOperatorTenant, paidSpendCeilingUsd } from "@gigpilot/db";
import { diffSettings } from "../settings-diff";
import { runAction } from "./run";

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Save tenant settings. Only changed leaves are sent to the command (so the
 * audit trail records what changed, not a copy of every setting), and the
 * workspace daily paid-spend limit is held under the operator ceiling:
 *   operator workspace (OPERATOR_EMAILS) → PAID_PROVIDER_DAILY_BUDGET_USD
 *   any other workspace                  → min(TENANT_MAX_DAILY_PAID_USD (default 0), server budget)
 */
export async function updateSettingsAction(patch: TenantSettingsInput) {
  return runAction(
    "settings.update",
    async (ctx) => {
      if (ctx.role !== "owner" && ctx.role !== "admin") throw new CommandError("Only owners and admins can do this.", "forbidden");
      const db = getDb();
      const current = await getTenantSettings(db, ctx.tenantId);
      const changes = diffSettings(current, patch) as TenantSettingsInput;
      if (Object.keys(changes).length === 0) return;
      const nextDaily = (changes as { limits?: { dailyPaidSpendLimitUsd?: unknown } }).limits?.dailyPaidSpendLimitUsd;
      if (nextDaily !== undefined) {
        if (typeof nextDaily !== "number" || !Number.isFinite(nextDaily)) throw new CommandError("limits.dailyPaidSpendLimitUsd: Must be a number");
        const operator = await isOperatorTenant(db, ctx.tenantId);
        const ceiling = paidSpendCeilingUsd(operator);
        if (nextDaily > ceiling) {
          throw new CommandError(
            `limits.dailyPaidSpendLimitUsd: Must be at most ${usd(ceiling)} — ${
              operator ? "the server budget (PAID_PROVIDER_DAILY_BUDGET_USD)" : "the ceiling the operator allows for workspaces (TENANT_MAX_DAILY_PAID_USD)"
            }`,
          );
        }
      }
      await updateSettings(ctx, changes);
    },
    { revalidate: ["/", "/settings", "/radar", "/costs"], limit: 20, message: "Settings saved" },
  );
}
