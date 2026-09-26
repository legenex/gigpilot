/**
 * Illustrative product states for the marketing site. Every money figure is
 * computed by the real deterministic calculator (@gigpilot/economics) with
 * the real defaults (@gigpilot/config) — nothing here is typed in by hand.
 */
import { BUSINESS_DEFAULTS, PLATFORM_FEE_DEFAULTS, SERVICE_FAMILIES, type ServiceFamilyKey } from "@gigpilot/config/defaults";
import {
  calculateEconomics,
  chooseCreativeRoute,
  CREATIVE_CATALOG,
  GROK_WEB_SEARCH_PER_CALL_USD,
  inferenceCostUsd,
  scoreOpportunity,
  statedBudget,
  unitsFor,
  type LineItemInput,
  type Recommendation,
} from "@gigpilot/economics";

export type SourceKey = "upwork" | "freelancer" | "contra" | "fiverr" | "web" | "direct";

export const SOURCES: { key: SourceKey; label: string; short: string; mode: string; detail: string }[] = [
  { key: "upwork", label: "Upwork", short: "UPW", mode: "Official API", detail: "Official API where permitted. Polled no faster than the adapter allows." },
  { key: "freelancer", label: "Freelancer", short: "FRL", mode: "Official API", detail: "Official API. Submission only where the marketplace permits it — after your approval." },
  { key: "contra", label: "Contra", short: "CTR", mode: "Notifications", detail: "Parsed from the notifications you already receive. Commission-free for independents." },
  { key: "fiverr", label: "Fiverr", short: "FVR", mode: "Notifications", detail: "Buyer-request notifications, parsed. No scraping, no browser automation." },
  { key: "web", label: "Public feeds", short: "RSS", mode: "RSS / boards", detail: "Public RSS and job-board feeds, cached within each source's TTL." },
  { key: "direct", label: "Direct prospects", short: "DIR", mode: "Your pipeline", detail: "Leads you add or forward. Priced with card-processing fees only." },
];

const T = BUSINESS_DEFAULTS.thresholds;
const E = BUSINESS_DEFAULTS.economics;

function inf(task: string, family: "factory" | "gx" | "grok", kIn: number, kOut: number, calls: number): LineItemInput {
  const model = family === "gx" ? "gx-code" : family === "grok" ? "grok-4.3" : "auto";
  return {
    category: "inference",
    label: task,
    provider: family,
    model,
    unit: "call",
    unitCostUsd: inferenceCostUsd(family, model, kIn * 1000, kOut * 1000),
    quantity: calls,
    attempts: 1,
    priceSource: "inference catalog",
  };
}

function creative(label: string, provider: string, model: string, qty: number, attempts: number): LineItemInput {
  const opt = CREATIVE_CATALOG.find((o) => o.provider === provider && o.model === model);
  return {
    category: "creative",
    label,
    provider,
    model,
    unit: opt?.unit ?? "unit",
    unitCostUsd: opt?.unitCostUsd ?? null,
    quantity: qty * (opt ? unitsFor(opt) : 1),
    attempts,
    priceSource: "catalog",
  };
}

function tool(label: string, usd: number, qty = 1): LineItemInput {
  return { category: "tool", label, provider: null, model: null, unit: "unit", unitCostUsd: usd, quantity: qty, attempts: 1, priceSource: "quote" };
}

interface OppSeed {
  id: string;
  title: string;
  family: ServiceFamilyKey;
  source: SourceKey;
  budget: { type: "fixed" | "hourly"; min: number; max: number; hours?: number };
  lineItems: LineItemInput[];
  shadowHours: number;
  signals: { fit: number; complexity: number; revisionRisk: number; deadlineRisk: number; confidence: number; highRisks: number };
  posted: string;
  deliverables: string[];
  risks: string[];
}

const SEEDS: OppSeed[] = [
  {
    id: "op_7f3a",
    title: "Meta ad creative sprint — 12 UGC-style variants",
    family: "paid-social-ugc",
    source: "upwork",
    budget: { type: "fixed", min: 1800, max: 2400 },
    lineItems: [
      creative("9:16 UGC clips (8s)", "kie", "veo-3-1", 24, 1.7),
      creative("Hook stills", "higgsfield", "higgsfield-ai/soul/v2/standard", 36, 1.4),
      inf("Scripts & hooks", "factory", 8, 2, 30),
      inf("Frame QA", "gx", 6, 1, 40),
      tool("Music licence", 15),
    ],
    shadowHours: 3,
    signals: { fit: 0.86, complexity: 0.45, revisionRisk: 0.35, deadlineRisk: 0.2, confidence: 0.81, highRisks: 0 },
    posted: "4m",
    deliverables: ["12 × 9:16 UGC-style videos, 15s", "36 hook stills", "Captions + 3 headline variants each"],
    risks: ["Brand guidelines not attached — ask before production"],
  },
  {
    id: "op_2c91",
    title: "n8n lead-qualification agent for HubSpot",
    family: "ai-automation",
    source: "freelancer",
    budget: { type: "fixed", min: 1200, max: 1800 },
    lineItems: [inf("Build & test workflow", "factory", 20, 6, 40), inf("Classifier evals", "gx", 4, 1, 200), tool("n8n cloud, 1 month", 24)],
    shadowHours: 5,
    signals: { fit: 0.9, complexity: 0.55, revisionRisk: 0.3, deadlineRisk: 0.25, confidence: 0.78, highRisks: 0 },
    posted: "11m",
    deliverables: ["Lead-scoring workflow (n8n)", "HubSpot property sync", "Runbook + Loom walkthrough"],
    risks: ["HubSpot tier unknown — API limits may apply"],
  },
  {
    id: "op_91be",
    title: "Localise 8 explainer videos into ES / DE / PT-BR",
    family: "localization-repurposing",
    source: "contra",
    budget: { type: "fixed", min: 1400, max: 1400 },
    lineItems: [tool("Dubbing minutes", 0.3, 60), tool("Native-speaker review, 3 languages", 150), inf("Transcreation", "factory", 6, 3, 24)],
    shadowHours: 3,
    signals: { fit: 0.78, complexity: 0.4, revisionRisk: 0.4, deadlineRisk: 0.3, confidence: 0.74, highRisks: 0 },
    posted: "26m",
    deliverables: ["24 localised cuts", "Burned-in + SRT subtitles", "Glossary per language"],
    risks: ["Source project files may not be provided"],
  },
  {
    id: "op_c04d",
    title: "Airtable → Postgres migration + ops dashboard",
    family: "web-app-builds",
    source: "upwork",
    budget: { type: "fixed", min: 3000, max: 4000 },
    lineItems: [inf("Schema + migration code", "factory", 20, 6, 120), inf("Data checks", "gx", 4, 1, 300), tool("Managed Postgres, 1 month", 25)],
    shadowHours: 8,
    signals: { fit: 0.82, complexity: 0.7, revisionRisk: 0.35, deadlineRisk: 0.3, confidence: 0.72, highRisks: 1 },
    posted: "38m",
    deliverables: ["Migrated schema + data", "Ops dashboard (Next.js)", "Rollback plan"],
    risks: ["Touches production data — high severity"],
  },
  {
    id: "op_5e17",
    title: "EU e-bike market: competitor research brief",
    family: "research-content",
    source: "upwork",
    budget: { type: "hourly", min: 45, max: 60, hours: 10 },
    lineItems: [inf("Live web research", "grok", 20, 4, 30), tool("Grok web search calls", GROK_WEB_SEARCH_PER_CALL_USD, 120), inf("Synthesis", "factory", 30, 8, 6)],
    shadowHours: 2.5,
    signals: { fit: 0.8, complexity: 0.35, revisionRisk: 0.25, deadlineRisk: 0.2, confidence: 0.76, highRisks: 0 },
    posted: "52m",
    deliverables: ["20-page brief", "Competitor pricing table", "Source list with citations"],
    risks: [],
  },
  {
    id: "op_e8a2",
    title: "Product photo set — 40 SKUs, white + lifestyle",
    family: "image-design",
    source: "fiverr",
    budget: { type: "fixed", min: 450, max: 450 },
    lineItems: [creative("Background edits", "kie", "google/nano-banana-edit", 80, 1.6)],
    shadowHours: 3,
    signals: { fit: 0.7, complexity: 0.3, revisionRisk: 0.5, deadlineRisk: 0.35, confidence: 0.8, highRisks: 0 },
    posted: "1h",
    deliverables: ["80 product images", "Retouch pass"],
    risks: ["20% marketplace commission"],
  },
  {
    id: "op_3b6c",
    title: "30 TikTok hook scripts, 24-hour turnaround",
    family: "paid-social-ugc",
    source: "freelancer",
    budget: { type: "fixed", min: 180, max: 180 },
    lineItems: [inf("Hook writing", "factory", 4, 1, 30)],
    shadowHours: 1.5,
    signals: { fit: 0.75, complexity: 0.2, revisionRisk: 0.45, deadlineRisk: 0.6, confidence: 0.82, highRisks: 0 },
    posted: "1h",
    deliverables: ["30 hook scripts"],
    risks: ["Tight deadline"],
  },
  {
    id: "op_a7d0",
    title: "Weekly LinkedIn content engine for a B2B SaaS",
    family: "research-content",
    source: "direct",
    budget: { type: "fixed", min: 1200, max: 1200 },
    lineItems: [inf("Drafts", "factory", 8, 3, 40), inf("Trend research", "grok", 20, 4, 20), creative("Post graphics", "higgsfield", "higgsfield-ai/soul/v2/standard", 12, 1.3)],
    shadowHours: 3,
    signals: { fit: 0.84, complexity: 0.35, revisionRisk: 0.3, deadlineRisk: 0.2, confidence: 0.79, highRisks: 0 },
    posted: "2h",
    deliverables: ["12 posts / month", "Graphics", "Performance recap"],
    risks: [],
  },
  {
    id: "op_b812",
    title: "Support RAG bot over 300 help-centre articles",
    family: "ai-automation",
    source: "freelancer",
    budget: { type: "fixed", min: 1800, max: 2400 },
    lineItems: [inf("Build + evals", "factory", 20, 6, 70), inf("Chunking + embeddings QA", "gx", 6, 1, 400), tool("Vector DB, 1 month", 25)],
    shadowHours: 5,
    signals: { fit: 0.88, complexity: 0.55, revisionRisk: 0.35, deadlineRisk: 0.25, confidence: 0.77, highRisks: 0 },
    posted: "6m",
    deliverables: ["Retrieval bot + widget", "Eval set, 60 questions", "Handover doc"],
    risks: ["Help-centre export format unknown"],
  },
  {
    id: "op_6f05",
    title: "Figma → Next.js marketing site, 6 pages",
    family: "web-app-builds",
    source: "direct",
    budget: { type: "fixed", min: 4500, max: 4500 },
    lineItems: [inf("Build pages", "factory", 20, 6, 90), creative("Section imagery", "kie", "nano-banana-2", 24, 1.5), inf("Visual QA", "gx", 6, 1, 120)],
    shadowHours: 8,
    signals: { fit: 0.85, complexity: 0.5, revisionRisk: 0.4, deadlineRisk: 0.3, confidence: 0.8, highRisks: 0 },
    posted: "19m",
    deliverables: ["6 responsive pages", "CMS wiring", "Lighthouse ≥ 90 report"],
    risks: [],
  },
  {
    id: "op_d3c9",
    title: "Podcast repurposing — 20 captioned vertical shorts",
    family: "localization-repurposing",
    source: "upwork",
    budget: { type: "fixed", min: 500, max: 700 },
    lineItems: [tool("Transcription minutes", 0.02, 240), inf("Clip selection", "factory", 12, 2, 20), tool("Caption render minutes", 0.05, 40)],
    shadowHours: 2.5,
    signals: { fit: 0.8, complexity: 0.3, revisionRisk: 0.35, deadlineRisk: 0.3, confidence: 0.8, highRisks: 0 },
    posted: "44m",
    deliverables: ["20 × 9:16 shorts", "Burned-in captions", "Hook titles"],
    risks: [],
  },
  {
    id: "op_4d12",
    title: "Brand refresh: logo system + social kit",
    family: "image-design",
    source: "contra",
    budget: { type: "fixed", min: 900, max: 900 },
    lineItems: [creative("Concept boards", "kie", "nano-banana-2", 60, 1.8), inf("Brand rationale", "factory", 8, 3, 10)],
    shadowHours: 4,
    signals: { fit: 0.52, complexity: 0.5, revisionRisk: 0.55, deadlineRisk: 0.25, confidence: 0.7, highRisks: 0 },
    posted: "3h",
    deliverables: ["Logo system", "Social kit, 12 templates"],
    risks: ["Subjective approval criteria"],
  },
];

export interface RadarRow {
  id: string;
  title: string;
  family: string;
  source: (typeof SOURCES)[number];
  budgetLabel: string;
  priceUsd: number;
  costUsd: number;
  profitUsd: number;
  margin: number;
  feesUsd: number;
  shadowUsd: number;
  fulfilmentUsd: number;
  contingencyUsd: number;
  breakEvenUsd: number;
  recommendation: Recommendation;
  reasons: string[];
  gates: { margin: boolean; profit: boolean; budget: boolean };
  score: number;
  posted: string;
  deliverables: string[];
  risks: string[];
}

function money(n: number) {
  return `$${n.toLocaleString("en-US")}`;
}

function kilo(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function radarRows(): RadarRow[] {
  return SEEDS.map((s) => {
    const fee = PLATFORM_FEE_DEFAULTS[s.source] ?? PLATFORM_FEE_DEFAULTS["direct"]!;
    const econ = calculateEconomics({
      price: {
        budgetType: s.budget.type,
        budgetMinUsd: s.budget.min,
        budgetMaxUsd: s.budget.max,
        billableHours: s.budget.hours ?? null,
        hourlyRateUsd: E.defaultHourlyRateUsd,
      },
      lineItems: s.lineItems,
      platformFee: { key: s.source, pct: fee.pct, fixedUsd: fee.fixedUsd, minUsd: fee.minUsd },
      revision: { expectedRounds: E.expectedRevisionRounds, costFraction: E.revisionCostFraction },
      contingencyPct: E.contingencyPct,
      shadow: { hours: s.shadowHours, hourlyRateUsd: E.shadowHourlyRateUsd },
    });
    const score = scoreOpportunity(econ, s.signals, T, statedBudget(s.budget.min, s.budget.max));
    const family = SERVICE_FAMILIES.find((f) => f.key === s.family)!;
    const budgetLabel =
      s.budget.type === "hourly"
        ? `${money(s.budget.min)}–${s.budget.max}/hr`
        : s.budget.min === s.budget.max
          ? money(s.budget.min)
          : `$${kilo(s.budget.min)}–${kilo(s.budget.max)}`;
    return {
      id: s.id,
      title: s.title,
      family: family.name,
      source: SOURCES.find((x) => x.key === s.source)!,
      budgetLabel,
      priceUsd: econ.priceUsd,
      costUsd: econ.totalCostUsd,
      profitUsd: econ.grossProfitUsd,
      margin: econ.grossMargin,
      feesUsd: econ.platformFeesUsd,
      shadowUsd: econ.shadowCostUsd,
      fulfilmentUsd: econ.fulfilmentCostUsd,
      contingencyUsd: econ.contingencyUsd + econ.revisionContingencyUsd,
      breakEvenUsd: econ.breakEvenPriceUsd,
      recommendation: score.recommendation,
      reasons: score.reasons,
      gates: { margin: score.gates.margin.pass, profit: score.gates.profit.pass, budget: score.gates.budget.pass },
      score: score.overall,
      posted: s.posted,
      deliverables: s.deliverables,
      risks: s.risks,
    };
  });
}

/** Completed jobs for the hero ticker — the pursued rows, as delivered. */
export function deliveredJobs() {
  const short: Record<string, string> = {
    op_7f3a: "UGC ad set · 12 variants",
    op_2c91: "Lead-qualification agent",
    op_91be: "Explainers → ES/DE/PT-BR",
    op_a7d0: "LinkedIn content engine",
    op_c04d: "Airtable → Postgres",
    op_4d12: "Brand refresh kit",
  };
  return radarRows()
    .filter((r) => r.profitUsd >= T.minExpectedProfitUsd && r.margin >= T.minGrossMargin && short[r.id])
    .map((r) => ({ id: r.id, title: short[r.id]!, profitUsd: Math.round(r.profitUsd), margin: r.margin }));
}

/* ---------------------------------------------------------------- Market -- */

/** Recommended allocation after a (illustrative) market-research run. Sums to 100. */
const RECOMMENDED: Record<ServiceFamilyKey, number> = {
  "paid-social-ugc": 24,
  "image-design": 12,
  "localization-repurposing": 7,
  "ai-automation": 31,
  "web-app-builds": 19,
  "research-content": 7,
};

export function allocation() {
  return SERVICE_FAMILIES.map((f) => ({
    key: f.key,
    name: f.name,
    current: f.defaultAllocationPct,
    recommended: RECOMMENDED[f.key],
  }));
}

/* ---------------------------------------------------------------- Broker -- */

export type BrokerCapability = "image.generate" | "video.generate";

export function brokerOptions(capability: BrokerCapability) {
  const durationSec = capability === "video.generate" ? 8 : undefined;
  return CREATIVE_CATALOG.filter((o) => o.capability === capability).map((o) => {
    const units = unitsFor(o, durationSec);
    const perRequest = o.unitCostUsd === null ? null : o.unitCostUsd * units;
    const perUsable = perRequest === null ? null : perRequest / Math.max(0.05, o.usableRatePrior);
    return {
      provider: o.provider,
      model: o.model,
      perRequest,
      perUsable,
      quality: o.qualityPrior,
      usable: o.usableRatePrior,
    };
  });
}

export function brokerChoice(capability: BrokerCapability, qualityThreshold: number) {
  return chooseCreativeRoute(capability, {
    qualityThreshold,
    preference: BUSINESS_DEFAULTS.routing.creativeProviderPreference,
    durationSec: capability === "video.generate" ? 8 : undefined,
  });
}

export const DEFAULTS = BUSINESS_DEFAULTS;
export const FEES = PLATFORM_FEE_DEFAULTS;
