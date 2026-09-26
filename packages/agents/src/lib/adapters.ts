/**
 * Tenant-scoped adapter helpers. Adapters are tenant-agnostic singletons;
 * tenant-stored credentials are honoured via `isConfiguredFor(tenantId)` and
 * `withTenant(tenantId)` (used for calls whose signature carries no tenant,
 * e.g. `health()` and `submit()`).
 */

type TenantAware<T> = {
  isConfiguredFor?: (tenantId: string | null) => Promise<boolean>;
  withTenant?: (tenantId: string | null) => T;
};

export async function isConfiguredFor(adapter: { isConfigured(): boolean }, tenantId: string | null | undefined): Promise<boolean> {
  const fn = (adapter as TenantAware<unknown>).isConfiguredFor;
  if (typeof fn === "function") {
    try {
      return await fn.call(adapter, tenantId ?? null);
    } catch {
      return adapter.isConfigured();
    }
  }
  return adapter.isConfigured();
}

export function forTenant<T extends object>(adapter: T, tenantId: string | null | undefined): T {
  const fn = (adapter as TenantAware<T>).withTenant;
  return typeof fn === "function" ? fn.call(adapter, tenantId ?? null) : adapter;
}

/** Live creative provider keys configured for the tenant, when the broker supports tenant resolution. */
export async function configuredCreativeProviders(broker: object, tenantId: string): Promise<string[] | undefined> {
  const fn = (broker as { configuredProviders?: (t: string) => Promise<string[]> }).configuredProviders;
  return typeof fn === "function" ? fn.call(broker, tenantId) : undefined;
}
