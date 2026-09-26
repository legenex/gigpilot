"use server";

import {
  CommandError,
  clearProviderSecret,
  saveProviderSecret,
  setProviderEnabled,
  setSourceEnabled,
  triggerSourceRefresh,
  type CommandContext,
} from "@gigpilot/agents";
import { SOURCE_KEYS, integrationByKey } from "@gigpilot/contracts";
import { and, eq, getDb, providerIntegration, sourceIntegration } from "@gigpilot/db";
import { checkIntegration, clearCredentialCache } from "@gigpilot/providers";
import { runAction } from "./run";

const PATHS = ["/integrations", "/"];

function requireOperator(ctx: CommandContext) {
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new CommandError("Only owners and admins can do this.", "forbidden");
}

export async function saveSecretAction(providerKey: string, name: string, value: string) {
  return runAction(
    "secret.save",
    async (ctx) => {
      await saveProviderSecret(ctx, providerKey, name, value);
      clearCredentialCache(ctx.tenantId);
    },
    { revalidate: PATHS, limit: 20, message: "Credential saved (encrypted)" },
  );
}

export async function clearSecretAction(providerKey: string, name?: string) {
  return runAction(
    "secret.clear",
    async (ctx) => {
      await clearProviderSecret(ctx, providerKey, name);
      clearCredentialCache(ctx.tenantId);
    },
    { revalidate: PATHS, limit: 20, message: "Credential removed" },
  );
}

export async function setSourceEnabledAction(sourceKey: string, enabled: boolean) {
  return runAction("source.toggle", (ctx) => setSourceEnabled(ctx, sourceKey, enabled), { revalidate: PATHS, message: enabled ? "Source enabled" : "Source disabled" });
}

export async function setProviderEnabledAction(providerKey: string, enabled: boolean) {
  return runAction("provider.toggle", (ctx) => setProviderEnabled(ctx, providerKey, enabled), { revalidate: PATHS, message: enabled ? "Provider enabled" : "Provider disabled" });
}

/** User-directed refresh of a single source (the only permitted way to search Upwork). */
export async function refreshSourceAction(sourceKey: string) {
  return runAction("source.refresh", (ctx) => triggerSourceRefresh(ctx, sourceKey), { revalidate: PATHS, limit: 12, message: "Refresh queued — the Scout will pull new opportunities" });
}

/** Refresh every enabled source (command palette / radar). */
export async function refreshAllSourcesAction() {
  return runAction(
    "source.refresh-all",
    async (ctx) => {
      const rows = await getDb()
        .select({ key: sourceIntegration.sourceKey })
        .from(sourceIntegration)
        .where(and(eq(sourceIntegration.tenantId, ctx.tenantId), eq(sourceIntegration.enabled, true)));
      for (const r of rows) await triggerSourceRefresh(ctx, r.key);
      return { count: rows.length };
    },
    { revalidate: ["/radar", "/"], limit: 6, message: "Refresh queued for enabled sources" },
  );
}

/**
 * Zero-cost connection test via the providers package, persisted to the
 * tenant's integration row. Returns only secret-free health fields.
 */
export async function testConnectionAction(key: string) {
  return runAction(
    "integration.test",
    async (ctx) => {
      requireOperator(ctx);
      if (!integrationByKey(key)) throw new CommandError("Unknown integration");
      const started = Date.now();
      const health = await checkIntegration(key, ctx.tenantId);
      const latencyMs = health.latencyMs ?? Date.now() - started;
      const detail = String(health.detail ?? "").slice(0, 500);
      const db = getDb();
      if ((SOURCE_KEYS as readonly string[]).includes(key)) {
        await db
          .update(sourceIntegration)
          .set({ status: health.status, statusDetail: detail, lastError: health.status === "error" ? detail : null })
          .where(and(eq(sourceIntegration.tenantId, ctx.tenantId), eq(sourceIntegration.sourceKey, key)));
      } else {
        await db
          .update(providerIntegration)
          .set({ status: health.status, statusDetail: detail, latencyMs, meta: health.meta ?? null, lastCheckAt: new Date() })
          .where(and(eq(providerIntegration.tenantId, ctx.tenantId), eq(providerIntegration.providerKey, key)));
      }
      return { status: health.status, detail, latencyMs };
    },
    { revalidate: PATHS, limit: 12 },
  );
}
