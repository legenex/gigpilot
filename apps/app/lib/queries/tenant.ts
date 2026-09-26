import "server-only";
import { cache } from "react";
import { getDb, sql } from "@gigpilot/db";

/**
 * Seeded sample history: the demo seed backdates rows to before the
 * workspace existed. Anything created before the tenant's `created_at` is
 * sample data — badged "Sample" and excluded from every KPI and total.
 */
export function sampleCutoffSql(tenantId: string) {
  return sql`(select t0.created_at from tenant t0 where t0.id = ${tenantId})`;
}

export interface TenantMeta {
  createdAt: Date;
  /** Seeded sample rows still present (jobs, applications, ledger, runs, events, insights). */
  hasSample: boolean;
}

export const getTenantMeta = cache(async (tenantId: string): Promise<TenantMeta> => {
  const cut = sampleCutoffSql(tenantId);
  const rows = (await getDb().execute(sql`
    select (select created_at from tenant where id = ${tenantId}) as created_at,
      (exists (select 1 from job where tenant_id = ${tenantId} and created_at < ${cut})
        or exists (select 1 from application where tenant_id = ${tenantId} and created_at < ${cut})
        or exists (select 1 from opportunity where tenant_id = ${tenantId} and created_at < ${cut})
        or exists (select 1 from cost_ledger_entry where tenant_id = ${tenantId} and created_at < ${cut})
        or exists (select 1 from market_insight where tenant_id = ${tenantId} and created_at < ${cut})) as has_sample
  `)) as unknown as { created_at: string | Date | null; has_sample: boolean }[];
  const r = rows[0];
  return { createdAt: r?.created_at ? new Date(r.created_at) : new Date(0), hasSample: Boolean(r?.has_sample) };
});
