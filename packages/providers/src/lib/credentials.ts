import { getDb, resolveSecret } from "@gigpilot/db";
import { envValue } from "./config";

/**
 * Credential resolution shared by every adapter in @gigpilot/providers.
 *
 * APPROACH (identical in every adapter):
 *   Adapters are constructed once with zero args and are tenant-agnostic.
 *   Each call resolves credentials for an effective tenant:
 *       adapter.withTenant(tenantId)   (bound tenant — used by health() and
 *                                        submit(), whose signatures carry no tenant)
 *     → request context tenant          (IntelligenceRequest.context.tenantId,
 *                                        CreativeRequest.context.tenantId,
 *                                        fetchOpportunities({ tenantId }))
 *     → null                            (server env only)
 *   For a tenant, `resolveSecret(getDb(), tenantId, providerKey, NAME)` returns
 *   the tenant's encrypted secret, else the env var of the same NAME.
 *   `isConfigured()` reflects env-level configuration only (it is sync).
 *
 * Resolved values are cached in memory for ≤ 60 s per (tenant, provider, name)
 * and are never logged, returned to callers outside this package, or embedded
 * in error messages. If the database is unreachable we fall back to env.
 */

export type TenantSecretLookup = (tenantId: string, providerKey: string, name: string) => Promise<string | undefined>;

const TTL_MS = 60_000;
const cache = new Map<string, { value: string | undefined; expires: number }>();

const defaultLookup: TenantSecretLookup = (tenantId, providerKey, name) => resolveSecret(getDb(), tenantId, providerKey, name);
let lookup: TenantSecretLookup = defaultLookup;

/** Dependency injection for tests (pass null to restore the DB-backed lookup). Clears the cache. */
export function setTenantSecretLookup(fn: TenantSecretLookup | null): void {
  lookup = fn ?? defaultLookup;
  cache.clear();
}

/** Drop cached credentials (call after a tenant saves/clears a secret). */
export function clearCredentialCache(tenantId?: string): void {
  if (!tenantId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) if (key.startsWith(`${tenantId}\u0000`)) cache.delete(key);
}

export async function resolveCredential(providerKey: string, name: string, tenantId?: string | null): Promise<string | undefined> {
  if (!tenantId) return envValue(name);
  const key = `${tenantId}\u0000${providerKey}\u0000${name}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  let value: string | undefined;
  try {
    value = await lookup(tenantId, providerKey, name);
    if (value !== undefined) value = value.trim() || undefined;
  } catch {
    // DB unavailable or decrypt failure → server env (never surface the error text: it may echo inputs).
    value = envValue(name);
  }
  cache.set(key, { value, expires: now + TTL_MS });
  return value;
}

/** Resolve several names at once. */
export async function resolveCredentials<N extends string>(providerKey: string, names: readonly N[], tenantId?: string | null): Promise<Record<N, string | undefined>> {
  const out = {} as Record<N, string | undefined>;
  await Promise.all(
    names.map(async (n) => {
      out[n] = await resolveCredential(providerKey, n, tenantId);
    }),
  );
  return out;
}

/** "tenant" when the value differs from the server env value, else "env". Never returns the value. */
export function credentialSource(name: string, value: string | undefined): "tenant" | "env" | "none" {
  if (!value) return "none";
  return envValue(name) === value ? "env" : "tenant";
}
