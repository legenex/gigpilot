import { getSessionContext } from "@gigpilot/auth";
import { and, desc, eq, getDb, job, opportunity, or, sql } from "@gigpilot/db";
import { rateLimit } from "@/lib/rate-limit";
import { SOURCE_SHORT } from "@/lib/labels";

export const dynamic = "force-dynamic";

/** Command-palette search over the tenant's opportunities and jobs. */
export async function GET(request: Request) {
  const ctx = await getSessionContext(request.headers);
  if (!ctx) return Response.json({ hits: [] }, { status: 401 });
  if (ctx.mustChangePassword) return Response.json({ hits: [] }, { status: 403 });
  if (!rateLimit(`search:${ctx.user.id}`, 120, 60_000).ok) return Response.json({ hits: [] }, { status: 429 });
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return Response.json({ hits: [] });
  const pattern = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const db = getDb();
  const [opps, jobs] = await Promise.all([
    db
      .select({ id: opportunity.id, title: opportunity.title, sourceKey: opportunity.sourceKey, clientName: opportunity.clientName, status: opportunity.status })
      .from(opportunity)
      .where(and(eq(opportunity.tenantId, ctx.tenantId), or(sql`${opportunity.title} ilike ${pattern}`, sql`${opportunity.clientName} ilike ${pattern}`)))
      .orderBy(desc(opportunity.createdAt))
      .limit(8),
    db
      .select({ id: job.id, title: job.title, status: job.status })
      .from(job)
      .where(and(eq(job.tenantId, ctx.tenantId), sql`${job.title} ilike ${pattern}`))
      .orderBy(desc(job.createdAt))
      .limit(4),
  ]);
  return Response.json(
    {
      hits: [
        ...jobs.map((j) => ({ kind: "job", id: j.id, title: j.title, hint: `job · ${j.status.replace(/_/g, " ")}` })),
        ...opps.map((o) => ({ kind: "opportunity", id: o.id, title: o.title, hint: `${SOURCE_SHORT[o.sourceKey] ?? o.sourceKey} · ${o.status}` })),
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
