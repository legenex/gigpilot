import "server-only";
import { and, costLedgerEntry, desc, eq, getDb, getTenantSettings, gte, job, opportunity, sql } from "@gigpilot/db";

type SQL = ReturnType<typeof eq>;
const CATEGORIES = ["inference", "creative", "tool", "marketplace_fee", "subcontractor", "human_shadow", "revenue"] as const;
export type LedgerCategory = (typeof CATEGORIES)[number];

export interface CostFilters {
  category?: LedgerCategory;
  kind?: "estimate" | "actual";
  paid?: "paid" | "sim";
  days: 7 | 30 | 90;
}

export function parseCostFilters(sp: Record<string, string | string[] | undefined>): CostFilters {
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const days = Number(s("days"));
  return {
    category: (CATEGORIES as readonly string[]).includes(s("category") ?? "") ? (s("category") as LedgerCategory) : undefined,
    kind: s("kind") === "estimate" || s("kind") === "actual" ? (s("kind") as "estimate" | "actual") : undefined,
    paid: s("paid") === "paid" || s("paid") === "sim" ? (s("paid") as "paid" | "sim") : undefined,
    days: days === 7 || days === 90 ? days : 30,
  };
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function getCosts(tenantId: string, f: CostFilters) {
  const db = getDb();
  const since = sql`now() - make_interval(days => ${f.days})`;
  const conds: SQL[] = [eq(costLedgerEntry.tenantId, tenantId), gte(costLedgerEntry.createdAt, since as never)];
  if (f.category) conds.push(eq(costLedgerEntry.category, f.category));
  if (f.kind) conds.push(eq(costLedgerEntry.kind, f.kind));
  if (f.paid) conds.push(eq(costLedgerEntry.paid, f.paid === "paid"));

  const [totalsRows, daily, jobs, opps, ledger, settings] = await Promise.all([
    db.execute(sql`
      select
        coalesce(sum(amount_usd) filter (where kind = 'actual' and category in ('inference','creative','tool','subcontractor')), 0)::float8 as prod_actual,
        coalesce(sum(amount_usd) filter (where kind = 'estimate' and category in ('inference','creative','tool','subcontractor')), 0)::float8 as prod_est,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and paid and category in ('inference','creative','tool','subcontractor')), 0)::float8 as prod_paid,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and not paid and category in ('inference','creative','tool','subcontractor')), 0)::float8 as prod_sim,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and category = 'revenue'), 0)::float8 as revenue,
        coalesce(sum(amount_usd) filter (where kind = 'estimate' and category = 'revenue'), 0)::float8 as revenue_est,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and category = 'marketplace_fee'), 0)::float8 as fees,
        coalesce(sum(amount_usd) filter (where kind = 'estimate' and category = 'human_shadow'), 0)::float8 as shadow_est,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and category = 'inference'), 0)::float8 as inf,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and category = 'creative'), 0)::float8 as cre,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and category in ('tool','subcontractor')), 0)::float8 as tool,
        coalesce(sum(amount_usd) filter (where kind = 'actual' and paid and category in ('inference','creative','tool','subcontractor') and created_at >= date_trunc('day', now())), 0)::float8 as paid_today,
        count(*)::int as entries
      from cost_ledger_entry where tenant_id = ${tenantId} and created_at >= ${since}
    `) as unknown as Promise<Record<string, unknown>[]>,
    db.execute(sql`
      with days as (select generate_series(date_trunc('day', now()) - make_interval(days => ${f.days - 1}), date_trunc('day', now()), interval '1 day') as d)
      select to_char(days.d, 'YYYY-MM-DD') as day,
        coalesce(sum(c.amount_usd) filter (where c.category = 'inference'), 0)::float8 as inference,
        coalesce(sum(c.amount_usd) filter (where c.category = 'creative'), 0)::float8 as creative,
        coalesce(sum(c.amount_usd) filter (where c.category in ('tool','subcontractor')), 0)::float8 as tool,
        coalesce(sum(c.amount_usd) filter (where c.paid), 0)::float8 as paid
      from days left join cost_ledger_entry c on c.tenant_id = ${tenantId} and c.kind = 'actual' and c.category in ('inference','creative','tool','subcontractor')
        and c.created_at >= days.d and c.created_at < days.d + interval '1 day'
      group by days.d order by days.d
    `) as unknown as Promise<Record<string, unknown>[]>,
    db.execute(sql`
      select j.id, j.title, j.status, j.price_usd::float8 as price, j.estimated_cost_usd::float8 as est, j.actual_cost_usd::float8 as act,
        coalesce((select sum(amount_usd) from cost_ledger_entry l where l.job_id = j.id and l.kind = 'actual' and l.category = 'marketplace_fee'), 0)::float8 as fees,
        coalesce((select sum(amount_usd) from cost_ledger_entry l where l.job_id = j.id and l.kind = 'actual' and l.paid and l.category in ('inference','creative','tool','subcontractor')), 0)::float8 as paid
      from job j where j.tenant_id = ${tenantId} order by j.created_at desc limit 25
    `) as unknown as Promise<Record<string, unknown>[]>,
    db.execute(sql`
      select o.id, o.title, o.source_key, o.status, o.price_usd::float8 as price, o.estimated_cost_usd::float8 as est, o.expected_fees_usd::float8 as fees,
        o.expected_profit_usd::float8 as profit, o.expected_margin as margin, o.estimate_complete as complete,
        coalesce((select sum(amount_usd) from cost_ledger_entry l where l.opportunity_id = o.id and l.kind = 'actual' and l.job_id is null), 0)::float8 as spent
      from opportunity o where o.tenant_id = ${tenantId} and o.status in ('shortlisted','pursuing','applied','won') and o.price_usd is not null
      order by o.expected_profit_usd desc nulls last limit 15
    `) as unknown as Promise<Record<string, unknown>[]>,
    db
      .select({
        id: costLedgerEntry.id,
        category: costLedgerEntry.category,
        kind: costLedgerEntry.kind,
        provider: costLedgerEntry.provider,
        model: costLedgerEntry.model,
        amountUsd: costLedgerEntry.amountUsd,
        paid: costLedgerEntry.paid,
        memo: costLedgerEntry.memo,
        createdAt: costLedgerEntry.createdAt,
        jobId: costLedgerEntry.jobId,
        opportunityId: costLedgerEntry.opportunityId,
        jobTitle: job.title,
        oppTitle: opportunity.title,
      })
      .from(costLedgerEntry)
      .leftJoin(job, eq(job.id, costLedgerEntry.jobId))
      .leftJoin(opportunity, eq(opportunity.id, costLedgerEntry.opportunityId))
      .where(and(...conds))
      .orderBy(desc(costLedgerEntry.createdAt))
      .limit(200),
    getTenantSettings(db, tenantId),
  ]);
  const t = totalsRows[0] ?? {};
  return {
    settings,
    totals: {
      prodActual: n(t.prod_actual),
      prodEstimate: n(t.prod_est),
      prodPaid: n(t.prod_paid),
      prodSim: n(t.prod_sim),
      revenue: n(t.revenue),
      revenueEstimate: n(t.revenue_est),
      fees: n(t.fees),
      shadowEstimate: n(t.shadow_est),
      inference: n(t.inf),
      creative: n(t.cre),
      tool: n(t.tool),
      paidToday: n(t.paid_today),
      entries: n(t.entries),
    },
    daily: daily.map((r) => ({ day: String(r.day), inference: n(r.inference), creative: n(r.creative), tool: n(r.tool), paid: n(r.paid) })),
    jobs: jobs.map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status), price: n(r.price), est: n(r.est), act: n(r.act), fees: n(r.fees), paid: n(r.paid) })),
    opps: opps.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      sourceKey: String(r.source_key),
      status: String(r.status),
      price: n(r.price),
      est: n(r.est),
      fees: n(r.fees),
      profit: n(r.profit),
      margin: n(r.margin),
      complete: r.complete !== false,
      spent: n(r.spent),
    })),
    ledger,
  };
}
