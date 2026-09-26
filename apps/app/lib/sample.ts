/** Client-safe sample-history predicate (see lib/queries/tenant.ts). */
export function isSample(createdAt: Date | string | null | undefined, tenantCreatedAt: Date | string | null | undefined): boolean {
  if (!createdAt || !tenantCreatedAt) return false;
  return new Date(createdAt).getTime() < new Date(tenantCreatedAt).getTime();
}

/** Notifications written by the demo seed carry a "demo-seed:" dedupe key. */
export function isSampleNotification(dedupeKey: string | null | undefined): boolean {
  return Boolean(dedupeKey?.startsWith("demo-seed:"));
}
