/**
 * DEV-ONLY fixture loader for designing the dashboard against realistic data.
 * Never imported by the app. Inserts rows for ONE tenant (found by user email).
 *
 *   set -a; . ./.env; set +a
 *   apps/app/node_modules/.bin/tsx apps/app/scripts/dev-fixtures.ts --email you@example.com [--reset] [--live]
 *
 * --reset  delete this tenant's fixture-able rows first (opportunities, jobs, runs, events, ledger…)
 * --live   after loading, keep emitting agent events / advancing a running step every few seconds
 *          (exercises the SSE stream). Ctrl-C to stop.
 *
 * Money figures come from @gigpilot/economics (estimateOpportunity + scoreOpportunity)
 * so gates, margins and recommendations are internally consistent.
 */
import { crc32, deflateSync } from "node:zlib";
import type { OpportunityAnalysis, WorkflowStepPlan } from "@gigpilot/contracts";
import {
  agentEvent,
  agentRun,
  application,
  asset,
  auditEvent,
  closeDb,
  costEstimate,
  costLedgerEntry,
  delivery,
  eq,
  getDb,
  getTenantSettings,
  job,
  market,
  marketInsight,
  membership,
  notification,
  opportunity,
  opportunityAnalysis,
  opportunityScore,
  proposal,
  providerIntegration,
  providerMetric,
  qaReview,
  repair,
  revision,
  sourceIntegration,
  sql,
  user,
  workflow,
  workflowStep,
  generation,
  client as clientTable,
  and,
} from "@gigpilot/db";
import { dedupeHash, estimateOpportunity, scoreOpportunity, statedBudget } from "@gigpilot/economics";
import { getStorage } from "@gigpilot/providers/storage";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

const EMAIL = arg("email");
if (!EMAIL) {
  console.error("usage: dev-fixtures.ts --email <user email> [--reset] [--live]");
  process.exit(1);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
let rngState = 42;
const rnd = () => {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number) => a + rnd() * (b - a);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface Tpl {
  market: string;
  title: string;
  client: string;
  country: string;
  desc: string;
  budgetType: "fixed" | "hourly" | "unknown";
  bmin: number | null;
  bmax: number | null;
  skills: string[];
  analysis: Omit<OpportunityAnalysis, "summary" | "clientRequest" | "serviceFamily"> & { summary: string; clientRequest: string };
}

const wf = {
  ugc: (): WorkflowStepPlan[] => [
    { key: "brief", name: "Creative brief & hooks", kind: "brief", agent: "copywriter", dependsOn: [], acceptance: ["Brief covers audience, offer, 3+ hooks"] },
    { key: "scripts", name: "Scripts (15s)", kind: "copy", agent: "copywriter", capability: "text.copy", dependsOn: ["brief"], acceptance: ["6 scripts, ≤ 40 words each"] },
    { key: "keyframes", name: "Keyframes", kind: "generate", agent: "creative", capability: "image.generate", dependsOn: ["brief"], acceptance: ["9:16, brand colours"] },
    { key: "video", name: "Video generation", kind: "generate", agent: "creative", capability: "video.image_to_video", dependsOn: ["scripts", "keyframes"], acceptance: ["15s, 9:16, no artefacts"] },
    { key: "finish", name: "Captions & finishing", kind: "assemble", agent: "finisher", capability: "media.finishing", dependsOn: ["video"], acceptance: ["Burned-in captions", "Safe zones respected"] },
    { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["finish"], acceptance: ["All acceptance criteria met"] },
    { key: "deliver", name: "Package delivery", kind: "deliver", agent: "finisher", dependsOn: ["qa"], acceptance: ["Zip with MP4s + captions"] },
  ],
  image: (): WorkflowStepPlan[] => [
    { key: "brief", name: "Art direction", kind: "brief", agent: "creative", dependsOn: [], acceptance: ["Moodboard + shot list"] },
    { key: "concepts", name: "Concept frames", kind: "concepts", agent: "creative", capability: "image.generate", dependsOn: ["brief"], acceptance: ["3 directions"] },
    { key: "generate", name: "Final renders", kind: "generate", agent: "creative", capability: "image.generate", dependsOn: ["concepts"], acceptance: ["4:5 and 1:1 crops"] },
    { key: "retouch", name: "Retouch & upscale", kind: "assemble", agent: "finisher", capability: "image.edit", dependsOn: ["generate"], acceptance: ["2048px, clean edges"] },
    { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["retouch"], acceptance: ["Matches brief"] },
    { key: "deliver", name: "Package delivery", kind: "deliver", agent: "finisher", dependsOn: ["qa"], acceptance: ["PNG + JPG exports"] },
  ],
  automation: (): WorkflowStepPlan[] => [
    { key: "brief", name: "Requirements & mapping", kind: "brief", agent: "automation", dependsOn: [], acceptance: ["Trigger/action map"] },
    { key: "build", name: "Build workflow", kind: "code", agent: "coder", capability: "code.automation", dependsOn: ["brief"], acceptance: ["Runs end-to-end on sample data"] },
    { key: "prompts", name: "LLM prompts", kind: "copy", agent: "automation", capability: "text.copy", dependsOn: ["brief"], acceptance: ["Deterministic JSON output"] },
    { key: "test", name: "Test suite", kind: "test", agent: "coder", capability: "code.build", dependsOn: ["build", "prompts"], acceptance: ["10 fixtures pass"] },
    { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["test"], acceptance: ["Handles errors & retries"] },
    { key: "deliver", name: "Handover docs", kind: "deliver", agent: "client", dependsOn: ["qa"], acceptance: ["Loom-style written guide"] },
  ],
  web: (): WorkflowStepPlan[] => [
    { key: "brief", name: "Sitemap & copy brief", kind: "brief", agent: "copywriter", dependsOn: [], acceptance: ["Sections agreed"] },
    { key: "copy", name: "Page copy", kind: "copy", agent: "copywriter", capability: "text.copy", dependsOn: ["brief"], acceptance: ["Headline + 5 sections"] },
    { key: "build", name: "Build pages", kind: "code", agent: "coder", capability: "code.build", dependsOn: ["brief"], acceptance: ["Responsive, Lighthouse ≥ 90"] },
    { key: "integrate", name: "Forms & analytics", kind: "code", agent: "coder", capability: "code.automation", dependsOn: ["build", "copy"], acceptance: ["Form → CRM works"] },
    { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["integrate"], acceptance: ["Cross-browser pass"] },
    { key: "deliver", name: "Deploy & handover", kind: "deliver", agent: "coder", dependsOn: ["qa"], acceptance: ["Live URL + repo"] },
  ],
  loc: (): WorkflowStepPlan[] => [
    { key: "transcribe", name: "Transcribe source", kind: "research", agent: "localiser", capability: "text.research", dependsOn: [], acceptance: ["Timestamped transcript"] },
    { key: "translate", name: "Translate ES/DE/FR", kind: "translate", agent: "localiser", capability: "text.translate", dependsOn: ["transcribe"], acceptance: ["Native-reviewed glossary"] },
    { key: "voice", name: "AI voiceover", kind: "generate", agent: "creative", capability: "audio.voiceover", dependsOn: ["translate"], acceptance: ["Lip-sync within 120ms"] },
    { key: "subs", name: "Subtitles", kind: "assemble", agent: "finisher", capability: "media.finishing", dependsOn: ["translate"], acceptance: ["SRT per language"] },
    { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["voice", "subs"], acceptance: ["No mistranslations"] },
    { key: "deliver", name: "Package delivery", kind: "deliver", agent: "finisher", dependsOn: ["qa"], acceptance: ["MP4 + SRT per language"] },
  ],
  research: (): WorkflowStepPlan[] => [
    { key: "scope", name: "Research plan", kind: "brief", agent: "researcher", dependsOn: [], acceptance: ["Questions + sources"] },
    { key: "research", name: "Desk research", kind: "research", agent: "researcher", capability: "text.research", dependsOn: ["scope"], acceptance: ["25+ cited sources"] },
    { key: "write", name: "Report writing", kind: "copy", agent: "copywriter", capability: "text.copy", dependsOn: ["research"], acceptance: ["Exec summary + 8 sections"] },
    { key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["write"], acceptance: ["Claims cited"] },
    { key: "deliver", name: "Deliver report", kind: "deliver", agent: "client", dependsOn: ["qa"], acceptance: ["PDF + Notion"] },
  ],
};

const T: Tpl[] = [
  {
    market: "paid-social-ugc",
    title: "UGC-style TikTok ads for skincare launch (6 × 15s)",
    client: "Lumen Skin Co.",
    country: "US",
    desc: "We're launching a vitamin C serum and need 6 UGC-style vertical ads (15s each) for TikTok and Reels. Hooks should target 25–34 women with dull skin. We'll send product photos and brand guidelines. Need captions burned in. Deadline in 5 days.",
    budgetType: "fixed",
    bmin: 700,
    bmax: 1100,
    skills: ["UGC", "TikTok ads", "Video editing"],
    analysis: {
      summary: "Six 15-second vertical UGC-style ads for a serum launch, captions burned in, product photos supplied.",
      clientRequest: "6 × 15s 9:16 UGC ads with hooks for 25–34 women; captions; 5-day deadline.",
      deliverables: [
        { item: "UGC video ad, 15s, 9:16", quantity: 6, format: "MP4" },
        { item: "Hook variants (text)", quantity: 12, format: "doc" },
      ],
      suppliedAssets: ["Product photos", "Brand guidelines"],
      requiredAssets: ["Logo (vector)", "Offer / discount code"],
      missingInputs: ["Offer / discount code for CTA"],
      skills: ["UGC", "Scriptwriting", "Video"],
      risks: [
        { kind: "revision", severity: "medium", note: "Creative taste-driven; expect one round of hook changes." },
        { kind: "compliance", severity: "low", note: "Avoid medical claims in scripts (skincare)." },
      ],
      deadlineDays: 5,
      productionEstimates: [
        { label: "Keyframe stills", capability: "image.generate", units: 12, attemptsPerUnit: 2 },
        { label: "UGC clip 15s", capability: "video.image_to_video", units: 6, attemptsPerUnit: 1.8 },
      ],
      inferenceEstimates: [
        { task: "Scripts & hooks", family: "factory", kTokensIn: 6, kTokensOut: 4, calls: 4 },
        { task: "Triage & QA pre-check", family: "gx", kTokensIn: 8, kTokensOut: 2, calls: 10 },
      ],
      humanHours: 1.5,
      billableHours: null,
      proposedWorkflow: wf.ugc(),
      fitScore: 0.86,
      complexity: 0.45,
      revisionRisk: 0.42,
      deadlineRisk: 0.3,
      confidence: 0.82,
      rationale: ["Clear deliverable count and format", "Assets supplied up front", "Budget midpoint $900 supports premium video route"],
      buyerPriorities: ["Scroll-stopping hooks", "Fast turnaround", "Native TikTok feel"],
    },
  },
  {
    market: "image-design",
    title: "Amazon listing images for kitchen gadget (7 images)",
    client: "Oakline Home",
    country: "UK",
    desc: "Need a full set of Amazon listing images: main white-background hero, 3 lifestyle scenes, 2 infographics and 1 size comparison. We supply product renders. Must follow Amazon image requirements.",
    budgetType: "fixed",
    bmin: 350,
    bmax: 600,
    skills: ["Product photography", "Amazon", "Photoshop"],
    analysis: {
      summary: "Seven Amazon listing images (hero, lifestyle, infographics) from supplied product renders.",
      clientRequest: "Hero + 3 lifestyle + 2 infographic + 1 size comparison, Amazon compliant.",
      deliverables: [
        { item: "Amazon hero image (white bg)", quantity: 1, format: "JPG 2000px" },
        { item: "Lifestyle scene", quantity: 3, format: "JPG" },
        { item: "Infographic", quantity: 2, format: "JPG" },
        { item: "Size comparison", quantity: 1, format: "JPG" },
      ],
      suppliedAssets: ["Product renders (PNG)"],
      requiredAssets: ["Feature bullet copy"],
      missingInputs: [],
      skills: ["Image generation", "Retouching"],
      risks: [{ kind: "revision", severity: "low", note: "Infographic copy may change." }],
      deadlineDays: 4,
      productionEstimates: [
        { label: "Lifestyle render", capability: "image.generate", units: 7, attemptsPerUnit: 2.5 },
        { label: "Retouch pass", capability: "image.edit", units: 7, attemptsPerUnit: 1.5 },
      ],
      inferenceEstimates: [{ task: "Infographic copy", family: "gx", kTokensIn: 4, kTokensOut: 2, calls: 3 }],
      humanHours: 1,
      billableHours: null,
      proposedWorkflow: wf.image(),
      fitScore: 0.9,
      complexity: 0.3,
      revisionRisk: 0.25,
      deadlineRisk: 0.2,
      confidence: 0.88,
      rationale: ["Well-specified shot list", "Renders supplied — low input risk", "Strong catalog price coverage"],
      buyerPriorities: ["Amazon compliance", "Conversion-focused infographics"],
    },
  },
  {
    market: "ai-automation",
    title: "n8n workflow: inbound leads → GPT qualification → HubSpot",
    client: "Northwind Advisory",
    country: "CA",
    desc: "Build an n8n workflow that takes Typeform leads, enriches with Clearbit, qualifies with an LLM (score + reason), writes to HubSpot and alerts Slack for hot leads. Include error handling and docs.",
    budgetType: "fixed",
    bmin: 900,
    bmax: 1500,
    skills: ["n8n", "HubSpot", "OpenAI API"],
    analysis: {
      summary: "Lead-qualification automation in n8n: Typeform → enrichment → LLM scoring → HubSpot + Slack alerts.",
      clientRequest: "End-to-end n8n workflow with error handling and documentation.",
      deliverables: [
        { item: "n8n workflow (JSON export)", quantity: 1 },
        { item: "Prompt pack", quantity: 1 },
        { item: "Handover documentation", quantity: 1 },
      ],
      suppliedAssets: ["HubSpot sandbox access"],
      requiredAssets: ["Clearbit API key", "Slack webhook"],
      missingInputs: ["Clearbit API key"],
      skills: ["n8n", "LLM prompting", "APIs"],
      risks: [
        { kind: "input", severity: "medium", note: "Depends on client providing API credentials." },
        { kind: "technical", severity: "low", note: "HubSpot rate limits on bulk backfill." },
      ],
      deadlineDays: 10,
      productionEstimates: [],
      inferenceEstimates: [
        { task: "Workflow build (coding agent)", family: "factory", kTokensIn: 60, kTokensOut: 30, calls: 6 },
        { task: "Tests & fixtures", family: "gx", kTokensIn: 20, kTokensOut: 10, calls: 8 },
      ],
      humanHours: 3,
      billableHours: null,
      proposedWorkflow: wf.automation(),
      fitScore: 0.8,
      complexity: 0.62,
      revisionRisk: 0.3,
      deadlineRisk: 0.2,
      confidence: 0.76,
      rationale: ["Scope maps to a standard automation pattern", "High budget vs. low inference cost", "Credential dependency flagged as missing input"],
      buyerPriorities: ["Reliability", "Clear documentation"],
    },
  },
  {
    market: "web-app-builds",
    title: "Next.js landing page for B2B SaaS waitlist",
    client: "Tessellate Labs",
    country: "DE",
    desc: "Single landing page in Next.js + Tailwind with waitlist form (Resend + Airtable), analytics and OG images. Figma design provided. Needs to be live in a week.",
    budgetType: "fixed",
    bmin: 600,
    bmax: 900,
    skills: ["Next.js", "Tailwind", "Vercel"],
    analysis: {
      summary: "Figma-to-Next.js landing page with waitlist form, analytics and OG images; one-week deadline.",
      clientRequest: "Responsive landing page, waitlist form to Airtable via Resend, analytics.",
      deliverables: [
        { item: "Landing page (Next.js)", quantity: 1 },
        { item: "Waitlist integration", quantity: 1 },
        { item: "OG images", quantity: 2, format: "PNG" },
      ],
      suppliedAssets: ["Figma file", "Brand fonts"],
      requiredAssets: ["Airtable base", "Domain DNS access"],
      missingInputs: ["Domain DNS access"],
      skills: ["Frontend", "Integrations"],
      risks: [{ kind: "deadline", severity: "medium", note: "7-day window includes client review." }],
      deadlineDays: 7,
      productionEstimates: [{ label: "OG image", capability: "image.generate", units: 2, attemptsPerUnit: 2 }],
      inferenceEstimates: [
        { task: "Build pages (coding agent)", family: "factory", kTokensIn: 80, kTokensOut: 40, calls: 5 },
        { task: "Copy polish", family: "gx", kTokensIn: 6, kTokensOut: 3, calls: 4 },
      ],
      humanHours: 2.5,
      billableHours: null,
      proposedWorkflow: wf.web(),
      fitScore: 0.84,
      complexity: 0.5,
      revisionRisk: 0.35,
      deadlineRisk: 0.45,
      confidence: 0.8,
      rationale: ["Design supplied reduces ambiguity", "Stack matches coding agents", "Deadline risk moderate"],
      buyerPriorities: ["Pixel-perfect to Figma", "Speed"],
    },
  },
  {
    market: "localization-repurposing",
    title: "Dub 12 product explainer videos into Spanish & German",
    client: "Voltra Bikes",
    country: "NL",
    desc: "We have 12 explainer videos (~90s each) in English. Need Spanish and German AI dubbing with natural voices, plus SRT subtitles. Glossary provided.",
    budgetType: "fixed",
    bmin: 1200,
    bmax: 1800,
    skills: ["Dubbing", "Localization", "Subtitles"],
    analysis: {
      summary: "AI dubbing of 12 × 90s explainers into ES and DE with SRT subtitles, glossary supplied.",
      clientRequest: "ES + DE voiceover and subtitles for 12 videos.",
      deliverables: [
        { item: "Dubbed video", quantity: 24, format: "MP4" },
        { item: "Subtitle file", quantity: 24, format: "SRT" },
      ],
      suppliedAssets: ["Source videos", "Glossary"],
      requiredAssets: [],
      missingInputs: [],
      skills: ["Translation", "Voice"],
      risks: [{ kind: "technical", severity: "medium", note: "Voiceover pricing not in catalog — estimate incomplete." }],
      deadlineDays: 12,
      productionEstimates: [{ label: "Voiceover minute", capability: "audio.voiceover", units: 36, attemptsPerUnit: 1.3 }],
      inferenceEstimates: [{ task: "Translation", family: "factory", kTokensIn: 30, kTokensOut: 30, calls: 24 }],
      humanHours: 3,
      billableHours: null,
      proposedWorkflow: wf.loc(),
      fitScore: 0.72,
      complexity: 0.55,
      revisionRisk: 0.4,
      deadlineRisk: 0.25,
      confidence: 0.64,
      rationale: ["Good budget for volume", "Voiceover unit price unknown — estimate marked incomplete"],
      buyerPriorities: ["Natural voices", "Terminology accuracy"],
    },
  },
  {
    market: "research-content",
    title: "Competitive landscape report: EU e-bike subscriptions",
    client: "Arden Capital",
    country: "FR",
    desc: "Desk research report (15–20 pages) on e-bike subscription players in 5 EU markets: pricing, fleet size, funding, unit economics signals. Sources cited.",
    budgetType: "fixed",
    bmin: 800,
    bmax: 1200,
    skills: ["Market research", "Report writing"],
    analysis: {
      summary: "Cited 15–20 page competitive report on EU e-bike subscription players across 5 markets.",
      clientRequest: "Pricing, fleet, funding and unit-economics signals with citations.",
      deliverables: [{ item: "Research report", quantity: 1, format: "PDF" }],
      suppliedAssets: [],
      requiredAssets: [],
      missingInputs: [],
      skills: ["Research", "Writing"],
      risks: [{ kind: "scope", severity: "low", note: "Unit economics data may be sparse." }],
      deadlineDays: 8,
      productionEstimates: [],
      inferenceEstimates: [
        { task: "Web research", family: "grok", kTokensIn: 40, kTokensOut: 12, calls: 20 },
        { task: "Report drafting", family: "factory", kTokensIn: 50, kTokensOut: 25, calls: 4 },
      ],
      humanHours: 2,
      billableHours: null,
      proposedWorkflow: wf.research(),
      fitScore: 0.78,
      complexity: 0.4,
      revisionRisk: 0.28,
      deadlineRisk: 0.2,
      confidence: 0.79,
      rationale: ["Research tasks map to Grok web research", "Low production cost vs budget"],
      buyerPriorities: ["Citations", "Clear takeaways"],
    },
  },
  {
    market: "paid-social-ugc",
    title: "Meta ad creative refresh — 20 static variants",
    client: "Pawsome Treats",
    country: "US",
    desc: "Looking for 20 static ad variants for Meta (1:1 and 4:5) testing 5 angles. We'll provide product shots and top-performing past ads.",
    budgetType: "fixed",
    bmin: 250,
    bmax: 400,
    skills: ["Meta ads", "Graphic design"],
    analysis: {
      summary: "20 static Meta ad variants across 5 angles in 1:1 and 4:5.",
      clientRequest: "20 statics testing 5 angles.",
      deliverables: [{ item: "Static ad variant", quantity: 20, format: "PNG" }],
      suppliedAssets: ["Product shots", "Past winning ads"],
      requiredAssets: [],
      missingInputs: [],
      skills: ["Design", "Copy"],
      risks: [{ kind: "payment", severity: "low", note: "New client, no spend history." }],
      deadlineDays: 4,
      productionEstimates: [{ label: "Static ad render", capability: "image.generate", units: 20, attemptsPerUnit: 2 }],
      inferenceEstimates: [{ task: "Angles & copy", family: "gx", kTokensIn: 5, kTokensOut: 3, calls: 5 }],
      humanHours: 2,
      billableHours: null,
      proposedWorkflow: wf.image(),
      fitScore: 0.82,
      complexity: 0.3,
      revisionRisk: 0.3,
      deadlineRisk: 0.25,
      confidence: 0.8,
      rationale: ["Cheap image routes", "Budget below preferred minimum"],
      buyerPriorities: ["Volume of angles", "On-brand"],
    },
  },
  {
    market: "ai-automation",
    title: "Customer support chatbot on docs (RAG) for Shopify store",
    client: "Kinfolk Coffee",
    country: "AU",
    desc: "Hourly contract: build a RAG chatbot over our help docs and order FAQ, embed on Shopify, hand off to Gorgias when unsure. Estimate ~20 hours.",
    budgetType: "hourly",
    bmin: 45,
    bmax: 80,
    skills: ["RAG", "Shopify", "LLM"],
    analysis: {
      summary: "RAG support bot over help docs with Shopify embed and Gorgias hand-off (~20h hourly).",
      clientRequest: "Docs chatbot with human hand-off.",
      deliverables: [{ item: "Chatbot widget + backend", quantity: 1 }],
      suppliedAssets: ["Help centre export"],
      requiredAssets: ["Gorgias API access"],
      missingInputs: ["Gorgias API access"],
      skills: ["RAG", "Frontend"],
      risks: [{ kind: "scope", severity: "medium", note: "Hourly scope can creep without milestones." }],
      deadlineDays: 14,
      productionEstimates: [],
      inferenceEstimates: [
        { task: "Build (coding agent)", family: "factory", kTokensIn: 90, kTokensOut: 45, calls: 6 },
        { task: "Eval set", family: "gx", kTokensIn: 20, kTokensOut: 8, calls: 12 },
      ],
      humanHours: 3,
      billableHours: 20,
      proposedWorkflow: wf.automation(),
      fitScore: 0.74,
      complexity: 0.6,
      revisionRisk: 0.35,
      deadlineRisk: 0.2,
      confidence: 0.7,
      rationale: ["Priced at $80/h × 20h (rate clamped to client max)", "Hand-off credential missing"],
      buyerPriorities: ["Accuracy", "Seamless hand-off"],
    },
  },
  {
    market: "image-design",
    title: "YouTube thumbnail pack — 10 thumbnails",
    client: "Decode Finance (YouTube)",
    country: "US",
    desc: "Need 10 high-CTR YouTube thumbnails for finance videos. Face cut-outs provided. Quick turnaround.",
    budgetType: "fixed",
    bmin: 120,
    bmax: 200,
    skills: ["Thumbnails", "Photoshop"],
    analysis: {
      summary: "10 YouTube thumbnails with supplied face cut-outs.",
      clientRequest: "High-CTR thumbnails, quick turnaround.",
      deliverables: [{ item: "Thumbnail 1280×720", quantity: 10, format: "JPG" }],
      suppliedAssets: ["Face cut-outs"],
      requiredAssets: ["Video titles"],
      missingInputs: [],
      skills: ["Design"],
      risks: [{ kind: "revision", severity: "medium", note: "Taste-driven, likely several rounds." }],
      deadlineDays: 2,
      productionEstimates: [{ label: "Thumbnail background", capability: "image.generate", units: 10, attemptsPerUnit: 3 }],
      inferenceEstimates: [],
      humanHours: 2.5,
      billableHours: null,
      proposedWorkflow: wf.image(),
      fitScore: 0.7,
      complexity: 0.25,
      revisionRisk: 0.6,
      deadlineRisk: 0.5,
      confidence: 0.75,
      rationale: ["Budget too low for profit gate after shadow time"],
      buyerPriorities: ["CTR"],
    },
  },
  {
    market: "web-app-builds",
    title: "Internal ops dashboard MVP (Supabase + React)",
    client: "Harbor Freight Logistics",
    country: "US",
    desc: "MVP dashboard for shipment tracking: Supabase auth, table views, CSV import, role-based access. Budget flexible for the right team.",
    budgetType: "fixed",
    bmin: 2500,
    bmax: 4000,
    skills: ["React", "Supabase", "Postgres"],
    analysis: {
      summary: "Shipment-tracking ops dashboard MVP with auth, CSV import and roles on Supabase.",
      clientRequest: "Auth, tables, CSV import, RBAC.",
      deliverables: [{ item: "Web app MVP", quantity: 1 }, { item: "Admin guide", quantity: 1 }],
      suppliedAssets: ["Sample CSVs"],
      requiredAssets: ["Supabase project"],
      missingInputs: [],
      skills: ["Full-stack"],
      risks: [
        { kind: "scope", severity: "high", note: "MVP scope is loosely defined; needs milestone plan." },
        { kind: "client", severity: "medium", note: "Stakeholder count unknown." },
      ],
      deadlineDays: 21,
      productionEstimates: [],
      inferenceEstimates: [
        { task: "Build (coding agent)", family: "factory", kTokensIn: 200, kTokensOut: 100, calls: 10 },
        { task: "Test generation", family: "gx", kTokensIn: 60, kTokensOut: 30, calls: 15 },
      ],
      humanHours: 8,
      billableHours: null,
      proposedWorkflow: wf.web(),
      fitScore: 0.68,
      complexity: 0.78,
      revisionRisk: 0.45,
      deadlineRisk: 0.3,
      confidence: 0.62,
      rationale: ["Large budget, strong margin", "High scope risk flagged — review before pursuing"],
      buyerPriorities: ["Reliability", "Clean data model"],
    },
  },
  {
    market: "research-content",
    title: "SEO content engine: 12 long-form articles/month",
    client: "Brightpath HR",
    country: "US",
    desc: "Ongoing: 12 SEO articles per month (1,800 words), keyword research included, publish to WordPress. Looking for a long-term partner.",
    budgetType: "fixed",
    bmin: 1500,
    bmax: 2200,
    skills: ["SEO", "Content writing", "WordPress"],
    analysis: {
      summary: "Monthly SEO program: 12 × 1,800-word articles with keyword research and WordPress publishing.",
      clientRequest: "12 articles/month, keywords, publishing.",
      deliverables: [{ item: "SEO article (1,800 words)", quantity: 12 }, { item: "Keyword map", quantity: 1 }],
      suppliedAssets: ["WordPress access"],
      requiredAssets: ["Brand voice guide"],
      missingInputs: ["Brand voice guide"],
      skills: ["SEO", "Writing"],
      risks: [{ kind: "revision", severity: "medium", note: "Editorial review cycles." }],
      deadlineDays: 30,
      productionEstimates: [{ label: "Header image", capability: "image.generate", units: 12, attemptsPerUnit: 1.5 }],
      inferenceEstimates: [
        { task: "Keyword research", family: "grok", kTokensIn: 30, kTokensOut: 10, calls: 6 },
        { task: "Article drafting", family: "factory", kTokensIn: 20, kTokensOut: 12, calls: 12 },
      ],
      humanHours: 5,
      billableHours: null,
      proposedWorkflow: wf.research(),
      fitScore: 0.83,
      complexity: 0.42,
      revisionRisk: 0.4,
      deadlineRisk: 0.15,
      confidence: 0.77,
      rationale: ["Recurring revenue", "Content system fits research + copy agents"],
      buyerPriorities: ["Rankings", "Consistency"],
    },
  },
  {
    market: "localization-repurposing",
    title: "Repurpose 4 podcast episodes into 20 vertical clips",
    client: "The Operator Pod",
    country: "UK",
    desc: "Cut 4 long podcast episodes into 20 vertical clips with captions and hooks. Raw video provided via Dropbox.",
    budgetType: "fixed",
    bmin: 400,
    bmax: 650,
    skills: ["Video editing", "Captions"],
    analysis: {
      summary: "20 captioned vertical clips from 4 podcast episodes.",
      clientRequest: "Clip selection, captions, hooks.",
      deliverables: [{ item: "Vertical clip with captions", quantity: 20, format: "MP4" }],
      suppliedAssets: ["Raw episodes"],
      requiredAssets: [],
      missingInputs: [],
      skills: ["Editing"],
      risks: [{ kind: "technical", severity: "low", note: "Large source files." }],
      deadlineDays: 6,
      productionEstimates: [],
      inferenceEstimates: [
        { task: "Clip selection", family: "gx", kTokensIn: 80, kTokensOut: 6, calls: 4 },
        { task: "Hooks & captions", family: "factory", kTokensIn: 10, kTokensOut: 6, calls: 4 },
      ],
      humanHours: 3,
      billableHours: null,
      proposedWorkflow: wf.loc(),
      fitScore: 0.76,
      complexity: 0.35,
      revisionRisk: 0.3,
      deadlineRisk: 0.3,
      confidence: 0.78,
      rationale: ["Mostly local compute", "Media finishing via ffmpeg pipeline"],
      buyerPriorities: ["Hook quality"],
    },
  },
];

const ALT_TITLES: string[][] = [
  ["UGC video ads for protein snack brand (8 × 20s)", "Creator-style Reels for a DTC candle shop", "TikTok Spark Ads: 5 hooks × 3 variations", "Vertical testimonial-style ads for a fintech app"],
  ["Shopify product photo set — 12 SKUs, lifestyle", "Etsy mockups for printable planner bundle", "Hero banners + social set for coffee subscription", "Packaging render & 3 lifestyle scenes (cosmetics)"],
  ["Make.com: Stripe → Notion → Slack revenue digest", "AI email triage agent for a 6-person agency", "Zapier to n8n migration (14 zaps)", "GPT-powered invoice extraction into QuickBooks"],
  ["Webflow → Next.js migration for a fintech blog", "Marketing site for AI note-taking startup (5 pages)", "Conversion-focused landing page for a webinar", "Framer site rebuild with CMS for architecture studio"],
  ["Subtitle 30 YouTube videos into Portuguese", "Localize onboarding videos to French & Italian", "Dub a 12-min course module into Japanese", "Repurpose webinar into 3 languages with captions"],
  ["Market sizing: AI note-takers for legal teams", "Pricing teardown of 20 vertical SaaS tools", "Customer interview synthesis (18 transcripts)", "Competitor analysis: B2B invoicing tools in DACH"],
  ["Static ad pack for pet insurance — 24 variants", "Carousel ads for a meal-kit relaunch", "Retargeting statics for skincare bundle", "Meta statics: 4 angles × 5 formats for app install"],
  ["Voice agent for dental clinic appointment booking", "Slack Q&A bot over Confluence (RAG)", "WhatsApp order-status assistant for a bakery chain", "Internal HR policy chatbot with SSO"],
  ["Podcast cover art + 12 episode thumbnails", "Twitch overlays & emote pack", "LinkedIn carousel templates (10) for a consultant", "Course thumbnails for 24 lessons"],
  ["Client portal MVP (auth, files, invoices)", "Inventory tracker for a 3-location retailer", "Admin dashboard for IoT sensor fleet", "Booking app MVP for a yoga studio network"],
  ["Monthly newsletter + 8 SEO posts for a law firm", "Programmatic SEO pages for a travel startup (40)", "Knowledge base rewrite for a SaaS help center", "Case-study series: 6 customer stories"],
  ["Cut 10 short clips from a keynote talk", "Turn a YouTube series into 30 Shorts", "Podcast-to-blog repurposing (8 episodes)", "Clip and caption a 3-hour livestream"],
];

const SOURCES = ["mock", "mock", "mock", "upwork", "freelancer", "contra", "fiverr", "web", "direct"] as const;
const CLIENT_POOL = ["Fernway Outdoors", "Quill & Ledger", "Brightside Dental", "Halcyon Analytics", "Mosaic Pet Co.", "Juniper Legal", "Atlas Freight", "Copperleaf Bakery", "Meridian Health", "Solstice Yoga", "Kestrel Robotics", "Driftwood Coffee", "Parcel Nine", "Evergreen Realty", "Lattice AI", "Northstar Fitness", "Tidewater Travel", "Obsidian Audio", "Marigold Kitchen", "Vantage Finance", "Cinder Games", "Pinecrest Clinics", "Arcadia Learning", "Helix Bio", "Summit Roofing", "Blue Heron Books", "Ridgeline Apparel", "Orchard Labs", "Beacon Insurance", "Wren & Co."];

// ---------------------------------------------------------------------------
// Tiny binary encoders (PNG + stored ZIP) for asset fixtures
// ---------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function makePng(w: number, h: number, hueA: [number, number, number], hueB: [number, number, number], seed: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.4 + (y / h) * 0.6;
      const cx = w * (0.35 + (seed % 5) * 0.07);
      const cy = h * 0.55;
      const d = Math.hypot(x - cx, y - cy) / (w * 0.32);
      const glow = Math.max(0, 1 - d);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        const base = hueA[c]! * (1 - t) + hueB[c]! * t;
        raw[o + c] = Math.min(255, Math.round(base + glow * glow * 90));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type EventRow = typeof agentEvent.$inferInsert;
type RunRow = typeof agentRun.$inferInsert;
type LedgerRow = typeof costLedgerEntry.$inferInsert;

async function main() {
  const db = getDb();
  const [u] = await db.select().from(user).where(eq(user.email, EMAIL!)).limit(1);
  if (!u) throw new Error(`No user with email ${EMAIL}`);
  const [m] = await db.select().from(membership).where(eq(membership.userId, u.id)).limit(1);
  if (!m) throw new Error("User has no workspace");
  const tenantId = m.tenantId;
  const settings = await getTenantSettings(db, tenantId);
  console.log(`tenant ${tenantId}`);

  if (flag("reset")) {
    for (const t of [agentEvent, agentRun, costLedgerEntry, notification, marketInsight, auditEvent, providerMetric, generation]) {
      await db.delete(t).where(eq((t as typeof agentEvent).tenantId, tenantId));
    }
    await db.delete(job).where(eq(job.tenantId, tenantId));
    await db.delete(opportunity).where(eq(opportunity.tenantId, tenantId));
    await db.delete(clientTable).where(eq(clientTable.tenantId, tenantId));
    console.log("reset done");
  }

  const events: EventRow[] = [];
  const runs: RunRow[] = [];
  const ledger: LedgerRow[] = [];
  const ev = (e: Omit<EventRow, "tenantId">) => events.push({ tenantId, ...e });

  // --- Markets --------------------------------------------------------------
  const marketMetrics: Record<string, { opd: number; budget: number; margin: number; profit: number; comp: number; win: number; rel: number; turn: number; trend: "up" | "down" | "flat"; rec: number }> = {
    "paid-social-ugc": { opd: 9.4, budget: 780, margin: 0.68, profit: 420, comp: 0.62, win: 0.21, rel: 0.91, turn: 4, trend: "up", rec: 26 },
    "image-design": { opd: 7.1, budget: 410, margin: 0.71, profit: 260, comp: 0.74, win: 0.17, rel: 0.95, turn: 3, trend: "flat", rec: 14 },
    "localization-repurposing": { opd: 3.2, budget: 920, margin: 0.63, profit: 510, comp: 0.38, win: 0.27, rel: 0.84, turn: 7, trend: "up", rec: 14 },
    "ai-automation": { opd: 6.8, budget: 1350, margin: 0.74, profit: 880, comp: 0.55, win: 0.19, rel: 0.82, turn: 9, trend: "up", rec: 26 },
    "web-app-builds": { opd: 5.5, budget: 1900, margin: 0.66, profit: 1100, comp: 0.69, win: 0.12, rel: 0.78, turn: 14, trend: "flat", rec: 12 },
    "research-content": { opd: 4.1, budget: 980, margin: 0.72, profit: 610, comp: 0.47, win: 0.24, rel: 0.93, turn: 8, trend: "down", rec: 8 },
  };
  for (const [key, v] of Object.entries(marketMetrics)) {
    await db
      .update(market)
      .set({
        recommendedAllocationPct: v.rec,
        metrics: {
          opportunitiesPerDay: v.opd,
          avgBudgetUsd: v.budget,
          avgMargin: v.margin,
          avgProfitUsd: v.profit,
          competition: v.comp,
          winRate: v.win,
          fulfilmentReliability: v.rel,
          avgTurnaroundDays: v.turn,
          demandTrend: v.trend,
        },
      })
      .where(and(eq(market.tenantId, tenantId), eq(market.key, key)));
  }
  const researchRunId = crypto.randomUUID();
  runs.push({ id: researchRunId, tenantId, agent: "market_research", task: "Weekly market research", status: "succeeded", provider: "grok", model: "grok-4.3", inputTokens: 38000, outputTokens: 6200, costUsd: 0.063, summary: "6 markets scored; 2 allocation changes recommended", startedAt: ago(3 * HOUR + 40_000), finishedAt: ago(3 * HOUR), createdAt: ago(3 * HOUR + 42_000) });
  await db.insert(marketInsight).values([
    {
      tenantId,
      headline: "Shift 6 pts from Research to AI automation and UGC",
      summary: "Automation briefs grew 18% week over week with the highest profit per job; UGC demand is up with short turnarounds. Research & content demand softened and win rate is flat.",
      body: {
        headline: "Shift 6 pts from Research to AI automation and UGC",
        summary: "Automation briefs grew 18% week over week with the highest profit per job; UGC demand is up with short turnarounds.",
        recommendations: [
          { marketKey: "ai-automation", action: "increase", fromPct: 25, toPct: 26, reason: "Highest expected profit per job ($880) and rising demand" },
          { marketKey: "paid-social-ugc", action: "increase", fromPct: 20, toPct: 26, reason: "Demand up 12% with 4-day turnaround and 91% fulfilment reliability" },
          { marketKey: "research-content", action: "decrease", fromPct: 10, toPct: 8, reason: "Demand trending down; win rate flat at 24%" },
          { marketKey: "web-app-builds", action: "decrease", fromPct: 20, toPct: 12, reason: "Lowest win rate (12%) and longest turnaround" },
          { marketKey: "localization-repurposing", action: "increase", fromPct: 10, toPct: 14, reason: "Least competitive market (0.38) with 27% win rate" },
          { marketKey: "image-design", action: "hold", fromPct: 15, toPct: 14, reason: "Stable demand, high competition" },
        ],
        signals: [
          { label: "Automation briefs", value: "+18% w/w", trend: "up" },
          { label: "UGC median budget", value: "$780", trend: "up" },
          { label: "Research win rate", value: "24%", trend: "flat" },
          { label: "Avg competition", value: "0.58", trend: "down" },
        ],
      },
      provider: "grok",
      model: "grok-4.3",
      agentRunId: researchRunId,
      createdAt: ago(3 * HOUR),
    },
    {
      tenantId,
      headline: "Localization is under-served — raise allocation",
      summary: "Fewer competing proposals per localization brief (median 6 vs 19 overall).",
      body: {
        headline: "Localization is under-served — raise allocation",
        summary: "Fewer competing proposals per localization brief (median 6 vs 19 overall).",
        recommendations: [{ marketKey: "localization-repurposing", action: "increase", fromPct: 8, toPct: 10, reason: "Median 6 competing proposals" }],
        signals: [{ label: "Competing proposals", value: "6 median", trend: "down" }],
      },
      provider: "grok",
      model: "grok-4.3",
      createdAt: ago(7 * DAY),
    },
  ]);
  ev({ type: "market.insight", agent: "market_research", level: "info", runId: researchRunId, message: "Market research: shift 6 pts from Research to AI automation and UGC", createdAt: ago(3 * HOUR) });

  // --- Integrations ------------------------------------------------------------
  const prov: Record<string, { status: "connected" | "needs_configuration" | "mock" | "unavailable" | "degraded"; detail: string; latency: number | null }> = {
    gx: { status: "connected", detail: "LiteLLM gateway reachable · gx-mini, gx-code, gx-auto", latency: 142 },
    factory: { status: "needs_configuration", detail: "FACTORY_API_KEY not set — mock intelligence used for reasoning tasks", latency: null },
    grok: { status: "degraded", detail: "Reachable but paid calls disabled (daily paid budget is $0)", latency: 388 },
    kie: { status: "needs_configuration", detail: "KIE_API_KEY not set — creative generations run on the mock broker", latency: null },
    higgsfield: { status: "needs_configuration", detail: "API key/secret not set", latency: null },
    agentos: { status: "unavailable", detail: "Pull-only supervision API ready; AgentOS registration pending", latency: null },
  };
  for (const [key, v] of Object.entries(prov)) {
    await db
      .update(providerIntegration)
      .set({ status: v.status, statusDetail: v.detail, latencyMs: v.latency, lastCheckAt: ago(between(2, 40) * 60_000) })
      .where(and(eq(providerIntegration.tenantId, tenantId), eq(providerIntegration.providerKey, key)));
  }
  const src: Record<string, { status: "connected" | "needs_configuration" | "mock"; enabled: boolean; detail: string; sync: number | null }> = {
    mock: { status: "mock", enabled: true, detail: "Demo marketplace feed through the live pipeline", sync: 11 * 60_000 },
    upwork: { status: "needs_configuration", enabled: false, detail: "OAuth app credentials not configured", sync: null },
    freelancer: { status: "needs_configuration", enabled: false, detail: "OAuth token not configured", sync: null },
    contra: { status: "connected", enabled: true, detail: "Inbound webhook verified (HMAC)", sync: 5 * HOUR },
    fiverr: { status: "needs_configuration", enabled: false, detail: "Forward buyer-request emails to the inbound webhook", sync: null },
    web: { status: "connected", enabled: true, detail: "3 public feeds (RemoteOK, WWR, HN Who's Hiring)", sync: 42 * 60_000 },
    direct: { status: "connected", enabled: true, detail: "Manual intake", sync: null },
  };
  for (const [key, v] of Object.entries(src)) {
    await db
      .update(sourceIntegration)
      .set({ status: v.status, enabled: v.enabled, statusDetail: v.detail, lastSyncAt: v.sync ? ago(v.sync) : null })
      .where(and(eq(sourceIntegration.tenantId, tenantId), eq(sourceIntegration.sourceKey, key)));
  }

  // --- Opportunities -------------------------------------------------------------
  type OppMade = { id: string; tpl: Tpl; source: string; createdAt: Date; status: string; profit: number; price: number; cost: number; fulfil: number; margin: number; rec: string; complete: boolean };
  const made: OppMade[] = [];
  const statusPlan: string[] = [];
  const N = 64;
  for (let i = 0; i < N; i++) statusPlan.push("analysed");
  // explicit lifecycle stages for the first few
  const forced: Record<number, string> = { 0: "won", 1: "won", 2: "won", 3: "won", 4: "won", 5: "won", 6: "applied", 7: "pursuing", 8: "shortlisted", 9: "shortlisted", 10: "rejected", 11: "lost", 12: "new", 13: "analysing", 14: "applied", 15: "expired", 16: "rejected", 17: "pursuing", 18: "applied", 19: "lost" };

  for (let i = 0; i < N; i++) {
    const tpl = T[i % T.length]!;
    const source = i < 2 ? "upwork" : i === 3 ? "contra" : i === 6 ? "freelancer" : i === 4 ? "direct" : i === 5 ? "mock" : pick(SOURCES);
    const scale = i < T.length ? 1 : between(0.55, 1.6);
    const bmin = tpl.bmin ? Math.round((tpl.bmin * scale) / 10) * 10 : null;
    const bmax = tpl.bmax ? Math.round((tpl.bmax * scale) / 10) * 10 : null;
    const status = forced[i] ?? (i > N - 8 ? pick(["analysed", "analysed", "new", "rejected", "expired"]) : "analysed");
    const createdAt = i < 20 ? ago(between(4 * DAY, 20 * DAY) - i * HOUR) : ago(between(0.05, i < 44 ? 1 : 4.5) * DAY);
    const postedAt = new Date(createdAt.getTime() - between(0.2, 6) * HOUR);
    const alts = ALT_TITLES[i % T.length] ?? [];
    const title = i < T.length ? tpl.title : (alts[Math.floor(i / T.length - 1) % Math.max(1, alts.length)] ?? tpl.title);
    const clientName = i < T.length ? tpl.client : CLIENT_POOL[i % CLIENT_POOL.length]!;
    const analysisBody: OpportunityAnalysis = {
      serviceFamily: tpl.market,
      ...tpl.analysis,
      fitScore: Math.min(0.98, Math.max(0.3, tpl.analysis.fitScore + between(-0.08, 0.06))),
      confidence: Math.min(0.95, Math.max(0.35, tpl.analysis.confidence + between(-0.1, 0.05))),
      deadlineRisk: Math.min(0.95, Math.max(0.05, tpl.analysis.deadlineRisk + between(-0.1, 0.15))),
      revisionRisk: Math.min(0.95, Math.max(0.05, tpl.analysis.revisionRisk + between(-0.1, 0.12))),
    };
    const { economics, routes } = estimateOpportunity(analysisBody, { sourceKey: source, budgetType: tpl.budgetType, budgetMinUsd: bmin, budgetMaxUsd: bmax }, settings);
    const score = scoreOpportunity(
      economics,
      {
        fit: analysisBody.fitScore,
        complexity: analysisBody.complexity,
        revisionRisk: analysisBody.revisionRisk,
        deadlineRisk: analysisBody.deadlineRisk,
        confidence: analysisBody.confidence,
        highRisks: analysisBody.risks.filter((r) => r.severity === "high").length,
      },
      settings.thresholds,
      statedBudget(bmin, bmax),
    );
    const analysed = !["new", "analysing"].includes(status);
    const externalId = `fx-${i}-${Math.floor(rnd() * 1e9).toString(36)}`;
    const [o] = await db
      .insert(opportunity)
      .values({
        tenantId,
        sourceKey: source,
        externalId,
        url: source === "direct" ? null : `https://${source === "mock" ? "demo.gigpilot.ai/market" : source === "web" ? "remoteok.com/remote-jobs" : `${source}.com/jobs`}/${externalId}`,
        title,
        description: tpl.desc,
        clientName,
        clientCountry: tpl.country,
        clientRating: source === "direct" ? null : round2(between(4.1, 5)),
        clientSpendUsd: source === "direct" ? null : Math.round(between(800, 60000)),
        budgetType: tpl.budgetType,
        budgetMinUsd: bmin,
        budgetMaxUsd: bmax,
        skills: tpl.skills,
        marketKey: tpl.market,
        proposalsCount: source === "direct" ? null : Math.round(between(2, 45)),
        postedAt,
        deadlineAt: tpl.analysis.deadlineDays ? new Date(createdAt.getTime() + (tpl.analysis.deadlineDays + 2) * DAY) : null,
        expiresAt: new Date(createdAt.getTime() + 96 * HOUR),
        status: status as never,
        dedupeHash: dedupeHash(title + i, tpl.desc),
        raw: { ingestion: source === "contra" ? "email" : source === "direct" ? "manual" : source === "mock" ? "mock" : "api", fixture: true },
        expectedProfitUsd: analysed ? economics.grossProfitUsd : null,
        expectedMargin: analysed ? economics.grossMargin : null,
        estimatedCostUsd: analysed ? economics.totalCostUsd - economics.platformFeesUsd : null,
        expectedFeesUsd: analysed ? economics.platformFeesUsd : null,
        priceUsd: analysed ? economics.priceUsd : null,
        overallScore: analysed ? score.overall : null,
        recommendation: analysed ? score.recommendation : null,
        estimateComplete: analysed ? economics.complete : null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: opportunity.id });
    const oppId = o!.id;
    const scoutRun = crypto.randomUUID();
    runs.push({ id: scoutRun, tenantId, agent: "scout", task: `Normalise listing from ${source}`, subjectType: "opportunity", subjectId: oppId, status: "succeeded", provider: "gx", model: "gx-mini", inputTokens: 2100, outputTokens: 400, costUsd: 0, summary: "Normalised and de-duplicated", startedAt: new Date(createdAt.getTime() - 4000), finishedAt: createdAt, createdAt: new Date(createdAt.getTime() - 5000) });
    ev({ type: "opportunity.discovered", agent: "scout", runId: scoutRun, subjectType: "opportunity", subjectId: oppId, message: `Discovered on ${source === "mock" ? "Demo marketplace" : source}: ${title}`, createdAt });
    if (status === "analysing") {
      runs.push({ tenantId, agent: "analyst", task: `Analyse: ${title}`, subjectType: "opportunity", subjectId: oppId, status: "running", provider: "gx", model: "gx-auto", startedAt: ago(38_000), createdAt: ago(40_000), dependencies: ["scout"] });
      continue;
    }
    if (!analysed) {
      made.push({ id: oppId, tpl, source, createdAt, status, profit: 0, price: 0, cost: 0, fulfil: 0, margin: 0, rec: "", complete: false });
      continue;
    }
    const analysedAt = new Date(createdAt.getTime() + between(40, 180) * 1000);
    const analystRun = crypto.randomUUID();
    const analystProvider = rnd() > 0.3 ? { p: "gx", m: "gx-auto", cost: 0 } : { p: "factory", m: "auto", cost: round2(between(0.04, 0.16)) };
    runs.push({ id: analystRun, tenantId, agent: "analyst", task: `Analyse: ${title}`, subjectType: "opportunity", subjectId: oppId, status: "succeeded", provider: analystProvider.p, model: analystProvider.m, inputTokens: 9000, outputTokens: 2400, costUsd: analystProvider.cost, summary: `${analysisBody.deliverables.length} deliverables, ${analysisBody.missingInputs.length} missing inputs`, dependencies: ["scout"], startedAt: new Date(analysedAt.getTime() - 32_000), finishedAt: analysedAt, createdAt: new Date(analysedAt.getTime() - 33_000) });
    const [an] = await db.insert(opportunityAnalysis).values({ tenantId, opportunityId: oppId, version: 1, analysis: analysisBody, provider: analystProvider.p, model: analystProvider.m, agentRunId: analystRun, createdAt: analysedAt }).returning({ id: opportunityAnalysis.id });
    const [ce] = await db
      .insert(costEstimate)
      .values({ tenantId, opportunityId: oppId, analysisId: an!.id, breakdown: economics, totalCostUsd: economics.totalCostUsd, grossProfitUsd: economics.grossProfitUsd, grossMargin: economics.grossMargin, complete: economics.complete, createdAt: analysedAt })
      .returning({ id: costEstimate.id });
    await db.insert(opportunityScore).values({
      tenantId,
      opportunityId: oppId,
      analysisId: an!.id,
      costEstimateId: ce!.id,
      fit: analysisBody.fitScore,
      complexity: analysisBody.complexity,
      revisionRisk: analysisBody.revisionRisk,
      deadlineRisk: analysisBody.deadlineRisk,
      confidence: analysisBody.confidence,
      overall: score.overall,
      recommendation: score.recommendation,
      gates: score.gates,
      reasons: [...score.reasons, ...routes.map((r) => r.rationale)].slice(0, 6),
      createdAt: analysedAt,
    });
    const econRun = crypto.randomUUID();
    runs.push({ id: econRun, tenantId, agent: "economics", task: `Price & score: ${title}`, subjectType: "opportunity", subjectId: oppId, status: "succeeded", provider: "deterministic", model: "calculator", costUsd: 0, summary: `${score.recommendation} · $${Math.round(economics.grossProfitUsd)} profit`, dependencies: ["analyst"], startedAt: analysedAt, finishedAt: new Date(analysedAt.getTime() + 400), createdAt: analysedAt });
    ev({ type: "opportunity.analysed", agent: "analyst", runId: analystRun, subjectType: "opportunity", subjectId: oppId, message: `Analysed: ${analysisBody.deliverables.length} deliverables, ${analysisBody.missingInputs.length} missing input${analysisBody.missingInputs.length === 1 ? "" : "s"}`, createdAt: analysedAt });
    ev({
      type: "opportunity.scored",
      agent: "economics",
      level: score.recommendation === "pursue" ? "success" : "info",
      runId: econRun,
      subjectType: "opportunity",
      subjectId: oppId,
      message: `${score.recommendation === "pursue" ? "Pursue" : score.recommendation === "consider" ? "Consider" : "Skip"} · $${Math.round(economics.grossProfitUsd)} profit · ${Math.round(economics.grossMargin * 100)}% margin${economics.complete ? "" : " · incomplete estimate"}`,
      data: { profit: economics.grossProfitUsd, margin: economics.grossMargin },
      createdAt: new Date(analysedAt.getTime() + 500),
    });
    if (analystProvider.cost > 0) ledger.push({ tenantId, opportunityId: oppId, category: "inference", kind: "actual", provider: analystProvider.p, model: analystProvider.m, amountUsd: analystProvider.cost, paid: false, agentRunId: analystRun, memo: "Opportunity analysis (mock billing)", createdAt: analysedAt });
    if (status === "shortlisted") ev({ type: "opportunity.shortlisted", agent: "orchestrator", subjectType: "opportunity", subjectId: oppId, message: `Shortlisted: ${title}`, createdAt: new Date(analysedAt.getTime() + HOUR) });
    if (status === "rejected") ev({ type: "opportunity.rejected", agent: "orchestrator", subjectType: "opportunity", subjectId: oppId, message: `Rejected: ${title}`, createdAt: new Date(analysedAt.getTime() + 2 * HOUR) });
    made.push({ id: oppId, tpl, source, createdAt, status, profit: economics.grossProfitUsd, price: economics.priceUsd, cost: economics.totalCostUsd, fulfil: economics.fulfilmentCostUsd + economics.revisionContingencyUsd + economics.contingencyUsd, margin: economics.grossMargin, rec: score.recommendation, complete: economics.complete });
  }

  // --- Proposals & applications -------------------------------------------------
  type AppMade = { appId: string; opp: OppMade; proposalId: string; status: string; price: number; timeline: number; at: Date };
  const apps: AppMade[] = [];
  const cover = (o: OppMade) =>
    `Hi ${o.tpl.client.split(" ")[0]} team — I read your brief for "${o.tpl.title}". ${o.tpl.analysis.summary} ` +
    `Here's how I'd run it: ${o.tpl.analysis.proposedWorkflow
      .slice(0, 4)
      .map((s) => s.name.toLowerCase())
      .join(" → ")}, with an independent QA pass before anything reaches you. ` +
    `You'll get ${o.tpl.analysis.deliverables.map((d) => `${d.quantity}× ${d.item}`).join(", ")}. ` +
    `${o.tpl.analysis.missingInputs.length ? `To start I'll need: ${o.tpl.analysis.missingInputs.join(", ")}. ` : ""}Happy to share relevant samples.`;

  for (const o of made) {
    if (!["pursuing", "applied", "won", "lost"].includes(o.status)) continue;
    const at = new Date(o.createdAt.getTime() + between(2, 6) * HOUR);
    const price = Math.max(150, Math.round(o.price / 10) * 10);
    const timeline = (o.tpl.analysis.deadlineDays ?? 7) - 1;
    const awaiting = o.status === "pursuing";
    const propRun = crypto.randomUUID();
    runs.push({ id: propRun, tenantId, agent: "proposal", task: `Draft proposal: ${o.tpl.title}`, subjectType: "opportunity", subjectId: o.id, status: "succeeded", provider: "factory", model: "auto", inputTokens: 7000, outputTokens: 1500, costUsd: 0.044, summary: `Draft at $${price}, ${timeline}-day timeline`, dependencies: ["economics"], startedAt: new Date(at.getTime() - 45_000), finishedAt: at, createdAt: new Date(at.getTime() - 46_000) });
    ledger.push({ tenantId, opportunityId: o.id, category: "inference", kind: "actual", provider: "factory", model: "auto", amountUsd: 0.044, paid: false, agentRunId: propRun, memo: "Proposal drafting (mock billing)", createdAt: at });
    const [p] = await db
      .insert(proposal)
      .values({
        tenantId,
        opportunityId: o.id,
        version: 1,
        headline: `${o.tpl.analysis.deliverables[0]?.quantity ?? 1}× ${o.tpl.analysis.deliverables[0]?.item ?? "deliverable"} in ${timeline} days — QA'd before delivery`,
        coverLetter: cover(o),
        scope: o.tpl.analysis.deliverables.map((d) => ({ item: `${d.quantity}× ${d.item}`, detail: d.format })),
        priceUsd: price,
        timelineDays: timeline,
        assumptions: ["One revision round included", ...o.tpl.analysis.suppliedAssets.map((a) => `${a} supplied by client before kickoff`)].slice(0, 4),
        questions: o.tpl.analysis.missingInputs.map((x) => `Could you share: ${x}?`),
        status: awaiting ? "awaiting_approval" : "approved",
        provider: "factory",
        model: "auto",
        agentRunId: propRun,
        approvedBy: awaiting ? null : u.id,
        approvedAt: awaiting ? null : new Date(at.getTime() + HOUR),
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: proposal.id });
    ev({ type: "proposal.generated", agent: "proposal", runId: propRun, subjectType: "proposal", subjectId: p!.id, message: `Proposal drafted at $${price} — awaiting owner approval`, createdAt: at });
    if (awaiting) continue;
    ev({ type: "proposal.approved", agent: "proposal", level: "success", subjectType: "proposal", subjectId: p!.id, message: `Proposal approved at $${price}`, createdAt: new Date(at.getTime() + HOUR) });
    const appStatus = o.status === "won" ? "won" : o.status === "lost" ? "lost" : pick(["submitted", "client_response", "negotiating"]);
    const submittedAt = new Date(at.getTime() + 2 * HOUR);
    const [a] = await db
      .insert(application)
      .values({
        tenantId,
        opportunityId: o.id,
        proposalId: p!.id,
        status: appStatus as never,
        submissionMode: o.source === "freelancer" ? "api" : o.source === "mock" ? "mock" : "manual",
        idempotencyKey: `application:${o.id}:${p!.id}`,
        externalRef: o.source === "freelancer" ? `bid-${Math.floor(rnd() * 1e7)}` : o.source === "upwork" ? "Submitted via Upwork UI" : null,
        submittedAt,
        decidedAt: ["won", "lost"].includes(appStatus) ? new Date(submittedAt.getTime() + between(10, 40) * HOUR) : null,
        priceUsd: price,
        createdAt: new Date(at.getTime() + HOUR),
        updatedAt: new Date(submittedAt.getTime() + HOUR),
      })
      .returning({ id: application.id });
    ev({ type: "application.submitted", agent: "client", subjectType: "application", subjectId: a!.id, message: o.source === "freelancer" ? "Bid placed via Freelancer API after owner approval" : o.source === "mock" ? "Submitted to demo marketplace" : "Submitted manually by owner", createdAt: submittedAt });
    if (appStatus === "won") ev({ type: "application.won", agent: "client", level: "success", subjectType: "application", subjectId: a!.id, message: `Won: ${o.tpl.title}`, createdAt: new Date(submittedAt.getTime() + 20 * HOUR) });
    if (appStatus === "lost") ev({ type: "application.lost", agent: "client", subjectType: "application", subjectId: a!.id, message: `Lost: ${o.tpl.title}`, createdAt: new Date(submittedAt.getTime() + 30 * HOUR) });
    apps.push({ appId: a!.id, opp: o, proposalId: p!.id, status: appStatus, price, timeline, at: submittedAt });
  }
  // One approved-but-not-submitted manual application (Upwork): needs owner action.
  const pend = made.find((o) => o.status === "analysed" && o.rec === "pursue" && o.source !== "mock");
  if (pend) {
    await db.update(opportunity).set({ status: "pursuing" }).where(eq(opportunity.id, pend.id));
    await db.update(opportunity).set({ sourceKey: "upwork", externalId: `fx-upwork-pending-${pend.id.slice(0, 6)}` }).where(eq(opportunity.id, pend.id));
    const [p] = await db
      .insert(proposal)
      .values({ tenantId, opportunityId: pend.id, headline: "Ready to start this week", coverLetter: cover(pend), scope: pend.tpl.analysis.deliverables.map((d) => ({ item: `${d.quantity}× ${d.item}` })), priceUsd: Math.round(pend.price), timelineDays: 6, assumptions: ["One revision round included"], status: "approved", provider: "factory", model: "auto", approvedBy: u.id, approvedAt: ago(40 * 60_000), createdAt: ago(3 * HOUR) })
      .returning({ id: proposal.id });
    await db.insert(application).values({ tenantId, opportunityId: pend.id, proposalId: p!.id, status: "approved", submissionMode: "manual", idempotencyKey: `application:${pend.id}:${p!.id}`, priceUsd: Math.round(pend.price), createdAt: ago(40 * 60_000) });
    ev({ type: "application.manual_submission_required", agent: "client", level: "warn", subjectType: "opportunity", subjectId: pend.id, message: "Upwork does not permit programmatic proposals — submit manually, then mark submitted", createdAt: ago(39 * 60_000) });
  }

  // --- Jobs & production ----------------------------------------------------------
  const won = apps.filter((a) => a.status === "won");
  const jobPlans: { state: string; ageDays: number }[] = [
    { state: "executing", ageDays: 1.2 },
    { state: "awaiting_final_approval", ageDays: 3 },
    { state: "repairing", ageDays: 2 },
    { state: "delivered", ageDays: 9 },
    { state: "closed", ageDays: 16 },
    { state: "planning", ageDays: 0.02 },
  ];
  const storage = getStorage();
  for (let k = 0; k < Math.min(won.length, jobPlans.length); k++) {
    const a = won[k]!;
    const plan = jobPlans[k]!;
    const o = a.opp;
    const created = ago(plan.ageDays * DAY);
    const [c] = await db.insert(clientTable).values({ tenantId, name: o.tpl.client, sourceKey: o.source, country: o.tpl.country, createdAt: created }).returning({ id: clientTable.id });
    const estCost = round2(Math.max(2.5, o.fulfil));
    const done = ["delivered", "closed", "awaiting_final_approval"].includes(plan.state);
    const variance = [0.92, 1.08, 1.31, 0.97, 1.12, 1][k]!;
    const actualCost = done ? round2(estCost * variance) : plan.state === "planning" ? 0 : round2(estCost * between(0.35, 0.7));
    const [j] = await db
      .insert(job)
      .values({
        tenantId,
        opportunityId: o.id,
        applicationId: a.appId,
        clientId: c!.id,
        title: o.tpl.title,
        serviceFamily: o.tpl.market,
        status: plan.state as never,
        priceUsd: a.price,
        spendLimitUsd: Math.min(settings.limits.perJobSpendLimitUsd, Math.max(estCost * 2.5, 10)),
        estimatedCostUsd: estCost,
        actualCostUsd: actualCost,
        repairCount: plan.state === "repairing" ? 2 : plan.state === "awaiting_final_approval" ? 1 : 0,
        acceptanceCriteria: [...o.tpl.analysis.deliverables.map((d) => `${d.quantity}× ${d.item}${d.format ? ` (${d.format})` : ""}`), ...o.tpl.analysis.proposedWorkflow.flatMap((s) => s.acceptance)].slice(0, 8),
        brief: o.tpl.analysis.summary,
        dueAt: new Date(created.getTime() + a.timeline * DAY),
        startedAt: plan.state === "planning" ? null : new Date(created.getTime() + 20 * 60_000),
        completedAt: ["delivered", "closed"].includes(plan.state) ? new Date(created.getTime() + (a.timeline - 1) * DAY) : null,
        createdAt: created,
        updatedAt: plan.state === "executing" ? ago(30_000) : new Date(created.getTime() + DAY),
      })
      .returning({ id: job.id });
    const jobId = j!.id;
    ev({ type: "job.created", agent: "orchestrator", level: "success", subjectType: "job", subjectId: jobId, jobId, message: `Job created: ${o.tpl.title}`, createdAt: created });
    ledger.push({ tenantId, jobId, opportunityId: o.id, category: "revenue", kind: "estimate", amountUsd: a.price, paid: false, memo: "Contract value", createdAt: created });
    ledger.push({ tenantId, jobId, opportunityId: o.id, category: "creative", kind: "estimate", amountUsd: round2(estCost * 0.6), paid: false, memo: "Production estimate", createdAt: created });
    ledger.push({ tenantId, jobId, opportunityId: o.id, category: "inference", kind: "estimate", amountUsd: round2(estCost * 0.4), paid: false, memo: "Inference estimate", createdAt: created });
    ledger.push({ tenantId, jobId, opportunityId: o.id, category: "human_shadow", kind: "estimate", amountUsd: round2(o.tpl.analysis.humanHours * settings.economics.shadowHourlyRateUsd), paid: false, memo: `${o.tpl.analysis.humanHours}h owner time @ $${settings.economics.shadowHourlyRateUsd}/h`, createdAt: created });
    if (plan.state === "planning") {
      runs.push({ tenantId, agent: "planner", task: `Plan workflow: ${o.tpl.title}`, subjectType: "job", subjectId: jobId, jobId, status: "running", provider: "factory", model: "auto", startedAt: ago(25_000), createdAt: ago(27_000) });
      ev({ type: "job.state", agent: "planner", subjectType: "job", subjectId: jobId, jobId, message: "Production Planner is building the workflow DAG", createdAt: ago(25_000) });
      continue;
    }
    const plannerRun = crypto.randomUUID();
    runs.push({ id: plannerRun, tenantId, agent: "planner", task: `Plan workflow: ${o.tpl.title}`, subjectType: "job", subjectId: jobId, jobId, status: "succeeded", provider: "factory", model: "auto", inputTokens: 12000, outputTokens: 3000, costUsd: 0.081, summary: `${o.tpl.analysis.proposedWorkflow.length}-step DAG`, startedAt: new Date(created.getTime() + 5 * 60_000), finishedAt: new Date(created.getTime() + 6 * 60_000), createdAt: new Date(created.getTime() + 5 * 60_000) });
    const [w] = await db.insert(workflow).values({ tenantId, jobId, version: 1, status: done ? "completed" : "active", plannedBy: "planner", createdAt: new Date(created.getTime() + 6 * 60_000) }).returning({ id: workflow.id });
    ev({ type: "workflow.planned", agent: "planner", runId: plannerRun, subjectType: "workflow", subjectId: w!.id, jobId, message: `Workflow planned: ${o.tpl.analysis.proposedWorkflow.length} steps, spend limit $${Math.round(Math.min(settings.limits.perJobSpendLimitUsd, Math.max(estCost * 2.5, 10)))}`, createdAt: new Date(created.getTime() + 6 * 60_000) });

    const steps = o.tpl.analysis.proposedWorkflow;
    const stepIds: Record<string, string> = {};
    let t0 = created.getTime() + 8 * 60_000;
    for (let si = 0; si < steps.length; si++) {
      const s = steps[si]!;
      let status: string = "succeeded";
      let attempts = 1;
      let error: string | null = null;
      if (plan.state === "executing") {
        if (si < 2) status = "succeeded";
        else if (si === 2 || si === 3) status = si === 3 ? "running" : "succeeded";
        else status = "pending";
        if (si === 3) attempts = 2;
      }
      if (plan.state === "repairing") {
        if (s.kind === "qa") status = "failed";
        else if (s.kind === "deliver") status = "pending";
        else if (s.kind === "generate" || s.kind === "code") {
          status = "running";
          attempts = 3;
        } else if (si > steps.findIndex((x) => x.kind === "generate" || x.kind === "code")) status = "pending";
      }
      if (plan.state === "repairing" && s.kind === "qa") {
        attempts = 2;
        error = "QA failed: 2 findings (1 major)";
      }
      const isCreative = s.capability?.startsWith("image.") || s.capability?.startsWith("video.");
      const provider = s.kind === "qa" ? "gx" : isCreative ? "kie" : s.agent === "coder" ? "factory" : s.kind === "deliver" ? "local" : "gx";
      const model = s.kind === "qa" ? "gx-auto" : isCreative ? (s.capability === "video.image_to_video" ? "kling-3.0/video" : "nano-banana-2") : s.agent === "coder" ? "auto" : s.kind === "deliver" ? "packager" : "gx-code";
      const est = round2(isCreative ? between(0.4, 3.2) : s.agent === "coder" ? between(0.3, 1.4) : 0);
      const act = status === "succeeded" ? round2(est * between(0.8, 1.35) * attempts) : status === "running" ? round2(est * 0.6) : 0;
      const startedAt = status === "pending" ? null : new Date(status === "running" ? now - between(20, 140) * 1000 : t0);
      const finishedAt = status === "succeeded" || status === "failed" ? new Date(t0 + between(40, 900) * 1000) : null;
      const [st] = await db
        .insert(workflowStep)
        .values({
          tenantId,
          workflowId: w!.id,
          jobId,
          key: s.key,
          name: s.name,
          kind: s.kind,
          agent: s.agent,
          capability: s.capability ?? null,
          dependsOn: s.dependsOn,
          status: status as never,
          attempts: status === "pending" ? 0 : attempts,
          maxAttempts: settings.limits.maxStepAttempts,
          provider: status === "pending" ? null : provider,
          model: status === "pending" ? null : model,
          estimatedCostUsd: est,
          actualCostUsd: act,
          acceptance: s.acceptance,
          position: si,
          error,
          output: status === "succeeded" ? { summary: `${s.name} complete` } : null,
          startedAt,
          finishedAt,
          createdAt: new Date(created.getTime() + 6 * 60_000),
        })
        .returning({ id: workflowStep.id });
      stepIds[s.key] = st!.id;
      if (status !== "pending") {
        for (let at = 1; at <= attempts; at++) {
          const last = at === attempts;
          const runStatus = last ? (status === "running" ? "running" : status === "failed" ? "failed" : "succeeded") : "failed";
          const rs = new Date((startedAt?.getTime() ?? t0) - (attempts - at) * 90_000);
          runs.push({
            tenantId,
            agent: s.agent,
            task: s.name,
            subjectType: "step",
            subjectId: st!.id,
            jobId,
            stepId: st!.id,
            status: runStatus as never,
            attempt: at,
            provider,
            model,
            inputTokens: Math.round(between(2000, 20000)),
            outputTokens: Math.round(between(400, 6000)),
            costUsd: runStatus === "running" ? 0 : round2(est * between(0.8, 1.2)),
            summary: runStatus === "succeeded" ? `${s.name} passed acceptance` : runStatus === "failed" ? "Output rejected by QA pre-check" : null,
            error: runStatus === "failed" ? pick(["Hands deformed in frame 3", "Caption overlaps safe zone", "Test fixture 7 failed: timeout", "Brand colour off by ΔE 9"]) : null,
            dependencies: s.dependsOn,
            startedAt: rs,
            finishedAt: runStatus === "running" ? null : new Date(rs.getTime() + between(30, 300) * 1000),
            createdAt: new Date(rs.getTime() - 1500),
          });
          ev({ type: "step.started", agent: s.agent as never, subjectType: "step", subjectId: st!.id, jobId, message: `${s.name} started${at > 1 ? ` (attempt ${at})` : ""} on ${provider}/${model}`, createdAt: rs });
          if (runStatus === "succeeded") ev({ type: "step.succeeded", agent: s.agent as never, level: "success", subjectType: "step", subjectId: st!.id, jobId, message: `${s.name} succeeded · $${round2(act).toFixed(2)}`, createdAt: new Date(rs.getTime() + 200_000) });
          if (runStatus === "failed") ev({ type: "step.failed", agent: s.agent as never, level: "warn", subjectType: "step", subjectId: st!.id, jobId, message: `${s.name} attempt ${at} failed — retrying within limits`, createdAt: new Date(rs.getTime() + 150_000) });
        }
        if (act > 0) ledger.push({ tenantId, jobId, opportunityId: o.id, category: isCreative ? "creative" : "inference", kind: "actual", provider, model, amountUsd: act, paid: false, memo: `${s.name} (mock billing)`, createdAt: finishedAt ?? ago(60_000) });
      }
      t0 += between(15, 90) * 60_000;
    }

    // QA + repairs
    if (plan.state !== "executing") {
      const qaStep = steps.find((s) => s.kind === "qa")!;
      const genStep = steps.find((s) => s.kind === "generate" || s.kind === "code") ?? steps[1]!;
      const failAt = new Date(created.getTime() + 0.6 * DAY);
      const [qa1] = await db
        .insert(qaReview)
        .values({
          tenantId,
          jobId,
          stepId: stepIds[qaStep.key],
          reviewer: "qa",
          provider: "gx",
          model: "gx-auto",
          verdict: "fail",
          score: 0.58,
          findings: [
            { code: "brand.color", severity: "major", message: "Primary colour drifts from brand orange in 3 of 6 outputs.", criterion: "Brand colours", repairHint: "Re-render with locked palette reference" },
            { code: "caption.safezone", severity: "minor", message: "Caption overlaps TikTok UI safe zone in clip 4.", criterion: "Safe zones respected", repairHint: "Shift captions up 120px" },
          ],
          summary: "2 findings — brand colour drift (major), caption safe zone (minor).",
          attempt: 1,
          createdAt: failAt,
        })
        .returning({ id: qaReview.id });
      ev({ type: "qa.failed", agent: "qa", level: "warn", subjectType: "job", subjectId: jobId, jobId, message: "QA failed: 2 findings (1 major) — Recovery Agent notified", createdAt: failAt });
      await db.insert(repair).values({ tenantId, jobId, qaReviewId: qa1!.id, stepId: stepIds[genStep.key], strategy: "regenerate", rationale: "Brand colour drift is systematic — regenerate affected outputs with a locked palette reference image.", incrementalCostUsd: round2(estCost * 0.12), status: "succeeded", attempt: 1, createdAt: new Date(failAt.getTime() + 60_000) });
      ev({ type: "repair.started", agent: "recovery", subjectType: "job", subjectId: jobId, jobId, message: "Repair 1: regenerate 3 outputs with locked palette (+$" + round2(estCost * 0.12).toFixed(2) + ")", createdAt: new Date(failAt.getTime() + 60_000) });
      ev({ type: "repair.completed", agent: "recovery", level: "success", subjectType: "job", subjectId: jobId, jobId, message: "Repair 1 completed — re-submitted to QA", createdAt: new Date(failAt.getTime() + 40 * 60_000) });
      runs.push({ tenantId, agent: "qa", task: "Independent QA review", subjectType: "job", subjectId: jobId, jobId, stepId: stepIds[qaStep.key], status: "failed", attempt: 1, provider: "gx", model: "gx-auto", costUsd: 0, summary: "2 findings", error: "QA verdict: fail", startedAt: new Date(failAt.getTime() - 60_000), finishedAt: failAt, createdAt: new Date(failAt.getTime() - 61_000) });
      runs.push({ tenantId, agent: "recovery", task: "Diagnose QA failure & repair", subjectType: "job", subjectId: jobId, jobId, status: "succeeded", provider: "factory", model: "auto", costUsd: 0.021, summary: "Strategy: regenerate with locked palette", startedAt: new Date(failAt.getTime() + 30_000), finishedAt: new Date(failAt.getTime() + 60_000), createdAt: new Date(failAt.getTime() + 29_000) });
      if (plan.state === "repairing") {
        await db.insert(qaReview).values({ tenantId, jobId, stepId: stepIds[qaStep.key], reviewer: "qa", provider: "gx", model: "gx-auto", verdict: "fail", score: 0.66, findings: [{ code: "motion.artifact", severity: "major", message: "Visible warping on hands at 0:07 in clip 2.", criterion: "No artefacts", repairHint: "Reroute clip 2 to higgsfield kling pro" }], summary: "1 major finding — motion artefact in clip 2.", attempt: 2, createdAt: ago(50 * 60_000) });
        await db.insert(repair).values({ tenantId, jobId, stepId: stepIds[genStep.key], strategy: "reroute", rationale: "Kie route produced the same artefact twice; reroute clip 2 to Higgsfield Kling Pro (quality prior 0.88) within the job spend limit.", incrementalCostUsd: round2(estCost * 0.2), status: "running", attempt: 2, createdAt: ago(45 * 60_000) });
        ev({ type: "provider.fallback", agent: "recovery", level: "warn", subjectType: "job", subjectId: jobId, jobId, message: "Rerouting clip 2 from kie/kling-3.0 → higgsfield/kling-v3-pro (quality)", createdAt: ago(44 * 60_000) });
        runs.push({ tenantId, agent: "recovery", task: "Reroute clip 2 to premium route", subjectType: "job", subjectId: jobId, jobId, status: "running", provider: "factory", model: "auto", attempt: 2, startedAt: ago(70_000), createdAt: ago(71_000), dependencies: ["qa"] });
      } else {
        const passAt = new Date(failAt.getTime() + 55 * 60_000);
        await db.insert(qaReview).values({ tenantId, jobId, stepId: stepIds[qaStep.key], reviewer: "qa", provider: "gx", model: "gx-auto", verdict: "pass", score: 0.91, findings: [{ code: "style.minor", severity: "minor", message: "Hook 5 could be 0.5s tighter (optional).", criterion: "Scroll-stopping hooks" }], summary: "All acceptance criteria met; 1 optional note.", attempt: 2, createdAt: passAt });
        ev({ type: "qa.passed", agent: "qa", level: "success", subjectType: "job", subjectId: jobId, jobId, message: "QA passed (0.91) — all acceptance criteria met", createdAt: passAt });
        runs.push({ tenantId, agent: "qa", task: "Independent QA review", subjectType: "job", subjectId: jobId, jobId, stepId: stepIds[qaStep.key], status: "succeeded", attempt: 2, provider: "gx", model: "gx-auto", costUsd: 0, summary: "pass 0.91", startedAt: new Date(passAt.getTime() - 50_000), finishedAt: passAt, createdAt: new Date(passAt.getTime() - 51_000) });
      }
    }

    // Assets & delivery for completed jobs
    if (done) {
      const palette: [number, number, number][][] = [
        [[28, 18, 14], [120, 60, 30]],
        [[14, 20, 32], [40, 90, 150]],
        [[20, 26, 20], [60, 130, 90]],
        [[30, 16, 28], [150, 60, 110]],
      ];
      const files: { name: string; data: Buffer; mime: string; kind: "image" | "document" }[] = [];
      for (let n = 0; n < 4; n++) {
        const pal = palette[n % palette.length]!;
        files.push({ name: `${o.tpl.market}-render-${n + 1}.png`, data: makePng(360, 450, pal[0]!, pal[1]!, n + k), mime: "image/png", kind: "image" });
      }
      files.push({
        name: "contact-sheet.svg",
        mime: "image/svg+xml",
        kind: "image",
        data: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#111317"/><rect x="24" y="24" width="352" height="300" rx="8" fill="#1c1f25"/><circle cx="200" cy="170" r="84" fill="none" stroke="#ff6b2c" stroke-width="6"/><text x="24" y="370" fill="#edeef0" font-family="sans-serif" font-size="22">${o.tpl.client.replace(/[<&>]/g, "")}</text><text x="24" y="402" fill="#a1a6ae" font-family="monospace" font-size="14">CONTACT SHEET · v2</text></svg>`,
        ),
      });
      files.push({ name: "delivery-notes.md", mime: "text/markdown", kind: "document", data: Buffer.from(`# ${o.tpl.title}\n\nDelivered by GigPilot.\n\n${o.tpl.analysis.deliverables.map((d) => `- ${d.quantity}× ${d.item}`).join("\n")}\n`) });
      const assetIds: { id: string; filename: string; kind: string; bytes: number }[] = [];
      for (const f of files) {
        const key = `${tenantId}/jobs/${jobId}/${f.name}`;
        await storage.put(key, f.data, f.mime);
        const [as] = await db
          .insert(asset)
          .values({ tenantId, jobId, stepId: stepIds[steps.find((s) => s.kind === "generate" || s.kind === "assemble")?.key ?? steps[0]!.key], kind: f.kind, filename: f.name, mime: f.mime, storageKey: key, bytes: f.data.length, sha256: "fixture", width: f.mime === "image/png" ? 360 : null, height: f.mime === "image/png" ? 450 : null, createdAt: new Date(created.getTime() + DAY) })
          .returning({ id: asset.id });
        assetIds.push({ id: as!.id, filename: f.name, kind: f.kind, bytes: f.data.length });
      }
      const zip = makeZip(files.map((f) => ({ name: f.name, data: f.data })));
      const zipKey = `${tenantId}/jobs/${jobId}/delivery-package.zip`;
      await storage.put(zipKey, zip, "application/zip");
      const [pkg] = await db.insert(asset).values({ tenantId, jobId, kind: "archive", filename: "delivery-package.zip", mime: "application/zip", storageKey: zipKey, bytes: zip.length, sha256: "fixture", createdAt: new Date(created.getTime() + DAY) }).returning({ id: asset.id });
      const dStatus = plan.state === "awaiting_final_approval" ? "prepared" : "approved";
      await db.insert(delivery).values({
        tenantId,
        jobId,
        status: dStatus,
        packageAssetId: pkg!.id,
        manifest: { items: assetIds.map((x) => ({ assetId: x.id, filename: x.filename, kind: x.kind, bytes: x.bytes })), notes: "All outputs passed independent QA on attempt 2.", qaSummary: "QA 0.91 — all acceptance criteria met" },
        clientMessage: `Hi ${o.tpl.client.split(" ")[0]} — your files are ready. Everything passed our QA checklist; one optional note on hook 5 is in the notes.`,
        approvedBy: dStatus === "approved" ? u.id : null,
        approvedAt: dStatus === "approved" ? new Date(created.getTime() + 2 * DAY) : null,
        createdAt: new Date(created.getTime() + DAY),
      });
      ev({ type: "delivery.prepared", agent: "finisher", level: "success", subjectType: "job", subjectId: jobId, jobId, message: `Delivery package prepared (${files.length} files) — awaiting owner approval`, createdAt: plan.state === "awaiting_final_approval" ? ago(2 * HOUR) : new Date(created.getTime() + DAY) });
      if (dStatus === "approved") {
        ev({ type: "delivery.approved", agent: "client", level: "success", subjectType: "job", subjectId: jobId, jobId, message: "Owner approved final delivery", createdAt: new Date(created.getTime() + 2 * DAY) });
        ledger.push({ tenantId, jobId, opportunityId: o.id, category: "revenue", kind: "actual", amountUsd: a.price, paid: true, memo: "Client payment", createdAt: new Date(created.getTime() + 2 * DAY) });
        const fee = settings.economics.platformFees[o.source] ?? { pct: 0.1, fixedUsd: 0, minUsd: 0 };
        ledger.push({ tenantId, jobId, opportunityId: o.id, category: "marketplace_fee", kind: "actual", provider: o.source, amountUsd: round2(Math.max(a.price * fee.pct + fee.fixedUsd, fee.minUsd)), paid: true, memo: `${o.source} service fee`, createdAt: new Date(created.getTime() + 2 * DAY) });
      }
      if (plan.state === "delivered") await db.insert(revision).values({ tenantId, jobId, request: "Can hook 2 use a question instead of a statement?", interpretation: "Copy tweak on one deliverable — in scope (1 revision round included).", inScope: true, status: "done", createdAt: new Date(created.getTime() + 3 * DAY) });
    }
  }

  // --- Background ledger (30 days) --------------------------------------------------
  for (let d = 29; d >= 0; d--) {
    const day = ago(d * DAY + between(1, 20) * HOUR);
    const n = Math.round(between(2, 7));
    for (let q = 0; q < n; q++) {
      const cat = pick(["inference", "inference", "creative", "creative", "tool"] as const);
      const provider = cat === "creative" ? pick(["kie", "kie", "higgsfield"]) : cat === "tool" ? "ffmpeg" : pick(["factory", "grok", "gx"]);
      const amount = provider === "gx" ? 0 : round2(cat === "creative" ? between(0.08, 2.4) : cat === "tool" ? between(0.01, 0.2) : between(0.01, 0.35));
      if (amount === 0) continue;
      const paid = d >= 18 && d <= 21 && provider === "grok";
      ledger.push({ tenantId, category: cat, kind: "actual", provider, model: provider === "kie" ? "nano-banana-2" : provider === "higgsfield" ? "soul/v2" : provider === "grok" ? "grok-4.3" : provider === "factory" ? "auto" : null, amountUsd: amount, paid, memo: paid ? "Market research (paid test window)" : cat === "creative" ? "Concept generation (mock billing)" : "Agent inference (mock billing)", createdAt: new Date(day.getTime() + q * 37 * 60_000) });
    }
  }

  // --- Provider metrics ------------------------------------------------------------
  await db.insert(providerMetric).values([
    { tenantId, provider: "kie", model: "nano-banana-2", capability: "image.generate", attempts: 184, successes: 176, qaPasses: 131, repairs: 22, totalCostUsd: 7.36, avgLatencyMs: 24100, usableRate: 0.71, costPerUsableUsd: 0.056 },
    { tenantId, provider: "kie", model: "kling-3.0/video", capability: "video.image_to_video", attempts: 42, successes: 39, qaPasses: 26, repairs: 9, totalCostUsd: 44.1, avgLatencyMs: 151000, usableRate: 0.62, costPerUsableUsd: 1.7 },
    { tenantId, provider: "higgsfield", model: "kling-video/v3.0/pro/image-to-video", capability: "video.image_to_video", attempts: 9, successes: 9, qaPasses: 8, repairs: 1, totalCostUsd: 6.24, avgLatencyMs: 162000, usableRate: 0.89, costPerUsableUsd: 0.78 },
  ]).onConflictDoNothing();

  // --- Notifications -------------------------------------------------------------------
  const awaitingJob = await db.select({ id: job.id, title: job.title }).from(job).where(and(eq(job.tenantId, tenantId), eq(job.status, "awaiting_final_approval"))).limit(1);
  const awaitingProps = await db.select({ id: proposal.id, opp: proposal.opportunityId, price: proposal.priceUsd }).from(proposal).where(and(eq(proposal.tenantId, tenantId), eq(proposal.status, "awaiting_approval")));
  const notifs: (typeof notification.$inferInsert)[] = [];
  if (awaitingJob[0]) notifs.push({ tenantId, kind: "approval", title: "Final delivery ready for review", body: awaitingJob[0].title, link: `/jobs/${awaitingJob[0].id}`, dedupeKey: `fx-delivery-${awaitingJob[0].id}`, createdAt: ago(2 * HOUR) });
  for (const p of awaitingProps) notifs.push({ tenantId, kind: "approval", title: `Proposal awaiting approval · $${Math.round(p.price)}`, body: "Commercial commitment — review price, scope and assumptions.", link: `/radar/${p.opp}`, dedupeKey: `fx-prop-${p.id}`, createdAt: ago(between(1, 5) * HOUR) });
  notifs.push({ tenantId, kind: "alert", title: "Repair limit approaching", body: "Job is on repair 2 of 4 — rerouting to a premium creative route.", link: "/jobs", dedupeKey: "fx-repair-limit", createdAt: ago(44 * 60_000) });
  notifs.push({ tenantId, kind: "alert", title: "Paid providers are off", body: "Daily paid spend limit is $0 — creative and reasoning run in mock/test mode.", link: "/settings#limits", dedupeKey: "fx-paid-off", createdAt: ago(20 * HOUR) });
  notifs.push({ tenantId, kind: "success", title: "Delivery approved", body: "Client files released.", link: "/jobs", dedupeKey: "fx-delivered", readAt: ago(5 * DAY), createdAt: ago(7 * DAY) });
  await db.insert(notification).values(notifs).onConflictDoNothing();
  ev({ type: "budget.blocked", agent: "orchestrator", level: "warn", message: "Paid route skipped for Higgsfield: daily paid budget is $0 — using mock broker", createdAt: ago(6 * HOUR) });
  ev({ type: "source.refreshed", agent: "scout", level: "info", message: "Demo marketplace refreshed: 7 new, 2 duplicates skipped", createdAt: ago(11 * 60_000) });
  ev({ type: "source.refreshed", agent: "scout", level: "info", message: "Public web feeds refreshed: 3 new (RemoteOK, WWR)", createdAt: ago(42 * 60_000) });
  ev({ type: "provider.health", agent: "orchestrator", level: "info", message: "GX gateway healthy · 142ms · 3 models", createdAt: ago(9 * 60_000) });

  // --- Flush runs, events, ledger ------------------------------------------------------------
  const chunk = async <X,>(rows: X[], fn: (xs: X[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 200) await fn(rows.slice(i, i + 200));
  };
  await chunk(runs, (xs) => db.insert(agentRun).values(xs));
  events.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
  await chunk(events, (xs) => db.insert(agentEvent).values(xs));
  await chunk(ledger, (xs) => db.insert(costLedgerEntry).values(xs));
  // Touch-point audit rows so the goal has data.
  await db.execute(sql`insert into audit_event (tenant_id, actor_type, actor_id, action, subject_type, subject_id, from_state, to_state, created_at)
    select ${tenantId}, 'user', ${u.id}, 'proposal.transition', 'proposal', p.id, 'awaiting_approval', 'approved', p.approved_at from proposal p where p.tenant_id = ${tenantId} and p.approved_at is not null`);
  console.log(`inserted: ${made.length} opportunities, ${apps.length} applications, ${runs.length} runs, ${events.length} events, ${ledger.length} ledger rows`);
  console.log(`assets written via ${storage.driver} storage`);

  if (flag("live")) await live(tenantId);
}

/** Emits a believable trickle of activity so the SSE stream and live pages can be exercised. */
async function live(tenantId: string) {
  const db = getDb();
  console.log("live mode — emitting events every ~4s (Ctrl-C to stop)");
  const running = await db.select().from(workflowStep).where(and(eq(workflowStep.tenantId, tenantId), eq(workflowStep.status, "running")));
  let i = 0;
  const msgs = [
    { type: "source.refreshed", agent: "scout", message: "Demo marketplace refreshed: 2 new opportunities" },
    { type: "provider.health", agent: "orchestrator", message: "GX gateway healthy · 131ms" },
    { type: "agent.run", agent: "analyst", message: "Opportunity Analyst picked up 2 new listings" },
    { type: "cost.recorded", agent: "economics", message: "Recorded $0.18 simulated creative spend" },
  ];
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const m = msgs[i % msgs.length]!;
    const step = running[i % Math.max(1, running.length)];
    if (step && i % 3 === 0) {
      await db.insert(agentEvent).values({ tenantId, type: "step.started", agent: step.agent, level: "info", subjectType: "step", subjectId: step.id, jobId: step.jobId, message: `${step.name}: rendering batch ${1 + (i % 6)} of 6` });
    } else {
      await db.insert(agentEvent).values({ tenantId, type: m.type, agent: m.agent, level: "info", message: m.message });
    }
    await db.execute(sql`select pg_notify('gigpilot_events', ${tenantId})`);
    i++;
    process.stdout.write(".");
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
