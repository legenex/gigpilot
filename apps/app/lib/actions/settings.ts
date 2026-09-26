"use server";

import type { TenantSettingsInput } from "@gigpilot/contracts";
import { updateSettings } from "@gigpilot/agents";
import { runAction } from "./run";

export async function updateSettingsAction(patch: TenantSettingsInput) {
  return runAction(
    "settings.update",
    async (ctx) => {
      await updateSettings(ctx, patch);
    },
    { revalidate: ["/", "/settings", "/radar", "/costs"], limit: 20, message: "Settings saved" },
  );
}
