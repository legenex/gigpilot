import type { ProviderHealth } from "@gigpilot/contracts";

/**
 * STUB — zero-cost connection test for any integration key (owner:
 * integrations agent). Never spends money; never returns secrets.
 */
export async function checkIntegration(key: string, _tenantId: string | null): Promise<ProviderHealth> {
  return { status: "needs_configuration", detail: `${key}: health check not implemented yet`, checkedAt: new Date().toISOString() };
}
