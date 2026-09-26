import "server-only";
import { OPPORTUNITY_STATES, type OpportunityState } from "@gigpilot/contracts";
import { and, asc, desc, eq, getDb, gte, inArray, lte, market, ne, opportunity, opportunityScore, or, sql } from "@gigpilot/db";

type SQL = ReturnType<typeof eq>;

export const RADAR_VIEWS = ["pursue", "review", "all"] as const;
export type RadarView = (typeof RADAR_VIEWS)[number];

export const SORT_KEYS = [
  "source",
  "title",
  "client",
  "market",
  "budget",
  "deadline",
  "age",
  "cost",
  "fees",
  "profit",
  "margin",
  "fit",
  "complexity",
  "rrisk",
  "drisk",
  "confidence",
  "rec",
  "status",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface RadarFilters {
  view: RadarView;
  q?: string;
  source?: string;
  market?: string;
  status?: OpportunityState;
  bmin?: number;
  bmax?: number;
  pmin?: number;
  /** margin minimum in percent (0–100) */
  mmin?: number;
  /** maximum acceptable risk level */
  risk?: "low" | "medium";
  /** confidence minimum in percent */
  cmin?: number;
  /** max age in hours */
  age?: number;
  sort: SortKey;
  dir: "asc" | "desc";
  sel?: string;
}

type SP = Record<string, string | string[] | undefined>;
const str = (sp: SP, k: string) => {
  const v = sp[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const num = (sp: SP, k: string) => {
  const v = str(sp, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const UUID = /^[0-9a-f-]{36}$/i;

export function parseRadarFilters(sp: SP): RadarFilters {
  const view = (RADAR_VIEWS as readonly string[]).includes(str(sp, "view") ?? "") ? (str(sp, "view") as RadarView) : "pursue";
  const sort = (SORT_KEYS as readonly string[]).includes(str(sp, "sort") ?? "") ? (str(sp, "sort") as SortKey) : view === "all" ? "age" : "profit";
  const status = str(sp, "status");
  const risk = str(sp, "risk");
  const sel = str(sp, "sel");
  return {
    view,
    q: str(sp, "q")?.slice(0, 120),
    source: str(sp, "source"),
    market: str(sp, "market"),
    status: status && (OPPORTUNITY_STATES as readonly string[]).includes(status) ? (status as OpportunityState) : undefined,
    bmin: num(sp, "bmin"),
    bmax: num(sp, "bmax"),
    pmin: num(sp, "pmin"),
    mmin: num(sp, "mmin"),
    risk: risk === "low" || risk === "medium" ? risk : undefined,
    cmin: num(sp, "cmin"),
    age: num(sp, "age"),
    sort,
    dir: str(sp, "dir") === "asc" ? "asc" : str(sp, "dir") === "desc" ? "desc" : sort === "age" || sort === "title" || sort === "source" || sort === "client" || sort === "deadline" ? "asc" : "desc",
    sel: sel && UUID.test(sel) ? sel : undefined,
  };
}

export interface RadarRow {
  id: string;
  sourceKey: string;
  url: string | null;
  title: string;
  clientName: string | null;
  marketKey: string | null;
  marketName: string | null;
  budgetType: string;
  budgetMinUsd: number | null;
  budgetMaxUsd: number | null;
  deadlineAt: Date | null;
  postedAt: Date | null;
  createdAt: Date;
  estimatedCostUsd: number | null;
  expectedFeesUsd: number | null;
  expectedProfitUsd: number | null;
  expectedMargin: number | null;
  priceUsd: number | null;
  fit: number | null;
  complexity: number | null;
  revisionRisk: number | null;
  deadlineRisk: number | null;
  confidence: number | null;
  recommendation: "pursue" | "consider" | "skip" | null;
  overallScore: number | null;
  status: OpportunityState;
  estimateComplete: boolean | null;
}

function viewCondition(view: RadarView): SQL | undefined {
  if (view === "pursue") return and(eq(opportunity.recommendation, "pursue"), inArray(opportunity.status, ["analysed", "shortlisted"]));
  if (view === "review")
    return and(
      inArray(opportunity.status, ["new", "analysing", "analysed", "shortlisted", "pursuing"]),
      or(
        eq(opportunity.recommendation, "consider"),
        eq(opportunity.estimateComplete, false),
        inArray(opportunity.status, ["shortlisted", "pursuing", "new", "analysing"]),
      ),
    );
  return ne(opportunity.status, "archived");
}

export async function getRadar(tenantId: string, f: RadarFilters) {
  const db = getDb();
  const ls = db
    .select({
      fit: opportunityScore.fit,
      complexity: opportunityScore.complexity,
      revisionRisk: opportunityScore.revisionRisk,
      deadlineRisk: opportunityScore.deadlineRisk,
      confidence: opportunityScore.confidence,
    })
    .from(opportunityScore)
    .where(eq(opportunityScore.opportunityId, opportunity.id))
    .orderBy(desc(opportunityScore.createdAt))
    .limit(1)
    .as("ls");

  const conds: SQL[] = [eq(opportunity.tenantId, tenantId)];
  if (f.status) conds.push(eq(opportunity.status, f.status));
  else {
    const v = viewCondition(f.view);
    if (v) conds.push(v);
  }
  if (f.q) {
    const pattern = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(or(sql`${opportunity.title} ilike ${pattern}`, sql`${opportunity.clientName} ilike ${pattern}`, sql`${opportunity.description} ilike ${pattern}`)!);
  }
  if (f.source) conds.push(eq(opportunity.sourceKey, f.source));
  if (f.market) conds.push(eq(opportunity.marketKey, f.market));
  if (f.bmin !== undefined) conds.push(gte(sql`coalesce(${opportunity.budgetMaxUsd}, ${opportunity.budgetMinUsd}, ${opportunity.priceUsd}, 0)`, f.bmin));
  if (f.bmax !== undefined) conds.push(lte(sql`coalesce(${opportunity.budgetMinUsd}, ${opportunity.budgetMaxUsd}, ${opportunity.priceUsd}, 0)`, f.bmax));
  if (f.pmin !== undefined) conds.push(gte(opportunity.expectedProfitUsd, f.pmin));
  if (f.mmin !== undefined) conds.push(gte(opportunity.expectedMargin, f.mmin / 100));
  if (f.cmin !== undefined) conds.push(gte(ls.confidence, f.cmin / 100));
  if (f.risk) conds.push(lte(sql`greatest(${ls.revisionRisk}, ${ls.deadlineRisk})`, f.risk === "low" ? 0.34 : 0.67));
  if (f.age !== undefined) conds.push(gte(sql`coalesce(${opportunity.postedAt}, ${opportunity.createdAt})`, sql`now() - make_interval(hours => ${Math.round(f.age)})`));

  const sortExpr: Record<SortKey, SQL | ReturnType<typeof sql>> = {
    source: sql`${opportunity.sourceKey}`,
    title: sql`lower(${opportunity.title})`,
    client: sql`lower(${opportunity.clientName})`,
    market: sql`${opportunity.marketKey}`,
    budget: sql`coalesce(${opportunity.budgetMaxUsd}, ${opportunity.budgetMinUsd})`,
    deadline: sql`${opportunity.deadlineAt}`,
    age: sql`now() - coalesce(${opportunity.postedAt}, ${opportunity.createdAt})`,
    cost: sql`${opportunity.estimatedCostUsd}`,
    fees: sql`${opportunity.expectedFeesUsd}`,
    profit: sql`${opportunity.expectedProfitUsd}`,
    margin: sql`${opportunity.expectedMargin}`,
    fit: sql`${ls.fit}`,
    complexity: sql`${ls.complexity}`,
    rrisk: sql`${ls.revisionRisk}`,
    drisk: sql`${ls.deadlineRisk}`,
    confidence: sql`${ls.confidence}`,
    rec: sql`${opportunity.overallScore}`,
    status: sql`${opportunity.status}`,
  };
  const order = f.dir === "asc" ? sql`${sortExpr[f.sort]} asc nulls last` : sql`${sortExpr[f.sort]} desc nulls last`;

  const baseTenant = eq(opportunity.tenantId, tenantId);
  const [rows, totalRows, counts, markets, sources] = await Promise.all([
    db
      .select({
        id: opportunity.id,
        sourceKey: opportunity.sourceKey,
        url: opportunity.url,
        title: opportunity.title,
        clientName: opportunity.clientName,
        marketKey: opportunity.marketKey,
        marketName: market.name,
        budgetType: opportunity.budgetType,
        budgetMinUsd: opportunity.budgetMinUsd,
        budgetMaxUsd: opportunity.budgetMaxUsd,
        deadlineAt: opportunity.deadlineAt,
        postedAt: opportunity.postedAt,
        createdAt: opportunity.createdAt,
        estimatedCostUsd: opportunity.estimatedCostUsd,
        expectedFeesUsd: opportunity.expectedFeesUsd,
        expectedProfitUsd: opportunity.expectedProfitUsd,
        expectedMargin: opportunity.expectedMargin,
        priceUsd: opportunity.priceUsd,
        fit: ls.fit,
        complexity: ls.complexity,
        revisionRisk: ls.revisionRisk,
        deadlineRisk: ls.deadlineRisk,
        confidence: ls.confidence,
        recommendation: opportunity.recommendation,
        overallScore: opportunity.overallScore,
        status: opportunity.status,
        estimateComplete: opportunity.estimateComplete,
      })
      .from(opportunity)
      .leftJoinLateral(ls, sql`true`)
      .leftJoin(market, and(eq(market.tenantId, opportunity.tenantId), eq(market.key, opportunity.marketKey)))
      .where(and(...conds))
      .orderBy(order, asc(opportunity.id))
      .limit(250),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunity)
      .leftJoinLateral(ls, sql`true`)
      .where(and(...conds)),
    Promise.all(RADAR_VIEWS.map((v) => db.select({ n: sql<number>`count(*)::int` }).from(opportunity).where(and(baseTenant, viewCondition(v))))),
    db.select({ key: market.key, name: market.name }).from(market).where(eq(market.tenantId, tenantId)).orderBy(asc(market.name)),
    db.selectDistinct({ key: opportunity.sourceKey }).from(opportunity).where(baseTenant),
  ]);

  return {
    rows: rows as RadarRow[],
    total: totalRows[0]?.n ?? 0,
    counts: { pursue: counts[0]?.[0]?.n ?? 0, review: counts[1]?.[0]?.n ?? 0, all: counts[2]?.[0]?.n ?? 0 },
    markets,
    sources: sources.map((s) => s.key).sort(),
  };
}
