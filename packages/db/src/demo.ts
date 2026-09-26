import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { defaultTenantSettings, type MarketInsight, type OpportunityAnalysis, type QAFinding } from "@gigpilot/contracts";
import type { Executor } from "./client";
import {
  agentEvent,
  agentRun,
  application,
  auditEvent,
  client,
  costEstimate,
  costLedgerEntry,
  delivery,
  generation,
  job,
  market,
  marketInsight,
  notification,
  opportunity,
  opportunityAnalysis,
  opportunityScore,
  proposal,
  providerMetric,
  qaReview,
  repair,
  workflow,
  workflowStep,
  type EconomicsBreakdown,
  type MarketMetrics,
} from "./schema";

/**
 * Demo history seeder. Gives a new demo workspace ~30 days of realistic,
 * internally consistent history — delivered jobs (with workflows, runs, QA
 * incl. a failed-then-repaired check, repairs, generations, estimate-vs-actual
 * ledger within ±20%), applications at various stages, provider metrics,
 * market metrics and an initial market insight — so the dashboard is alive on
 * first login. Fresh opportunities are NOT inserted here: they arrive via the
 * mock source through the real worker pipeline.
 *
 * History rows are inserted directly at their final states (they describe the
 * past); every live status change still goes through transition().
 * Fast (bulk inserts in one transaction) and idempotent-ish: it does nothing
 * when the workspace already has jobs.
 */

type Family = "paid-social-ugc" | "image-design" | "localization-repurposing" | "ai-automation" | "web-app-builds" | "research-content";

interface StepDef {
  key: string;
  name: string;
  kind: string;
  agent: string;
  capability?: string;
  deps: string[];
}

const CREATIVE_STEPS: StepDef[] = [
  { key: "brief", name: "Creative brief", kind: "brief", agent: "copywriter", capability: "text.copy", deps: [] },
  { key: "research", name: "Audience & angle research", kind: "research", agent: "researcher", capability: "text.research", deps: ["brief"] },
  { key: "concepts", name: "Concepts, hooks & scripts", kind: "concepts", agent: "copywriter", capability: "text.copy", deps: ["research"] },
  { key: "asset_a", name: "Hero creatives — batch A", kind: "generate", agent: "creative", deps: ["concepts"] },
  { key: "asset_b", name: "Variant creatives — batch B", kind: "generate", agent: "creative", deps: ["concepts"] },
  { key: "assemble", name: "Assemble & format pack", kind: "assemble", agent: "finisher", capability: "media.finishing", deps: ["asset_a", "asset_b"] },
  { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", deps: ["assemble"] },
  { key: "finalize", name: "Final package & notes", kind: "finalize", agent: "finisher", capability: "media.finishing", deps: ["qa"] },
];

function codingSteps(agent: "automation" | "coder", capability: string): StepDef[] {
  return [
    { key: "scope", name: agent === "automation" ? "Scope systems & data flows" : "Scope pages & requirements", kind: "brief", agent, capability: "text.research", deps: [] },
    { key: "plan", name: agent === "automation" ? "Integration design" : "Architecture & page plan", kind: "concepts", agent, capability: "text.research", deps: ["scope"] },
    { key: "implement", name: agent === "automation" ? "Build the automation" : "Build the site", kind: "code", agent, capability, deps: ["plan"] },
    { key: "test", name: agent === "automation" ? "Test run & report" : "Build, tests & Lighthouse", kind: "test", agent, capability, deps: ["implement"] },
    { key: "review", name: "Independent code review (QA)", kind: "review", agent: "qa", capability: "qa.review", deps: ["test"] },
    { key: "finalize", name: "Handoff & runbook", kind: "finalize", agent: "finisher", capability: "text.copy", deps: ["review"] },
  ];
}

const LOCALIZATION_STEPS: StepDef[] = [
  { key: "brief", name: "Localisation brief", kind: "brief", agent: "localiser", capability: "text.copy", deps: [] },
  { key: "glossary", name: "Source analysis & glossary", kind: "research", agent: "localiser", capability: "text.research", deps: ["brief"] },
  { key: "translate_a", name: "Translations — Spanish", kind: "translate", agent: "localiser", capability: "text.translate", deps: ["glossary"] },
  { key: "translate_b", name: "Translations — German", kind: "translate", agent: "localiser", capability: "text.translate", deps: ["glossary"] },
  { key: "format", name: "Subtitle timing & formatting", kind: "assemble", agent: "finisher", capability: "media.finishing", deps: ["translate_a", "translate_b"] },
  { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", deps: ["format"] },
  { key: "finalize", name: "Final package & notes", kind: "finalize", agent: "finisher", capability: "media.finishing", deps: ["qa"] },
];

const RESEARCH_STEPS: StepDef[] = [
  { key: "brief", name: "Research brief", kind: "brief", agent: "researcher", capability: "text.research", deps: [] },
  { key: "research", name: "Desk research & evidence", kind: "research", agent: "researcher", capability: "text.research", deps: ["brief"] },
  { key: "outline", name: "Structure & outline", kind: "concepts", agent: "researcher", capability: "text.research", deps: ["research"] },
  { key: "draft", name: "Write the deliverable", kind: "copy", agent: "copywriter", capability: "text.copy", deps: ["outline"] },
  { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", deps: ["draft"] },
  { key: "finalize", name: "Final package & notes", kind: "finalize", agent: "finisher", capability: "text.copy", deps: ["qa"] },
];

function stepsFor(family: Family): StepDef[] {
  switch (family) {
    case "paid-social-ugc":
    case "image-design":
      return CREATIVE_STEPS;
    case "ai-automation":
      return codingSteps("automation", "code.automation");
    case "web-app-builds":
      return codingSteps("coder", "code.build");
    case "localization-repurposing":
      return LOCALIZATION_STEPS;
    default:
      return RESEARCH_STEPS;
  }
}

interface CreativeLine {
  label: string;
  capability: string;
  provider: string;
  model: string;
  units: number;
  unitCostUsd: number;
  estAttempts: number;
  /** Generations actually made (≥ units); drives the actual cost. */
  generations: number;
  aspect: string;
}

interface HistoricJob {
  family: Family;
  title: string;
  description: string;
  client: string;
  country: string;
  rating: number;
  price: number;
  budget: [number, number];
  deliveredDaysAgo: number;
  durationDays: number;
  status: "delivered" | "closed";
  creative: CreativeLine[];
  inference: { task: string; family: "gx" | "factory" | "grok"; model: string; estUsd: number; actualFactor: number };
  humanHours: number;
  deliverables: OpportunityAnalysis["deliverables"];
  repaired?: { stepKey: string; code: string; message: string; strategy: "repair" | "regenerate" | "reroute"; hint: string };
}

const JOBS: HistoricJob[] = [
  {
    family: "ai-automation",
    title: "Stripe → Xero invoice reconciliation in Make.com",
    description:
      "Reconcile Stripe payouts and invoices into Xero automatically: match charges/refunds/fees to Xero invoices, post payout clearing entries, flag mismatches to Slack and keep an audit log. Sandbox access provided.",
    client: "Copperleaf Finance",
    country: "United Kingdom",
    rating: 4.9,
    price: 2200,
    budget: [1800, 2600],
    deliveredDaysAgo: 26,
    durationDays: 6,
    status: "closed",
    creative: [],
    inference: { task: "code generation & review", family: "factory", model: "auto", estUsd: 7.8, actualFactor: 1.12 },
    humanHours: 6.5,
    deliverables: [
      { item: "Working Make.com scenario with source, tests and README", quantity: 1, format: "Exported blueprint + repo" },
      { item: "Runbook & handover", quantity: 1, format: "Markdown" },
    ],
    repaired: { stepKey: "implement", code: "failing_tests", message: "1 failing test: matches partial refunds to the original invoice", strategy: "regenerate", hint: "Handle partial refunds when matching invoices" },
  },
  {
    family: "image-design",
    title: "Product photo cleanup + 8 lifestyle composites for a candle shop",
    description: "White-background cleanup for 16 candle SKUs plus 8 cosy lifestyle composites, 2048×2048, consistent shadows. Raw photos supplied.",
    client: "Ember & Oak Candles",
    country: "United States",
    rating: 4.7,
    price: 780,
    budget: [700, 850],
    deliveredDaysAgo: 22,
    durationDays: 4,
    status: "closed",
    creative: [
      { label: "16× product retouch (1:1)", capability: "image.edit", provider: "kie", model: "google/nano-banana-edit", units: 16, unitCostUsd: 0.02, estAttempts: 1.4, generations: 21, aspect: "1:1" },
      { label: "8× lifestyle composite (1:1)", capability: "image.generate", provider: "kie", model: "nano-banana-2", units: 8, unitCostUsd: 0.04, estAttempts: 2, generations: 15, aspect: "1:1" },
    ],
    inference: { task: "art direction & prompts", family: "gx", model: "gx-code", estUsd: 0, actualFactor: 1 },
    humanHours: 4.4,
    deliverables: [
      { item: "White-background product image", quantity: 16, format: "2048×2048 PNG" },
      { item: "Lifestyle composite", quantity: 8, format: "2048×2048 JPG" },
    ],
    repaired: { stepKey: "asset_b", code: "aspect_ratio", message: "Composite #3 is 1920×1080 (16:9) but the brief requires 1:1", strategy: "repair", hint: "Re-frame to 1:1 and keep the logo inside the safe zone" },
  },
  {
    family: "paid-social-ugc",
    title: "UGC-style Reels for a cold-brew subscription (8 videos)",
    description: "8 UGC-style Reels (15s, 9:16) with captions, 3 hook variants for the top concept. Product shots and brand kit supplied.",
    client: "Riverstone Roasters",
    country: "United States",
    rating: 4.8,
    price: 1400,
    budget: [1200, 1600],
    deliveredDaysAgo: 18,
    durationDays: 7,
    status: "closed",
    creative: [
      { label: "8× 9:16 UGC-style video (15s)", capability: "video.generate", provider: "kie", model: "veo-3-1", units: 8, unitCostUsd: 0.3, estAttempts: 2.5, generations: 19, aspect: "9:16" },
    ],
    inference: { task: "hooks, scripts & prompts", family: "factory", model: "auto", estUsd: 1.9, actualFactor: 0.9 },
    humanHours: 5.3,
    deliverables: [
      { item: "UGC-style video (15s, 9:16)", quantity: 8, format: "MP4, captions burned in" },
      { item: "Hook variants + script doc", quantity: 3, format: "Markdown" },
    ],
  },
  {
    family: "web-app-builds",
    title: "Next.js site for a physio clinic (6 pages + booking link)",
    description: "Fast, accessible 6-page Next.js site from Figma designs with Lighthouse 90+, SEO metadata and a contact form with spam protection.",
    client: "Juniper Health Clinic",
    country: "Australia",
    rating: 5.0,
    price: 3200,
    budget: [2800, 3600],
    deliveredDaysAgo: 11,
    durationDays: 9,
    status: "delivered",
    creative: [],
    inference: { task: "code generation & review", family: "factory", model: "auto", estUsd: 11.4, actualFactor: 0.94 },
    humanHours: 9.1,
    deliverables: [{ item: "6-page build with source and deployment guide", quantity: 1, format: "Repository" }],
    repaired: { stepKey: "implement", code: "failing_tests", message: "1 failing check: blocks honeypot spam", strategy: "regenerate", hint: "Restore the honeypot check in the contact form" },
  },
  {
    family: "localization-repurposing",
    title: "Spanish & German subtitles for 8 onboarding videos",
    description: "SRT subtitles in Spanish and German for 8 onboarding videos (avg 2 min) using the supplied glossary; reading speed ≤ 17 cps.",
    client: "Nimbus HR",
    country: "Sweden",
    rating: 4.6,
    price: 950,
    budget: [800, 1100],
    deliveredDaysAgo: 8,
    durationDays: 5,
    status: "closed",
    creative: [],
    inference: { task: "translation & adaptation", family: "factory", model: "auto", estUsd: 1.6, actualFactor: 1.08 },
    humanHours: 3.3,
    deliverables: [{ item: "SRT subtitle file", quantity: 16, format: "SRT (UTF-8)" }],
  },
  {
    family: "research-content",
    title: "Competitor landscape: plant-based protein brands (12 brands)",
    description: "Positioning, pricing tiers, channels and review themes for 12 plant-based protein brands, with an executive summary and 5 recommendations.",
    client: "Greenleaf Grocers",
    country: "United Kingdom",
    rating: 4.8,
    price: 1300,
    budget: [1100, 1500],
    deliveredDaysAgo: 3,
    durationDays: 6,
    status: "delivered",
    creative: [],
    inference: { task: "web research", family: "grok", model: "grok-4.3", estUsd: 0.9, actualFactor: 1.1 },
    humanHours: 3.7,
    deliverables: [
      { item: "Competitor profile", quantity: 12, format: "Comparison table (Sheets)" },
      { item: "Research report with executive summary", quantity: 1, format: "PDF / Markdown" },
    ],
  },
];

interface PipelineApp {
  family: Family;
  title: string;
  client: string;
  country: string;
  price: number;
  budget: [number, number];
  status: "submitted" | "client_response" | "negotiating" | "lost";
  daysAgo: number;
  humanHours: number;
  inferenceUsd: number;
  creativeUsd: number;
}

const APPS: PipelineApp[] = [
  { family: "web-app-builds", title: "Webflow → Next.js migration for a media publication (30 pages)", client: "Lattice Robotics", country: "Netherlands", price: 4100, budget: [3500, 4500], status: "submitted", daysAgo: 1, humanHours: 12, inferenceUsd: 18, creativeUsd: 0 },
  { family: "ai-automation", title: "Lead enrichment pipeline: Typeform → Airtable → Slack", client: "Vantage Recruiting", country: "Singapore", price: 1900, budget: [1600, 2200], status: "client_response", daysAgo: 3, humanHours: 5.5, inferenceUsd: 6.2, creativeUsd: 0 },
  { family: "paid-social-ugc", title: "Creative sprint: 12 video concepts for a DTC skincare line", client: "Nova Skin Lab", country: "United Kingdom", price: 2800, budget: [2400, 3200], status: "negotiating", daysAgo: 5, humanHours: 9, inferenceUsd: 3.1, creativeUsd: 13.5 },
  { family: "image-design", title: "YouTube thumbnail designer — 12 thumbnails", client: "Trailhead Gear", country: "United States", price: 420, budget: [300, 500], status: "lost", daysAgo: 9, humanHours: 2.9, inferenceUsd: 0, creativeUsd: 0.7 },
  { family: "research-content", title: "SEO content engine: 8 long-form articles for HR software", client: "Oakridge Accounting", country: "United States", price: 1600, budget: [1400, 1800], status: "lost", daysAgo: 14, humanHours: 5.7, inferenceUsd: 4.4, creativeUsd: 0 },
];

const MARKET_METRICS: Record<Family, { metrics: MarketMetrics; recommended: number }> = {
  "ai-automation": { recommended: 35, metrics: { opportunitiesPerDay: 6.4, avgBudgetUsd: 2350, avgMargin: 0.71, avgProfitUsd: 1640, competition: 0.38, winRate: 0.34, fulfilmentReliability: 0.93, avgTurnaroundDays: 6.5, demandTrend: "up" } },
  "web-app-builds": { recommended: 20, metrics: { opportunitiesPerDay: 5.1, avgBudgetUsd: 3100, avgMargin: 0.66, avgProfitUsd: 1790, competition: 0.52, winRate: 0.24, fulfilmentReliability: 0.88, avgTurnaroundDays: 9.8, demandTrend: "flat" } },
  "paid-social-ugc": { recommended: 15, metrics: { opportunitiesPerDay: 7.8, avgBudgetUsd: 1250, avgMargin: 0.58, avgProfitUsd: 610, competition: 0.61, winRate: 0.22, fulfilmentReliability: 0.84, avgTurnaroundDays: 6.9, demandTrend: "up" } },
  "image-design": { recommended: 10, metrics: { opportunitiesPerDay: 6.2, avgBudgetUsd: 640, avgMargin: 0.55, avgProfitUsd: 330, competition: 0.66, winRate: 0.27, fulfilmentReliability: 0.86, avgTurnaroundDays: 4.2, demandTrend: "flat" } },
  "localization-repurposing": { recommended: 10, metrics: { opportunitiesPerDay: 3.4, avgBudgetUsd: 1050, avgMargin: 0.64, avgProfitUsd: 610, competition: 0.41, winRate: 0.31, fulfilmentReliability: 0.9, avgTurnaroundDays: 5.1, demandTrend: "flat" } },
  "research-content": { recommended: 10, metrics: { opportunitiesPerDay: 4.0, avgBudgetUsd: 1180, avgMargin: 0.69, avgProfitUsd: 760, competition: 0.47, winRate: 0.29, fulfilmentReliability: 0.91, avgTurnaroundDays: 6.0, demandTrend: "down" } },
};

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface Econ {
  breakdown: EconomicsBreakdown;
  creativeUsd: number;
  inferenceUsd: number;
}

function economics(input: { price: number; sourceKey: string; creative: CreativeLine[]; inference: { task: string; family: string; model: string; estUsd: number }; humanHours: number }): Econ {
  const s = defaultTenantSettings();
  const fee = s.economics.platformFees[input.sourceKey] ?? { pct: 0.1, fixedUsd: 0, minUsd: 0 };
  const lineItems: EconomicsBreakdown["lineItems"] = [
    ...input.creative.map((c) => ({
      category: "creative" as const,
      label: c.label,
      provider: c.provider,
      model: c.model,
      unit: c.capability.startsWith("video") ? "clip" : "image",
      unitCostUsd: c.unitCostUsd,
      quantity: c.units,
      attempts: c.estAttempts,
      totalUsd: r2(c.unitCostUsd * c.units * c.estAttempts),
      priceSource: "catalog 2026-09-26",
    })),
    {
      category: "inference" as const,
      label: input.inference.task,
      provider: input.inference.family,
      model: input.inference.model,
      unit: "call",
      unitCostUsd: input.inference.estUsd,
      quantity: 1,
      attempts: 1,
      totalUsd: r2(input.inference.estUsd),
      priceSource: "inference catalog",
    },
  ];
  const creativeUsd = input.creative.reduce((a, c) => a + c.unitCostUsd * c.units * c.estAttempts, 0);
  const fulfilment = creativeUsd + input.inference.estUsd;
  const revision = fulfilment * s.economics.expectedRevisionRounds * s.economics.revisionCostFraction;
  const contingency = (fulfilment + revision) * s.economics.contingencyPct;
  const shadow = input.humanHours * s.economics.shadowHourlyRateUsd;
  const fees = Math.max(input.price * fee.pct + fee.fixedUsd, fee.minUsd);
  const nonFee = fulfilment + revision + contingency + shadow;
  const total = nonFee + fees;
  return {
    creativeUsd,
    inferenceUsd: input.inference.estUsd,
    breakdown: {
      priceUsd: input.price,
      priceBasis: "proposal",
      lineItems,
      fulfilmentCostUsd: r2(fulfilment),
      revisionContingencyUsd: r2(revision),
      contingencyUsd: r2(contingency),
      shadowCostUsd: r2(shadow),
      platformFeesUsd: r2(fees),
      platformFeeKey: input.sourceKey,
      totalCostUsd: r2(total),
      grossProfitUsd: r2(input.price - total),
      grossMargin: Math.round(((input.price - total) / input.price) * 10_000) / 10_000,
      breakEvenPriceUsd: r2((nonFee + fee.fixedUsd) / (1 - fee.pct)),
      complete: true,
      missing: [],
    },
  };
}

function analysisFor(input: { family: Family; title: string; description: string; client: string; price: number; deliverables: OpportunityAnalysis["deliverables"]; creative: CreativeLine[]; inference: { task: string; family: "gx" | "factory" | "grok" }; humanHours: number; durationDays: number }): OpportunityAnalysis {
  return {
    summary: `${input.client} needs ${input.deliverables.map((d) => `${d.quantity}× ${d.item}`).join(", ")}. $${input.price.toLocaleString("en-US")} fixed; due in ${input.durationDays + 2} days.`,
    clientRequest: input.description,
    serviceFamily: input.family,
    deliverables: input.deliverables,
    suppliedAssets: ["Brand guidelines", "Source files"],
    requiredAssets: [],
    missingInputs: [],
    skills: [],
    risks: [{ kind: "revision", severity: "low", note: "One consolidated revision round agreed" }],
    deadlineDays: input.durationDays + 2,
    productionEstimates: input.creative.map((c) => ({ label: c.label, capability: c.capability as OpportunityAnalysis["productionEstimates"][number]["capability"], units: c.units, attemptsPerUnit: c.estAttempts })),
    inferenceEstimates: [{ task: input.inference.task, family: input.inference.family, kTokensIn: 20, kTokensOut: 6, calls: 12 }],
    humanHours: input.humanHours,
    billableHours: null,
    proposedWorkflow: [],
    fitScore: 0.84,
    complexity: 0.45,
    revisionRisk: 0.3,
    deadlineRisk: 0.2,
    confidence: 0.82,
    rationale: ["Deliverables clearly quantified", "Client supplied brand assets", "Comfortable timeline for the scope"],
    buyerPriorities: ["Clear documentation and handover"],
  };
}

export async function seedDemoHistory(db: Executor, tenantId: string): Promise<void> {
  const [existing] = await db.select({ n: sql<number>`count(*)::int` }).from(job).where(eq(job.tenantId, tenantId));
  if (Number(existing?.n ?? 0) > 0) return;

  const now = Date.now();
  const at = (daysAgo: number, hours = 0) => new Date(now - daysAgo * DAY + hours * 3_600_000);
  const s = defaultTenantSettings();

  const rows = {
    opportunity: [] as (typeof opportunity.$inferInsert)[],
    analysis: [] as (typeof opportunityAnalysis.$inferInsert)[],
    estimate: [] as (typeof costEstimate.$inferInsert)[],
    score: [] as (typeof opportunityScore.$inferInsert)[],
    proposal: [] as (typeof proposal.$inferInsert)[],
    client: [] as (typeof client.$inferInsert)[],
    application: [] as (typeof application.$inferInsert)[],
    job: [] as (typeof job.$inferInsert)[],
    workflow: [] as (typeof workflow.$inferInsert)[],
    step: [] as (typeof workflowStep.$inferInsert)[],
    run: [] as (typeof agentRun.$inferInsert)[],
    event: [] as (typeof agentEvent.$inferInsert)[],
    generation: [] as (typeof generation.$inferInsert)[],
    qa: [] as (typeof qaReview.$inferInsert)[],
    repair: [] as (typeof repair.$inferInsert)[],
    delivery: [] as (typeof delivery.$inferInsert)[],
    ledger: [] as (typeof costLedgerEntry.$inferInsert)[],
    audit: [] as (typeof auditEvent.$inferInsert)[],
  };

  const gates = (b: EconomicsBreakdown, budget: number) => ({
    budget: { pass: budget >= s.thresholds.preferredMinBudgetUsd, value: budget, threshold: s.thresholds.preferredMinBudgetUsd, soft: true as const },
    profit: { pass: b.grossProfitUsd >= s.thresholds.minExpectedProfitUsd, value: b.grossProfitUsd, threshold: s.thresholds.minExpectedProfitUsd },
    margin: { pass: b.grossMargin >= s.thresholds.minGrossMargin, value: b.grossMargin, threshold: s.thresholds.minGrossMargin },
    complete: { pass: true },
  });

  function addOpportunity(o: { title: string; description: string; client: string; country: string; rating: number; family: Family; budget: [number, number]; postedAt: Date; status: "won" | "applied" | "lost"; econ: Econ; analysis: OpportunityAnalysis }) {
    const id = randomUUID();
    const analysisId = randomUUID();
    const estimateId = randomUUID();
    const b = o.econ.breakdown;
    const pursue = b.grossProfitUsd >= s.thresholds.minExpectedProfitUsd && b.grossMargin >= s.thresholds.minGrossMargin;
    rows.opportunity.push({
      id,
      tenantId,
      sourceKey: "mock",
      externalId: `demo-history-${id.slice(0, 8)}`,
      title: o.title,
      description: o.description,
      clientName: o.client,
      clientCountry: o.country,
      clientRating: o.rating,
      clientSpendUsd: 18_000 + (o.title.length % 7) * 9_000,
      budgetType: "fixed",
      budgetMinUsd: o.budget[0],
      budgetMaxUsd: o.budget[1],
      skills: [],
      marketKey: o.family,
      proposalsCount: 6 + (o.title.length % 18),
      postedAt: o.postedAt,
      deadlineAt: new Date(o.postedAt.getTime() + 14 * DAY),
      expiresAt: new Date(o.postedAt.getTime() + 14 * DAY),
      status: o.status,
      dedupeHash: `demo${id.replace(/-/g, "").slice(0, 12)}`,
      raw: { demo: true, history: true },
      expectedProfitUsd: b.grossProfitUsd,
      expectedMargin: b.grossMargin,
      estimatedCostUsd: b.totalCostUsd,
      expectedFeesUsd: b.platformFeesUsd,
      priceUsd: b.priceUsd,
      overallScore: pursue ? 0.78 : 0.52,
      recommendation: pursue ? "pursue" : "consider",
      estimateComplete: true,
      createdAt: o.postedAt,
      updatedAt: o.postedAt,
    });
    rows.analysis.push({ id: analysisId, tenantId, opportunityId: id, version: 1, analysis: o.analysis, provider: "gx", model: "gx-code", createdAt: new Date(o.postedAt.getTime() + 600_000) });
    rows.estimate.push({ id: estimateId, tenantId, opportunityId: id, analysisId, breakdown: b, totalCostUsd: b.totalCostUsd, grossProfitUsd: b.grossProfitUsd, grossMargin: b.grossMargin, complete: true, createdAt: new Date(o.postedAt.getTime() + 620_000) });
    rows.score.push({
      tenantId,
      opportunityId: id,
      analysisId,
      costEstimateId: estimateId,
      fit: 0.84,
      complexity: 0.45,
      revisionRisk: 0.3,
      deadlineRisk: 0.2,
      confidence: 0.82,
      overall: pursue ? 0.78 : 0.52,
      recommendation: pursue ? "pursue" : "consider",
      gates: gates(b, o.budget[1]),
      reasons: [`Clears profit ($${Math.round(b.grossProfitUsd)} ≥ $${s.thresholds.minExpectedProfitUsd}) and margin (${Math.round(b.grossMargin * 100)}% ≥ ${Math.round(s.thresholds.minGrossMargin * 100)}%)`],
      createdAt: new Date(o.postedAt.getTime() + 620_000),
    });
    return id;
  }

  function addProposal(opportunityId: string, o: { title: string; client: string; price: number; days: number; family: Family; approvedAt: Date }) {
    const id = randomUUID();
    rows.proposal.push({
      id,
      tenantId,
      opportunityId,
      version: 1,
      headline: o.title,
      coverLetter: `Hi ${o.client} team,\n\nYou need “${o.title}”. Here's how I'd run it: agree scope and acceptance criteria on day one, deliver in two drops, and QA every file against the brief before it reaches you.\n\nPrice: $${o.price.toLocaleString("en-US")} fixed, delivered in ${o.days} days with one revision round included.\n\nThanks — happy to start as soon as you confirm.`,
      scope: [{ item: o.title, detail: "As briefed" }, { item: "One revision round", detail: "Consolidated feedback" }],
      priceUsd: o.price,
      timelineDays: o.days,
      assumptions: ["One consolidated revision round; further changes quoted as a change order."],
      questions: [],
      status: "approved",
      provider: "gx",
      model: "gx-code",
      approvedBy: null,
      approvedAt: o.approvedAt,
      createdAt: new Date(o.approvedAt.getTime() - 3_600_000),
      updatedAt: o.approvedAt,
    });
    return id;
  }

  const ev = (e: Omit<typeof agentEvent.$inferInsert, "tenantId">) => rows.event.push({ tenantId, level: "info", ...e });

  // ------------------------------------------------------------------ delivered jobs
  for (const h of JOBS) {
    const startDay = h.deliveredDaysAgo + h.durationDays;
    const postedAt = at(startDay + 2);
    const econ = economics({ price: h.price, sourceKey: "mock", creative: h.creative, inference: h.inference, humanHours: h.humanHours });
    const analysis = analysisFor({ ...h, inference: h.inference });
    const oppId = addOpportunity({ ...h, postedAt, status: "won", econ, analysis });
    const approvedAt = at(startDay + 1.5);
    const propId = addProposal(oppId, { title: h.title, client: h.client, price: h.price, days: h.durationDays + 1, family: h.family, approvedAt });
    const clientId = randomUUID();
    rows.client.push({ id: clientId, tenantId, name: h.client, sourceKey: "mock", country: h.country, createdAt: at(startDay) });
    const appId = randomUUID();
    rows.application.push({
      id: appId,
      tenantId,
      opportunityId: oppId,
      proposalId: propId,
      status: "won",
      submissionMode: "mock",
      idempotencyKey: `application:${oppId}:${propId}`,
      externalRef: `mock-${appId.slice(0, 8)}`,
      submittedAt: at(startDay + 1.4),
      decidedAt: at(startDay),
      priceUsd: h.price,
      createdAt: approvedAt,
      updatedAt: at(startDay),
    });

    const jobId = randomUUID();
    const wfId = randomUUID();
    const b = econ.breakdown;
    const estimatedCostUsd = r4(b.fulfilmentCostUsd);
    const bufferedCostUsd = r4(b.fulfilmentCostUsd + b.revisionContingencyUsd + b.contingencyUsd);
    const creativeActual = h.creative.reduce((a, c) => a + c.generations * c.unitCostUsd, 0);
    const inferenceActual = r4(h.inference.estUsd * h.inference.actualFactor);
    const actualCostUsd = r4(creativeActual + inferenceActual);
    const deliveredAt = at(h.deliveredDaysAgo);
    const startedAt = at(startDay, 1);
    const steps = stepsFor(h.family);
    const spanMs = deliveredAt.getTime() - startedAt.getTime();

    rows.job.push({
      id: jobId,
      tenantId,
      opportunityId: oppId,
      applicationId: appId,
      clientId,
      title: h.title,
      serviceFamily: h.family,
      status: h.status,
      priceUsd: h.price,
      spendLimitUsd: Math.min(s.limits.perJobSpendLimitUsd, Math.max(bufferedCostUsd * 2.5, 10)),
      estimatedCostUsd,
      actualCostUsd,
      repairCount: h.repaired ? 1 : 0,
      acceptanceCriteria: h.deliverables.map((d) => `${d.quantity}× ${d.item}${d.format ? ` (${d.format})` : ""}`),
      brief: analysis.summary,
      dueAt: new Date(startedAt.getTime() + (h.durationDays + 1) * DAY),
      startedAt,
      completedAt: deliveredAt,
      createdAt: at(startDay),
      updatedAt: deliveredAt,
    });
    rows.workflow.push({ id: wfId, tenantId, jobId, version: 1, status: "completed", plannedBy: "planner", createdAt: at(startDay, 0.5), updatedAt: deliveredAt });

    const creativeByKey: Record<string, CreativeLine | undefined> = { asset_a: h.creative[0], asset_b: h.creative[1] ?? h.creative[0] };
    const stepIds = new Map<string, string>();
    steps.forEach((st, i) => {
      const id = randomUUID();
      stepIds.set(st.key, id);
      const started = new Date(startedAt.getTime() + (spanMs * i) / steps.length);
      const finished = new Date(startedAt.getTime() + (spanMs * (i + 0.8)) / steps.length);
      const isRepaired = h.repaired?.stepKey === st.key;
      const isQa = st.agent === "qa";
      const cl = st.kind === "generate" ? creativeByKey[st.key] : undefined;
      const stepCost = cl ? (st.key === "asset_b" && h.creative.length === 1 ? 0 : cl.generations * cl.unitCostUsd) : st.kind === "code" || st.kind === "translate" || st.kind === "research" ? inferenceActual / (st.kind === "translate" ? 2 : 1) : 0;
      const attempts = isRepaired || (isQa && h.repaired) ? 2 : 1;
      rows.step.push({
        id,
        tenantId,
        workflowId: wfId,
        jobId,
        key: st.key,
        name: cl ? `${cl.label.replace(/^\d+×\s*/, "")} — batch ${st.key === "asset_a" ? "A" : "B"}` : st.name,
        kind: st.kind,
        agent: st.agent,
        capability: cl?.capability ?? st.capability ?? null,
        dependsOn: st.deps,
        status: "succeeded",
        attempts,
        maxAttempts: isQa ? s.limits.maxRepairsPerJob + 1 : s.limits.maxStepAttempts,
        provider: cl ? cl.provider : st.kind === "code" ? h.inference.family : "gx",
        model: cl ? cl.model : st.kind === "code" ? h.inference.model : "gx-code",
        estimatedCostUsd: r4(cl ? cl.units * cl.unitCostUsd * cl.estAttempts * (h.creative.length === 1 ? 0.5 : 1) : st.kind === "code" ? h.inference.estUsd : 0),
        actualCostUsd: r4(stepCost),
        acceptance: isQa ? ["Every deliverable passes format checks", "Matches the brief"] : [],
        input: { family: h.family, history: true, ...(cl ? { aspectRatio: cl.aspect, units: cl.units } : {}) },
        output: { summary: `${st.name} completed`, history: true },
        position: i,
        startedAt: started,
        finishedAt: finished,
        createdAt: at(startDay, 0.5),
        updatedAt: finished,
      });
      for (let a = 1; a <= attempts; a++) {
        const runStart = new Date(started.getTime() + (a - 1) * 3_600_000);
        rows.run.push({
          tenantId,
          agent: st.agent,
          task: `step.${st.kind}`,
          subjectType: "step",
          subjectId: id,
          jobId,
          stepId: id,
          status: "succeeded",
          attempt: a,
          provider: cl ? cl.provider : st.kind === "code" ? h.inference.family : "gx",
          model: cl ? cl.model : st.kind === "code" ? h.inference.model : "gx-code",
          inputTokens: cl ? 0 : 5200 + i * 700,
          outputTokens: cl ? 0 : 1400 + i * 210,
          costUsd: r4(a === attempts ? stepCost / attempts : stepCost / attempts),
          summary: `${st.name} ${isQa && a === 1 && h.repaired ? "found 1 issue" : "completed"}`,
          idempotencyKey: `step:${id}:${a}`,
          startedAt: runStart,
          finishedAt: new Date(runStart.getTime() + 20 * 60_000),
          createdAt: runStart,
        });
      }
    });

    // Generations (creative jobs): usable ones pass QA; extra attempts were discarded.
    for (const [key, cl] of Object.entries(creativeByKey)) {
      if (!cl || (key === "asset_b" && h.creative.length === 1)) continue;
      const stepId = stepIds.get(key)!;
      for (let g = 0; g < cl.generations; g++) {
        const usable = g < cl.units;
        const created = new Date(startedAt.getTime() + spanMs * 0.4 + g * 90_000);
        rows.generation.push({
          tenantId,
          jobId,
          stepId,
          provider: cl.provider,
          model: cl.model,
          capability: cl.capability,
          // Simulated history: excluded from provider_metric so it never steers real routing.
          params: { aspectRatio: cl.aspect, history: true, simulated: true },
          estimatedCostUsd: cl.unitCostUsd,
          actualCostUsd: cl.unitCostUsd,
          costSource: "catalog",
          status: "succeeded",
          latencyMs: cl.capability.startsWith("video") ? 112_000 + (g % 5) * 9_000 : 21_000 + (g % 5) * 3_000,
          qaPassed: usable,
          repairOfId: null,
          routeRationale: `${cl.provider}/${cl.model}: cheapest route clearing quality 0.72`,
          idempotencyKey: `demo-gen:${stepId}:${g}`,
          createdAt: created,
          updatedAt: created,
        });
      }
    }

    // QA: failed-then-repaired where applicable, then a clean independent pass.
    const reviewTargets = steps.filter((x) => ["generate", "code", "test", "translate", "research", "copy", "assemble"].includes(x.kind));
    const qaAt = new Date(startedAt.getTime() + spanMs * 0.7);
    if (h.repaired) {
      const target = stepIds.get(h.repaired.stepKey)!;
      const qaFailId = randomUUID();
      const finding: QAFinding = { code: h.repaired.code, severity: "major", message: h.repaired.message, repairHint: h.repaired.hint };
      rows.qa.push({ id: qaFailId, tenantId, jobId, stepId: target, reviewer: "qa", provider: "gx", model: "gx-mini", verdict: "fail", score: 0.61, findings: [finding], summary: h.repaired.message, attempt: 1, createdAt: qaAt });
      rows.repair.push({
        tenantId,
        jobId,
        qaReviewId: qaFailId,
        stepId: target,
        strategy: h.repaired.strategy,
        rationale: `${h.repaired.code} → ${h.repaired.strategy === "repair" ? "targeted image edit (cheapest fix; other units kept)" : "regenerate with the QA hint"}`,
        incrementalCostUsd: h.repaired.strategy === "repair" ? 0.02 : 0,
        status: "succeeded",
        attempt: 1,
        createdAt: new Date(qaAt.getTime() + 60_000),
        updatedAt: new Date(qaAt.getTime() + 3 * 3_600_000),
      });
      ev({ type: "qa.failed", level: "warn", agent: "qa", jobId, subjectType: "job", subjectId: jobId, message: `QA failed 1 check on '${h.title}': ${h.repaired.message}`, createdAt: qaAt });
      ev({ type: "repair.started", agent: "recovery", jobId, subjectType: "step", subjectId: target, message: `Repairing ${h.repaired.stepKey}: ${h.repaired.message} → ${h.repaired.strategy}`, createdAt: new Date(qaAt.getTime() + 60_000) });
      ev({ type: "repair.completed", level: "success", agent: "recovery", jobId, subjectType: "step", subjectId: target, message: `Repaired ${h.repaired.stepKey} (${h.repaired.strategy}) — independent QA now passes`, createdAt: new Date(qaAt.getTime() + 3 * 3_600_000) });
    }
    const passAt = new Date(qaAt.getTime() + (h.repaired ? 3.2 : 0.2) * 3_600_000);
    for (const t of reviewTargets) {
      rows.qa.push({ tenantId, jobId, stepId: stepIds.get(t.key)!, reviewer: "qa", provider: "gx", model: "gx-mini", verdict: "pass", score: 0.92, findings: [], summary: `${t.name}: meets the acceptance criteria`, attempt: h.repaired ? 2 : 1, createdAt: passAt });
    }
    ev({ type: "qa.passed", level: "success", agent: "qa", jobId, subjectType: "job", subjectId: jobId, message: `Independent QA passed ${reviewTargets.length}/${reviewTargets.length} deliverable checks for '${h.title}'`, createdAt: passAt });

    const deliveryId = randomUUID();
    const files = h.deliverables.map((d) => `${d.item} ×${d.quantity}`).join(", ");
    rows.delivery.push({
      id: deliveryId,
      tenantId,
      jobId,
      status: "approved",
      packageAssetId: null,
      manifest: { items: [], notes: `Delivered (archived demo history): ${files}.`, qaSummary: `${reviewTargets.length}/${reviewTargets.length} deliverable checks passed independent QA${h.repaired ? ", 1 repair applied" : ""}` },
      clientMessage: `Hi ${h.client} team, your delivery for “${h.title}” is ready — every file was checked independently against the brief.`,
      approvedBy: null,
      approvedAt: deliveredAt,
      createdAt: new Date(deliveredAt.getTime() - 5 * 3_600_000),
      updatedAt: deliveredAt,
    });

    // Ledger: estimates at award/plan time, actuals at delivery (within ±20%).
    const estAt = at(startDay, 0.6);
    const fee = b.platformFeesUsd;
    rows.ledger.push(
      { tenantId, jobId, opportunityId: oppId, category: "revenue", kind: "estimate", amountUsd: h.price, memo: "Contract value (awarded)", createdAt: at(startDay) },
      { tenantId, jobId, opportunityId: oppId, category: "marketplace_fee", kind: "estimate", provider: "mock", amountUsd: fee, memo: "Expected mock fee", createdAt: at(startDay) },
      { tenantId, jobId, opportunityId: oppId, category: "creative", kind: "estimate", amountUsd: r4(econ.creativeUsd), memo: "Planned creative production (catalog prices)", createdAt: estAt },
      { tenantId, jobId, opportunityId: oppId, category: "inference", kind: "estimate", amountUsd: r4(econ.inferenceUsd), memo: "Planned inference (catalog prices)", createdAt: estAt },
      { tenantId, jobId, opportunityId: oppId, category: "human_shadow", kind: "estimate", amountUsd: b.shadowCostUsd, memo: "Owner review & coordination time (shadow rate)", createdAt: estAt },
      { tenantId, jobId, opportunityId: oppId, category: "inference", kind: "actual", provider: h.inference.family, model: h.inference.model, amountUsd: inferenceActual, paid: false, memo: `${h.inference.task} (demo history — no real spend)`, createdAt: new Date(startedAt.getTime() + spanMs * 0.5) },
      ...(creativeActual > 0
        ? [{ tenantId, jobId, opportunityId: oppId, category: "creative" as const, kind: "actual" as const, provider: h.creative[0]!.provider, model: h.creative[0]!.model, amountUsd: r4(creativeActual), paid: false, memo: "Creative generations (demo history — no real spend)", createdAt: new Date(startedAt.getTime() + spanMs * 0.5) }]
        : []),
      { tenantId, jobId, opportunityId: oppId, category: "revenue", kind: "actual", amountUsd: h.price, memo: "Contract value (delivered)", createdAt: deliveredAt },
      { tenantId, jobId, opportunityId: oppId, category: "marketplace_fee", kind: "actual", provider: "mock", amountUsd: fee, memo: "mock fee", createdAt: deliveredAt },
    );

    ev({ type: "application.won", level: "success", agent: "client", subjectType: "application", subjectId: appId, message: `Won: ${h.title}`, createdAt: at(startDay) });
    ev({ type: "job.created", level: "success", agent: "orchestrator", jobId, subjectType: "job", subjectId: jobId, message: `Job opened: ${h.title}`, createdAt: at(startDay, 0.1) });
    ev({ type: "workflow.planned", agent: "planner", jobId, subjectType: "job", subjectId: jobId, message: `Planned ${steps.length}-step workflow for '${h.title}' — est. production $${estimatedCostUsd.toFixed(2)}`, createdAt: at(startDay, 0.5) });
    ev({ type: "delivery.prepared", level: "success", agent: "finisher", jobId, subjectType: "delivery", subjectId: deliveryId, message: `Delivery package ready for '${h.title}'`, createdAt: new Date(deliveredAt.getTime() - 5 * 3_600_000) });
    ev({ type: "cost.recorded", agent: "economics", jobId, subjectType: "job", subjectId: jobId, message: `Production cost for '${h.title}': $${actualCostUsd.toFixed(2)} actual vs $${estimatedCostUsd.toFixed(2)} estimated`, createdAt: new Date(deliveredAt.getTime() - 5 * 3_600_000) });
    ev({ type: "delivery.approved", level: "success", agent: "client", jobId, subjectType: "delivery", subjectId: deliveryId, message: "Owner approved final delivery", createdAt: deliveredAt });
    rows.audit.push(
      { tenantId, actorType: "user", action: "delivery.transition", subjectType: "delivery", subjectId: deliveryId, fromState: "prepared", toState: "approved", createdAt: deliveredAt },
      { tenantId, actorType: "user", action: "job.transition", subjectType: "job", subjectId: jobId, fromState: "awaiting_final_approval", toState: "delivered", createdAt: deliveredAt },
      ...(h.status === "closed" ? [{ tenantId, actorType: "user" as const, action: "job.transition", subjectType: "job", subjectId: jobId, fromState: "delivered", toState: "closed", createdAt: new Date(deliveredAt.getTime() + 2 * DAY) }] : []),
    );
  }

  // ------------------------------------------------------------------ applications in flight / lost
  for (const a of APPS) {
    const postedAt = at(a.daysAgo + 1.2);
    const creative: CreativeLine[] = a.creativeUsd > 0 ? [{ label: "Creative production", capability: "image.generate", provider: "kie", model: "nano-banana-2", units: Math.round(a.creativeUsd / 0.04 / 1.8), unitCostUsd: 0.04, estAttempts: 1.8, generations: 0, aspect: "1:1" }] : [];
    const econ = economics({ price: a.price, sourceKey: "mock", creative, inference: { task: "production inference", family: "factory", model: "auto", estUsd: a.inferenceUsd }, humanHours: a.humanHours });
    const analysis = analysisFor({ family: a.family, title: a.title, description: `${a.title}. Scope, deliverables and timeline as discussed in the brief.`, client: a.client, price: a.price, deliverables: [{ item: a.title, quantity: 1 }], creative, inference: { task: "production inference", family: "factory" }, humanHours: a.humanHours, durationDays: 8 });
    const oppId = addOpportunity({ title: a.title, description: analysis.clientRequest, client: a.client, country: a.country, rating: 4.7, family: a.family, budget: a.budget, postedAt, status: a.status === "lost" ? "lost" : "applied", econ, analysis });
    const approvedAt = at(a.daysAgo + 0.8);
    const propId = addProposal(oppId, { title: a.title, client: a.client, price: a.price, days: 9, family: a.family, approvedAt });
    const appId = randomUUID();
    rows.application.push({
      id: appId,
      tenantId,
      opportunityId: oppId,
      proposalId: propId,
      status: a.status,
      submissionMode: "mock",
      idempotencyKey: `application:${oppId}:${propId}`,
      externalRef: `mock-${appId.slice(0, 8)}`,
      submittedAt: at(a.daysAgo + 0.7),
      decidedAt: a.status === "lost" ? at(a.daysAgo - 0.5 < 0 ? 0 : a.daysAgo - 0.5) : null,
      priceUsd: a.price,
      notes: a.status === "negotiating" ? "Client asked for a 3-concept pilot before committing to the full sprint." : a.status === "client_response" ? "Client asked about Airtable rate limits and data retention." : null,
      createdAt: approvedAt,
      updatedAt: at(Math.max(0, a.daysAgo - 0.5)),
    });
    ev({ type: "application.submitted", level: "success", agent: "client", subjectType: "application", subjectId: appId, message: `Submitted '${a.title}' to Demo marketplace at $${a.price.toLocaleString("en-US")} (demo marketplace)`, createdAt: at(a.daysAgo + 0.7) });
    if (a.status === "lost") ev({ type: "application.lost", agent: "client", subjectType: "application", subjectId: appId, message: `Application lost: ${a.title}`, createdAt: at(Math.max(0, a.daysAgo - 0.5)) });
  }

  // ------------------------------------------------------------------ provider metrics (inference only)
  const runAgg = new Map<string, { provider: string; model: string; attempts: number; cost: number }>();
  for (const r of rows.run) {
    if (!r.provider || !r.model || ["kie", "higgsfield", "mock"].includes(r.provider)) continue;
    const k = `${r.provider}|${r.model}`;
    const m = runAgg.get(k) ?? { provider: r.provider, model: r.model, attempts: 0, cost: 0 };
    m.attempts++;
    m.cost += Number(r.costUsd ?? 0);
    runAgg.set(k, m);
  }
  // Creative metrics are NOT seeded: they feed creative routing, and simulated
  // history must never steer real provider choice.
  const metrics: (typeof providerMetric.$inferInsert)[] = [
    ...[...runAgg.values()].map((m) => ({
      tenantId,
      provider: m.provider,
      model: m.model,
      capability: "inference",
      attempts: m.attempts,
      successes: m.attempts,
      qaPasses: 0,
      repairs: 0,
      totalCostUsd: r4(m.cost),
      avgLatencyMs: 1_200_000,
      usableRate: 1,
      costPerUsableUsd: r4(m.cost / m.attempts),
    })),
  ];

  const insight: MarketInsight = {
    headline: "Shift sourcing toward AI automation",
    summary:
      "Increase AI automation sourcing allocation from 25% to 35% because average estimated profit ($1,640 vs $610) and fulfilment reliability (93%) are outperforming social creative work. Reduce paid social & UGC from 20% to 15% — competition there is high (61% of listings saturated).",
    recommendations: (Object.keys(MARKET_METRICS) as Family[]).map((k) => {
      const current = { "paid-social-ugc": 20, "image-design": 15, "localization-repurposing": 10, "ai-automation": 25, "web-app-builds": 20, "research-content": 10 }[k];
      const to = MARKET_METRICS[k].recommended;
      const m = MARKET_METRICS[k].metrics;
      return {
        marketKey: k,
        action: to > current ? ("increase" as const) : to < current ? ("decrease" as const) : ("hold" as const),
        fromPct: current,
        toPct: to,
        reason: `$${m.avgProfitUsd.toLocaleString("en-US")} avg profit, ${Math.round(m.avgMargin * 100)}% margin, ${Math.round(m.fulfilmentReliability * 100)}% QA reliability, ${m.opportunitiesPerDay}/day`,
      };
    }),
    signals: [
      { label: "Opportunities / day", value: "32.9", trend: "up" },
      { label: "Best market by profit", value: "Web & app builds · $1,790" },
      { label: "Average win rate", value: "28%" },
      { label: "Biggest move", value: "AI automation +10 pts", trend: "up" },
    ],
  };

  const run = async (tx: Executor) => {
    const chunked = async <T>(table: Parameters<Executor["insert"]>[0], values: T[]) => {
      for (let i = 0; i < values.length; i += 500) await tx.insert(table).values(values.slice(i, i + 500) as never);
    };
    await chunked(opportunity, rows.opportunity);
    await chunked(opportunityAnalysis, rows.analysis);
    await chunked(costEstimate, rows.estimate);
    await chunked(opportunityScore, rows.score);
    await chunked(proposal, rows.proposal);
    await chunked(client, rows.client);
    await chunked(application, rows.application);
    await chunked(job, rows.job);
    await chunked(workflow, rows.workflow);
    await chunked(workflowStep, rows.step);
    await chunked(agentRun, rows.run);
    await chunked(generation, rows.generation);
    await chunked(qaReview, rows.qa);
    await chunked(repair, rows.repair);
    await chunked(delivery, rows.delivery);
    await chunked(costLedgerEntry, rows.ledger);
    await chunked(providerMetric, metrics);
    rows.event.sort((x, y) => (x.createdAt as Date).getTime() - (y.createdAt as Date).getTime());
    await chunked(agentEvent, rows.event);
    for (const k of Object.keys(MARKET_METRICS) as Family[]) {
      await tx
        .update(market)
        .set({ metrics: MARKET_METRICS[k].metrics, recommendedAllocationPct: MARKET_METRICS[k].recommended })
        .where(sql`${market.tenantId} = ${tenantId} and ${market.key} = ${k}`);
    }
    await tx.insert(marketInsight).values({ tenantId, headline: insight.headline, summary: insight.summary, body: insight, provider: "gx", model: "gx-code", createdAt: at(0.2) });
    await tx.insert(agentEvent).values({ tenantId, type: "market.insight", level: "info", agent: "market_research", subjectType: "market", message: `Market research: ${insight.summary.split(". ")[0]}.`, createdAt: at(0.2) });
    await chunked(auditEvent, [
      ...rows.audit,
      { tenantId, actorType: "system", action: "tenant.demo_seeded", subjectType: "tenant", subjectId: tenantId, data: { jobs: JOBS.length, applications: APPS.length }, createdAt: new Date() },
    ]);
    await tx.insert(notification).values([
      { tenantId, kind: "info", title: "Market insight: shift sourcing toward AI automation", body: insight.summary.slice(0, 400), link: "/markets", dedupeKey: "demo-seed:insight" },
      { tenantId, kind: "success", title: `Delivered: ${JOBS[JOBS.length - 1]!.title}`, body: "The client approved the delivery package. Close the job once payment clears.", link: "/jobs", dedupeKey: "demo-seed:delivered" },
    ]);
  };

  if ("transaction" in db && typeof (db as { transaction?: unknown }).transaction === "function") {
    await (db as { transaction: (fn: (tx: Executor) => Promise<void>) => Promise<void> }).transaction(run);
  } else {
    await run(db);
  }
}
