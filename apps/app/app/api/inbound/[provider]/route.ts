import { CommandError, ingestInboundOpportunity } from "@gigpilot/agents";
import { and, decryptSecret, eq, getDb, idempotencyKey, lt, providerSecret, secretAad, sourceIntegration, sql, tenant } from "@gigpilot/db";
import { INBOUND_SECRET_NAME, INBOUND_SECRET_PROVIDER_KEY } from "@gigpilot/providers";
import { handleInbound, type InboundDeps } from "@/lib/inbound-webhook";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One query for tenant + its inbound secret, so known and unknown slugs cost the same. */
async function loadTenantSecret(slug: string): Promise<{ tenantId: string; secret: string } | null> {
  const rows = await getDb()
    .select({ tenantId: tenant.id, ciphertext: providerSecret.ciphertext })
    .from(tenant)
    .leftJoin(
      providerSecret,
      and(eq(providerSecret.tenantId, tenant.id), eq(providerSecret.providerKey, INBOUND_SECRET_PROVIDER_KEY), eq(providerSecret.name, INBOUND_SECRET_NAME)),
    )
    .where(eq(tenant.slug, slug))
    .limit(1);
  const r = rows[0];
  if (!r?.ciphertext) return null;
  try {
    return { tenantId: r.tenantId, secret: decryptSecret(r.ciphertext, secretAad(r.tenantId, INBOUND_SECRET_PROVIDER_KEY, INBOUND_SECRET_NAME)) };
  } catch {
    return null;
  }
}

const deps: InboundDeps = {
  rateLimit,
  loadTenantSecret,
  async claimReplay(key, tenantId, provider) {
    const db = getDb();
    const claimed = await db.insert(idempotencyKey).values({ key, tenantId, scope: "inbound", result: { provider } }).onConflictDoNothing().returning({ key: idempotencyKey.key });
    if (claimed.length) {
      // Signatures older than the ±300 s window can never verify again: prune them (best effort).
      void db
        .delete(idempotencyKey)
        .where(and(eq(idempotencyKey.scope, "inbound"), eq(idempotencyKey.tenantId, tenantId), lt(idempotencyKey.createdAt, sql`now() - interval '15 minutes'`)))
        .catch(() => undefined);
    }
    return claimed.length > 0;
  },
  async releaseReplay(key) {
    await getDb()
      .delete(idempotencyKey)
      .where(eq(idempotencyKey.key, key))
      .catch(() => undefined);
  },
  async sourceEnabled(tenantId, sourceKey) {
    const [src] = await getDb()
      .select({ enabled: sourceIntegration.enabled })
      .from(sourceIntegration)
      .where(and(eq(sourceIntegration.tenantId, tenantId), eq(sourceIntegration.sourceKey, sourceKey)))
      .limit(1);
    return src ? src.enabled : null;
  },
  ingest: (tenantId, raw, provider, meta) => ingestInboundOpportunity(tenantId, raw, provider, meta),
  classifyError(err) {
    if (err instanceof CommandError) return { kind: err.code === "conflict" ? "conflict" : "invalid", message: err.message };
    return { kind: "other" };
  },
  log: (entry) => console.error(JSON.stringify(entry)),
};

/**
 * Forwarded marketplace notifications (the owner's own emails via an
 * email→webhook relay), signed per workspace. See lib/inbound-webhook.ts for
 * the scheme; the Integrations page documents it with a curl example.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return handleInbound(request, provider, deps);
}
