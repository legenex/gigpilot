"use server";

import {
  CommandError,
  clearProviderSecret,
  recordIntegrationHealth,
  saveProviderSecret,
  setProviderEnabled,
  setSourceEnabled,
  triggerSourceRefresh,
  type CommandContext,
} from "@gigpilot/agents";
import { integrationByKey } from "@gigpilot/contracts";
import { and, audit, eq, getDb, saveTenantSecret, sourceIntegration } from "@gigpilot/db";
import { INBOUND_SECRET_NAME, INBOUND_SECRET_PROVIDER_KEY, checkIntegration, clearCredentialCache, getSourceAdapter } from "@gigpilot/providers";
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
        .select({ key: sourceIntegration.sourceKey, lastSyncAt: sourceIntegration.lastSyncAt })
        .from(sourceIntegration)
        .where(and(eq(sourceIntegration.tenantId, ctx.tenantId), eq(sourceIntegration.enabled, true)));
      // Mirror the Scout's source-policy throttle so the toast says what the stream will say.
      const now = Date.now();
      const throttled: { name: string; waitMin: number }[] = [];
      let queued = 0;
      for (const r of rows) {
        const caps = getSourceAdapter(r.key)?.capabilities;
        const elapsed = r.lastSyncAt ? (now - r.lastSyncAt.getTime()) / 60_000 : Infinity;
        if (caps && caps.canSearch && elapsed < caps.minPollIntervalMinutes) {
          throttled.push({ name: getSourceAdapter(r.key)?.name ?? r.key, waitMin: Math.ceil(caps.minPollIntervalMinutes - elapsed) });
        } else if (!caps || caps.canSearch) {
          queued += 1;
        }
        await triggerSourceRefresh(ctx, r.key);
      }
      return { count: rows.length, queued, throttled };
    },
    { revalidate: ["/radar", "/"], limit: 6 },
  );
}

/**
 * Zero-cost connection test via the providers package, persisted through the
 * `recordIntegrationHealth` command. Returns only secret-free health fields.
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
      await recordIntegrationHealth(ctx, key, { ...health, detail, latencyMs });
      return { status: health.status, detail, latencyMs };
    },
    { revalidate: PATHS, limit: 12 },
  );
}

/** A browser-generated inbound secret: "gpwh_" + 32 random bytes as hex. */
const INBOUND_SECRET_FORMAT = /^gpwh_[0-9a-f]{64}$/;

/**
 * Store (or rotate) this workspace's inbound webhook secret. The secret is
 * generated in the owner's browser (crypto.getRandomValues) and shown there
 * exactly once; the server only ever receives it, encrypts it (AES-256-GCM,
 * AAD-bound to tenant|inbound|INBOUND_WEBHOOK_SECRET) and never returns it —
 * afterwards only the last-4 hint is displayed. Rotation invalidates the old
 * secret immediately.
 */
export async function rotateInboundSecretAction(secret: string) {
  return runAction(
    "inbound.rotate",
    async (ctx) => {
      requireOperator(ctx);
      if (typeof secret !== "string" || !INBOUND_SECRET_FORMAT.test(secret)) throw new CommandError("Invalid secret format — generate a new one.");
      const db = getDb();
      await db.transaction(async (tx) => {
        await saveTenantSecret(tx, ctx.tenantId, INBOUND_SECRET_PROVIDER_KEY, INBOUND_SECRET_NAME, secret);
        await audit(tx, { tenantId: ctx.tenantId, actor: { type: "user", id: ctx.userId }, action: "credential.saved", subjectType: "provider", data: { providerKey: INBOUND_SECRET_PROVIDER_KEY, name: INBOUND_SECRET_NAME, rotated: true } });
      });
      clearCredentialCache(ctx.tenantId);
    },
    { revalidate: PATHS, limit: 10, message: "Inbound secret saved — copy it now, it won't be shown again" },
  );
}
