import "server-only";
import { getDb, getTenantSettings, sql } from "@gigpilot/db";
import type { TenantSettings } from "@gigpilot/contracts";
import { pausedStepsSummary } from "../job-blockers";
import { OWNER_BLOCK_REASONS_SQL } from "./jobs";

type Row = Record<string, unknown>;
async function q<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getDb().execute(query)) as unknown as T[];
}
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export interface NeedsYouItem {
  kind: "proposal" | "delivery" | "pursue" | "submit" | "inputs" | "blocked";
  id: string;
  title: string;
  detail: string;
  href: string;
  amountUsd: number | null;
  at: Date;
}

export interface CommandCenterData {
  settings: TenantSettings;
  counts: {
    opps24h: number;
    viable24h: number;
    pursue24h: number;
    viable7dAvg: number;
    shortlisted: number;
    proposalsAwaiting: number;
    activeJobs: number;
    awaitingFinal: number;
    jobs30d: number;
  };
  pipeline: { valueUsd: number; profitUsd: number; count: number; inProductionUsd: number };
  spend: { todayPaid: number; todaySim: number; d30Paid: number; d30Sim: number; revenue30d: number };
  accuracy: { jobs: number; meanAbsErr: number | null; withinTarget: number };
  touchpoints: { jobs: number; touches: number };
  daily: { day: string; discovered: number; viable: number; spend: number }[];
  funnel: { key: string; label: string; value: number }[];
  agents: { agent: string; runs: number; running: number; failed: number; costUsd: number; lastAt: Date | null }[];
  notifications: { id: string; kind: string; title: string; body: string; link: string | null; createdAt: Date; read: boolean }[];
  production: { id: string; title: string; status: string; done: number; total: number; running: number; actualCostUsd: number; spendLimitUsd: number; dueAt: Date | null }[];
  needsYou: NeedsYouItem[];
}

export async function getCommandCenter(tenantId: string): Promise<CommandCenterData> {
  const t = tenantId;
  const [settings, counts, pipeline, spend, accuracy, touch, daily, funnel, agents, notifs, production, proposals, deliveries, pursue, submits, blocked] = await Promise.all([
    getTenantSettings(getDb(), t),
    q(sql`
      select
        (select count(*) from opportunity where tenant_id = ${t} and created_at > now() - interval '24 hours' and duplicate_of_id is null)::int as opps24h,
        (select count(*) from opportunity where tenant_id = ${t} and created_at > now() - interval '24 hours' and estimate_complete and recommendation in ('pursue','consider'))::int as viable24h,
        (select count(*) from opportunity where tenant_id = ${t} and created_at > now() - interval '24 hours' and recommendation = 'pursue')::int as pursue24h,
        (select count(*) from opportunity where tenant_id = ${t} and created_at > now() - interval '7 days' and estimate_complete and recommendation in ('pursue','consider'))::float8 / 7 as viable7d,
        (select count(*) from opportunity where tenant_id = ${t} and status = 'shortlisted')::int as shortlisted,
        (select count(*) from proposal where tenant_id = ${t} and status = 'awaiting_approval')::int as props,
        (select count(*) from job where tenant_id = ${t} and status in ('intake','planning','awaiting_inputs','ready','executing','qa','repairing'))::int as active,
        (select count(*) from job where tenant_id = ${t} and status = 'awaiting_final_approval')::int as finals,
        (select count(*) from job where tenant_id = ${t} and created_at > now() - interval '30 days' and status <> 'cancelled')::int as jobs30d
    `),
    q(sql`
      select coalesce(sum(price_usd),0)::float8 as value, coalesce(sum(expected_profit_usd),0)::float8 as profit, count(*)::int as n,
        (select coalesce(sum(price_usd),0) from job where tenant_id = ${t} and status in ('intake','planning','awaiting_inputs','ready','executing','qa','repairing','awaiting_final_approval'))::float8 as inprod
      from opportunity where tenant_id = ${t} and status in ('shortlisted','pursuing','applied')
    `),
    q(sql`
      select
        coalesce(sum(amount_usd) filter (where paid and created_at >= date_trunc('day', now()) and category in ('inference','creative','tool','subcontractor')),0)::float8 as today_paid,
        coalesce(sum(amount_usd) filter (where not paid and created_at >= date_trunc('day', now()) and category in ('inference','creative','tool','subcontractor')),0)::float8 as today_sim,
        coalesce(sum(amount_usd) filter (where paid and created_at > now() - interval '30 days' and category in ('inference','creative','tool','subcontractor')),0)::float8 as d30_paid,
        coalesce(sum(amount_usd) filter (where not paid and created_at > now() - interval '30 days' and category in ('inference','creative','tool','subcontractor')),0)::float8 as d30_sim,
        coalesce(sum(amount_usd) filter (where category = 'revenue' and created_at > now() - interval '30 days'),0)::float8 as revenue30d
      from cost_ledger_entry where tenant_id = ${t} and kind = 'actual'
    `),
    q(sql`
      select count(*)::int as jobs,
        avg(abs(actual_cost_usd - estimated_cost_usd) / nullif(estimated_cost_usd,0))::float8 as mae,
        count(*) filter (where abs(actual_cost_usd - estimated_cost_usd) / nullif(estimated_cost_usd,0) <= 0.2)::int as within
      from job where tenant_id = ${t} and estimated_cost_usd > 0 and actual_cost_usd > 0 and status in ('awaiting_final_approval','delivered','closed')
    `),
    q(sql`
      with j as (select id, opportunity_id, application_id from job where tenant_id = ${t} and created_at > now() - interval '30 days' and status <> 'cancelled'),
      subj as (
        select j.id as job_id, j.id as sid from j
        union all select j.id, j.opportunity_id from j where j.opportunity_id is not null
        union all select j.id, j.application_id from j where j.application_id is not null
        union all select j.id, p.id from j join proposal p on p.opportunity_id = j.opportunity_id
        union all select j.id, d.id from j join delivery d on d.job_id = j.id
      )
      select (select count(*) from j)::int as jobs, count(a.id)::int as touches
      from subj s join audit_event a on a.subject_id = s.sid and a.actor_type = 'user' and a.tenant_id = ${t}
        and (a.action like '%.transition' or a.action = 'proposal.edited')
    `),
    q(sql`
      with days as (select generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') as d)
      select to_char(days.d, 'YYYY-MM-DD') as day,
        (select count(*) from opportunity o where o.tenant_id = ${t} and o.created_at >= days.d and o.created_at < days.d + interval '1 day')::int as discovered,
        (select count(*) from opportunity o where o.tenant_id = ${t} and o.created_at >= days.d and o.created_at < days.d + interval '1 day' and o.estimate_complete and o.recommendation in ('pursue','consider'))::int as viable,
        (select coalesce(sum(amount_usd),0) from cost_ledger_entry c where c.tenant_id = ${t} and c.kind = 'actual' and c.category in ('inference','creative','tool','subcontractor') and c.created_at >= days.d and c.created_at < days.d + interval '1 day')::float8 as spend
      from days order by days.d
    `),
    q(sql`
      with o as (select id, recommendation from opportunity where tenant_id = ${t} and created_at > now() - interval '30 days')
      select
        (select count(*) from o)::int as discovered,
        (select count(*) from o where recommendation is not null)::int as analysed,
        (select count(*) from o where recommendation = 'pursue')::int as pursue,
        (select count(*) from o where exists (select 1 from proposal p where p.opportunity_id = o.id))::int as proposals,
        (select count(*) from o where exists (select 1 from application a where a.opportunity_id = o.id and a.status in ('submitted','client_response','negotiating','won','lost')))::int as submitted,
        (select count(*) from o where exists (select 1 from application a where a.opportunity_id = o.id and a.status = 'won'))::int as won,
        (select count(*) from o where exists (select 1 from job j where j.opportunity_id = o.id and j.status in ('delivered','closed')))::int as delivered
    `),
    q(sql`
      select agent, count(*)::int as runs,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'failed')::int as failed,
        coalesce(sum(cost_usd),0)::float8 as cost,
        max(coalesce(finished_at, started_at, created_at)) as last_at
      from agent_run where tenant_id = ${t} and created_at > now() - interval '24 hours'
      group by agent order by count(*) filter (where status = 'running') desc, count(*) desc
    `),
    q(sql`
      select id, kind, title, body, link, created_at, read_at from notification where tenant_id = ${t}
      order by (read_at is null) desc, created_at desc limit 6
    `),
    q(sql`
      select j.id, j.title, j.status, j.actual_cost_usd::float8 as actual, j.spend_limit_usd::float8 as lim, j.due_at,
        (select count(*) from workflow_step s where s.job_id = j.id and s.status in ('succeeded','skipped'))::int as done,
        (select count(*) from workflow_step s where s.job_id = j.id and s.status <> 'cancelled')::int as total,
        (select count(*) from workflow_step s where s.job_id = j.id and s.status = 'running')::int as running
      from job j where j.tenant_id = ${t} and j.status in ('intake','planning','awaiting_inputs','ready','executing','qa','repairing','awaiting_final_approval')
      order by j.updated_at desc limit 5
    `),
    q(sql`
      select p.id, p.opportunity_id, p.price_usd::float8 as price, p.timeline_days, p.updated_at, o.title, o.source_key
      from proposal p join opportunity o on o.id = p.opportunity_id
      where p.tenant_id = ${t} and p.status = 'awaiting_approval' order by p.updated_at desc limit 5
    `),
    q(sql`
      select j.id, j.title, j.price_usd::float8 as price, j.updated_at from job j
      where j.tenant_id = ${t} and j.status = 'awaiting_final_approval' order by j.updated_at desc limit 5
    `),
    q(sql`
      select id, title, source_key, expected_profit_usd::float8 as profit, expected_margin as margin, created_at from opportunity
      where tenant_id = ${t} and recommendation = 'pursue' and status in ('analysed','shortlisted')
      order by expected_profit_usd desc nulls last limit 3
    `),
    q(sql`
      select a.id, a.price_usd::float8 as price, a.updated_at, o.title, o.source_key from application a join opportunity o on o.id = a.opportunity_id
      where a.tenant_id = ${t} and a.status = 'approved' and a.submission_mode <> 'api' order by a.updated_at desc limit 3
    `),
    // Dead-end production states that only the owner can clear (confirm inputs / authorise attempt / raise spend limit).
    q(sql`
      select j.id, j.title, j.status, j.price_usd::float8 as price, j.updated_at,
        (select count(*) from workflow_step s where s.job_id = j.id and s.status = 'blocked' and s.output->>'blockedReason' in ${OWNER_BLOCK_REASONS_SQL})::int as owner_blocked,
        (select string_agg(distinct s.output->>'blockedReason', ',') from workflow_step s where s.job_id = j.id and s.status = 'blocked' and s.output->>'blockedReason' in ${OWNER_BLOCK_REASONS_SQL}) as reasons
      from job j
      where j.tenant_id = ${t} and j.status in ('awaiting_inputs','ready','executing','qa','repairing')
        and (j.status = 'awaiting_inputs' or exists (
          select 1 from workflow_step s where s.job_id = j.id and s.status = 'blocked' and s.output->>'blockedReason' in ${OWNER_BLOCK_REASONS_SQL}
        ))
      order by j.updated_at desc limit 5
    `),
  ]);

  const c = counts[0] ?? {};
  const needsYou: NeedsYouItem[] = [
    ...blocked.map((r) => {
      const inputs = r.status === "awaiting_inputs";
      const nBlocked = n(r.owner_blocked);
      return {
        kind: inputs ? ("inputs" as const) : ("blocked" as const),
        id: String(r.id),
        title: String(r.title),
        detail: inputs ? "Production waits for you to confirm the inputs" : pausedStepsSummary(nBlocked, r.reasons ? String(r.reasons).split(",") : []),
        href: `/jobs/${r.id}`,
        amountUsd: n(r.price),
        at: new Date(r.updated_at as string),
      };
    }),
    ...deliveries.map((r) => ({
      kind: "delivery" as const,
      id: String(r.id),
      title: String(r.title),
      detail: "Final delivery ready for your review",
      href: `/jobs/${r.id}`,
      amountUsd: n(r.price),
      at: new Date(r.updated_at as string),
    })),
    ...proposals.map((r) => ({
      kind: "proposal" as const,
      id: String(r.id),
      title: String(r.title),
      detail: `Proposal · ${r.timeline_days}d timeline · commercial commitment`,
      href: `/radar/${r.opportunity_id}`,
      amountUsd: n(r.price),
      at: new Date(r.updated_at as string),
    })),
    ...submits.map((r) => ({
      kind: "submit" as const,
      id: String(r.id),
      title: String(r.title),
      detail: "Approved — submit manually on the marketplace, then mark submitted",
      href: `/applications`,
      amountUsd: n(r.price),
      at: new Date(r.updated_at as string),
    })),
    ...pursue.map((r) => ({
      kind: "pursue" as const,
      id: String(r.id),
      title: String(r.title),
      detail: `Pursue-worthy · ${Math.round(n(r.margin) * 100)}% margin`,
      href: `/radar?sel=${r.id}`,
      amountUsd: n(r.profit),
      at: new Date(r.created_at as string),
    })),
  ];

  const f = funnel[0] ?? {};
  return {
    settings,
    counts: {
      opps24h: n(c.opps24h),
      viable24h: n(c.viable24h),
      pursue24h: n(c.pursue24h),
      viable7dAvg: n(c.viable7d),
      shortlisted: n(c.shortlisted),
      proposalsAwaiting: n(c.props),
      activeJobs: n(c.active),
      awaitingFinal: n(c.finals),
      jobs30d: n(c.jobs30d),
    },
    pipeline: { valueUsd: n(pipeline[0]?.value), profitUsd: n(pipeline[0]?.profit), count: n(pipeline[0]?.n), inProductionUsd: n(pipeline[0]?.inprod) },
    spend: {
      todayPaid: n(spend[0]?.today_paid),
      todaySim: n(spend[0]?.today_sim),
      d30Paid: n(spend[0]?.d30_paid),
      d30Sim: n(spend[0]?.d30_sim),
      revenue30d: n(spend[0]?.revenue30d),
    },
    accuracy: { jobs: n(accuracy[0]?.jobs), meanAbsErr: accuracy[0]?.mae === null || accuracy[0]?.mae === undefined ? null : n(accuracy[0]?.mae), withinTarget: n(accuracy[0]?.within) },
    touchpoints: { jobs: n(touch[0]?.jobs), touches: n(touch[0]?.touches) },
    daily: daily.map((r) => ({ day: String(r.day), discovered: n(r.discovered), viable: n(r.viable), spend: n(r.spend) })),
    funnel: [
      { key: "discovered", label: "Discovered", value: n(f.discovered) },
      { key: "analysed", label: "Analysed", value: n(f.analysed) },
      { key: "pursue", label: "Pursue-worthy", value: n(f.pursue) },
      { key: "proposals", label: "Proposals drafted", value: n(f.proposals) },
      { key: "submitted", label: "Submitted", value: n(f.submitted) },
      { key: "won", label: "Won", value: n(f.won) },
      { key: "delivered", label: "Delivered", value: n(f.delivered) },
    ],
    agents: agents.map((r) => ({
      agent: String(r.agent),
      runs: n(r.runs),
      running: n(r.running),
      failed: n(r.failed),
      costUsd: n(r.cost),
      lastAt: r.last_at ? new Date(r.last_at as string) : null,
    })),
    notifications: notifs.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      title: String(r.title),
      body: String(r.body ?? ""),
      link: (r.link as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
      read: Boolean(r.read_at),
    })),
    production: production.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      status: String(r.status),
      done: n(r.done),
      total: n(r.total),
      running: n(r.running),
      actualCostUsd: n(r.actual),
      spendLimitUsd: n(r.lim),
      dueAt: r.due_at ? new Date(r.due_at as string) : null,
    })),
    needsYou,
  };
}
