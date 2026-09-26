import { getDb, getTenantSecret, isOperatorTenant, isShareableEnvCredential, SHAREABLE_ENV_CREDENTIALS } from "@gigpilot/db";
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
 *     → null                            (system context: server env only)
 *
 * ENV FALLBACK POLICY (security review H1) — for a tenant:
 *   1. the tenant's own encrypted secret (`getTenantSecret`), else
 *   2. the server env var of the same NAME, ONLY IF
 *        - NAME is in SHAREABLE_ENV_CREDENTIALS (the local GX gateway key), or
 *        - the tenant is an operator workspace (OPERATOR_EMAILS; ≤ 60 s cache).
 *   Marketplace tokens (Freelancer/Upwork) and paid providers
 *   (Factory/xAI/Kie/Higgsfield) never fall back for non-operator tenants.
 *   If the tenant store or the operator check fails, only shareable
 *   credentials fall back (fail closed). Tenant work MUST pass a tenantId —
 *   `null` means "system context" and reads env directly.
 *
 * `isConfigured()` reflects env-level configuration only (it is sync).
 * Resolved values are cached in memory for ≤ 60 s per (tenant, provider, name)
 * and are never logged, returned to callers outside this package, or embedded
 * in error messages.
 */

export { SHAREABLE_ENV_CREDENTIALS };

/** Tenant-stored secret only (no env fallback). */
export type TenantSecretLookup = (tenantId: string, providerKey: string, name: string) => Promise<string | undefined>;
export type OperatorTenantCheck = (tenantId: string) => Promise<boolean>;

const TTL_MS = 60_000;
const cache = new Map<string, { value: string | undefined; expires: number }>();

const defaultLookup: TenantSecretLookup = (tenantId, providerKey, name) => getTenantSecret(getDb(), tenantId, providerKey, name);
const defaultOperatorCheck: OperatorTenantCheck = (tenantId) => isOperatorTenant(getDb(), tenantId);
let lookup: TenantSecretLookup = defaultLookup;
let operatorCheck: OperatorTenantCheck = defaultOperatorCheck;

/** Dependency injection for tests (pass null to restore the DB-backed lookup). Clears the cache. */
export function setTenantSecretLookup(fn: TenantSecretLookup | null): void {
  lookup = fn ?? defaultLookup;
  cache.clear();
}

/** Dependency injection for tests (pass null to restore the DB-backed operator check). Clears the cache. */
export function setOperatorTenantCheck(fn: OperatorTenantCheck | null): void {
  operatorCheck = fn ?? defaultOperatorCheck;
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

async function envAllowedFor(tenantId: string, name: string): Promise<boolean> {
  if (isShareableEnvCredential(name)) return true;
  try {
    return await operatorCheck(tenantId);
  } catch {
    return false;
  }
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
    if (value === undefined && (await envAllowedFor(tenantId, name))) value = envValue(name);
  } catch {
    // Tenant store unavailable or decrypt failure → only shareable env credentials
    // (never surface the error text: it may echo inputs).
    value = isShareableEnvCredential(name) ? envValue(name) : undefined;
  }
  cache.set(key, { value, expires: now + TTL_MS });
  return value;
}

/**
 * The tenant's OWN stored credential, never the server env (used for
 * per-workspace secrets such as the inbound webhook secret). Not cached.
 */
export async function resolveTenantOnlyCredential(providerKey: string, name: string, tenantId: string | null | undefined): Promise<string | undefined> {
  if (!tenantId) return undefined;
  try {
    const v = await lookup(tenantId, providerKey, name);
    return v?.trim() || undefined;
  } catch {
    return undefined;
  }
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
