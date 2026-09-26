import type { FetchOpportunitiesOptions, MarketWeight, ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities, SubmissionRequest, SubmissionResult } from "@gigpilot/contracts";

/**
 * Demo marketplace. Produces a realistic, deterministic feed of fictional
 * briefs across the six service families so demo workspaces exercise the
 * REAL pipeline (scout → analyst → economics → proposal → delivery).
 *
 * Determinism: items are introduced in 30-minute buckets seeded by
 * (tenantId, bucket). Each bucket introduces 3–8 new items with stable
 * external ids, and a batch returns the items of the most recent buckets
 * (25–40 items), so repeated refreshes never explode the table while the
 * radar keeps moving. Some items are low-budget, some are cross-posted
 * near-duplicates and some are already expired on arrival — exactly the
 * mess a real feed has. No network requests are made.
 */

export const MOCK_BUCKET_MINUTES = 30;
const BUCKET_MS = MOCK_BUCKET_MINUTES * 60_000;
const MIN_BATCH = 25;
const MAX_BATCH = 40;

type Family = "paid-social-ugc" | "image-design" | "localization-repurposing" | "ai-automation" | "web-app-builds" | "research-content";

interface Vars {
  brand: string;
  product: string;
  tone: string;
  days: number;
  n: number;
}

interface BriefTemplate {
  key: string;
  family: Family;
  budget: { type: "fixed" | "hourly"; min: number; max: number; hours?: number };
  skills: string[];
  products: string[];
  counts: number[];
  days: [number, number];
  title: (v: Vars) => string;
  body: (v: Vars) => string;
  /** High-value anchor used to guarantee pursue-worthy items in every batch. */
  anchor?: boolean;
}

const TONES = ["confident and playful", "warm, premium and understated", "direct, no-fluff", "energetic Gen-Z", "calm and clinical-credible", "friendly and expert"];

const CLIENTS: { name: string; country: string }[] = [
  { name: "Northwind Coffee Co.", country: "United States" },
  { name: "Brightline Dental Group", country: "United States" },
  { name: "Kelp & Co. Skincare", country: "Australia" },
  { name: "Atlas Freight Labs", country: "Netherlands" },
  { name: "Lumen Pet Supply", country: "Canada" },
  { name: "Verdant Home Goods", country: "United Kingdom" },
  { name: "Harbor & Pine Outfitters", country: "United States" },
  { name: "Quillstone Legal", country: "United Kingdom" },
  { name: "Tidewater Analytics", country: "United States" },
  { name: "Orchard Lane Bakery", country: "Ireland" },
  { name: "Cobalt Cycle Works", country: "Germany" },
  { name: "Fernhill Wellness", country: "New Zealand" },
  { name: "Mosaic Learning", country: "Singapore" },
  { name: "Pinecrest Realty Group", country: "United States" },
  { name: "Saltbox Studio", country: "Canada" },
  { name: "Ember & Oak Candles", country: "United States" },
  { name: "Nimbus HR", country: "Sweden" },
  { name: "Parcelpoint Logistics", country: "United Arab Emirates" },
  { name: "Juniper Health Clinic", country: "Australia" },
  { name: "Blue Heron Travel", country: "United States" },
  { name: "Copperleaf Finance", country: "United Kingdom" },
  { name: "Wildgrain Snacks", country: "United States" },
  { name: "Solace Sleep", country: "Germany" },
  { name: "Driftwood Surf Co.", country: "Australia" },
  { name: "Aurora Fitness Studios", country: "Canada" },
  { name: "Meridian SaaS", country: "United States" },
  { name: "Lattice Robotics", country: "Netherlands" },
  { name: "Honeycomb Kids", country: "France" },
  { name: "Riverstone Roasters", country: "United States" },
  { name: "Oakridge Accounting", country: "United States" },
  { name: "Nova Skin Lab", country: "United Kingdom" },
  { name: "Trailhead Gear", country: "United States" },
  { name: "Cedar & Salt Kitchen", country: "Ireland" },
  { name: "Beacon Insurance Brokers", country: "Canada" },
  { name: "Summit Solar", country: "United States" },
  { name: "Greenleaf Grocers", country: "United Kingdom" },
  { name: "Vantage Recruiting", country: "Singapore" },
];

const T: BriefTemplate[] = [
  // ---------------------------------------------------------------- paid social / UGC
  {
    key: "ugc-tiktok-launch",
    family: "paid-social-ugc",
    budget: { type: "fixed", min: 900, max: 1800 },
    skills: ["UGC", "TikTok Ads", "Video Editing", "Hooks", "Meta Ads"],
    products: ["collagen coffee creamer", "magnetic phone mount", "sleep gummies", "reusable coffee pods"],
    counts: [8, 10, 12],
    days: [7, 12],
    title: (v) => `UGC-style TikTok ads for our ${v.product} launch (${v.n} videos)`,
    body: (v) =>
      `We're launching ${v.product} and need ${v.n} UGC-style videos, 15s each, 9:16 for TikTok and Instagram Reels.\n\n` +
      `Deliverables:\n- ${v.n} videos (15s, 9:16, MP4, captions burned in)\n- 3 hook variants for the top 2 concepts\n- A short hook/script doc so we can brief creators later\n\n` +
      `We supply: product shots, brand guidelines (fonts, colours, logo) and 3 reference ads we love. Tone: ${v.tone}. ` +
      `Native, creator-to-camera feel — no stock-footage slideshows. Please deliver within ${v.days} days. Tools are up to you (CapCut/Premiere fine). ` +
      `Bonus if you've written hooks that got CPC under $1.`,
  },
  {
    key: "meta-static-pack",
    family: "paid-social-ugc",
    budget: { type: "fixed", min: 500, max: 1200 },
    skills: ["Meta Ads", "Ad Creative", "Figma", "Copywriting"],
    products: ["spring bundle offer", "free-shipping weekend", "subscription 20% off", "new flavour drop"],
    counts: [16, 20, 24],
    days: [5, 8],
    title: (v) => `Meta static ad creative pack — ${v.n} variants for ${v.product}`,
    body: (v) =>
      `Need ${v.n} static ad creatives for Meta (1:1 and 4:5) for our ${v.product} campaign. Structure: 4 angles (problem/solution, social proof, offer, founder story) × ${Math.round(v.n / 4)} variants.\n\n` +
      `Each creative needs a headline + primary text suggestion. We provide logo, brand fonts and 12 product photos (PNG, transparent). ` +
      `Figma source files preferred. Tone: ${v.tone}. Deadline: ${v.days} days. Previous agency made everything look like a template — we want thumb-stopping.`,
  },
  {
    key: "hook-editor-hourly",
    family: "paid-social-ugc",
    budget: { type: "hourly", min: 35, max: 65, hours: 20 },
    skills: ["Video Editing", "Hooks", "Reels", "Captions"],
    products: ["creator footage library", "founder vlog clips", "customer testimonial clips"],
    counts: [6, 8],
    days: [7, 10],
    title: (v) => `Editor + hook writer for ${v.n} paid social videos (hourly, ~20h)`,
    body: (v) =>
      `We have raw ${v.product} (about 40 clips, 4K) and need an editor who also writes hooks. Cut ${v.n} ads (9:16, 20–30s each), ` +
      `write 3 hook options per ad, add captions, music and simple motion graphics. Estimated ~20 hours this round; ongoing work if it performs. ` +
      `Brand kit supplied. Tone: ${v.tone}. First 2 edits within ${Math.max(3, v.days - 4)} days, the rest within ${v.days} days.`,
  },
  {
    key: "app-install-video",
    family: "paid-social-ugc",
    budget: { type: "fixed", min: 1500, max: 3000 },
    skills: ["UGC", "App Install Ads", "TikTok Ads", "Motion Graphics"],
    products: ["budgeting app", "language-learning app", "habit tracker app", "meal-planning app"],
    counts: [8, 10],
    days: [10, 14],
    title: (v) => `Scroll-stopping video ads for our ${v.product} install campaign`,
    body: (v) =>
      `Looking for ${v.n} video ads (20s, 9:16) plus 4 square (1:1) cutdowns for our ${v.product}. ` +
      `We'll share screen recordings, App Store screenshots and our best-performing ad as a benchmark (CPI $2.10). ` +
      `Need: hook in the first 1.5s, clear in-app demo, end card with store badges, captions. Tone: ${v.tone}. ` +
      `Deliver drafts in ${Math.round(v.days / 2)} days and finals in ${v.days} days. Please include your testing plan for hooks.`,
    anchor: true,
  },
  {
    key: "quick-ad-cuts",
    family: "paid-social-ugc",
    budget: { type: "fixed", min: 80, max: 150 },
    skills: ["Video Editing", "Reels"],
    products: ["existing brand video", "event recap footage"],
    counts: [2],
    days: [2, 3],
    title: () => `Quick edit: 2 short ad cuts from existing footage`,
    body: (v) =>
      `Need 2 short cuts (15s, 9:16) from our ${v.product}. Footage and music provided. Simple captions. Need it in ${v.days} days. Small budget, quick job.`,
  },
  {
    key: "creative-sprint",
    family: "paid-social-ugc",
    budget: { type: "fixed", min: 2000, max: 3500 },
    skills: ["Creative Strategy", "UGC", "Meta Ads", "TikTok Ads", "Static Ads"],
    products: ["DTC skincare line", "premium dog food", "ergonomic office chair"],
    counts: [12],
    days: [14, 21],
    title: (v) => `Creative strategist: 30-day ad testing sprint for a ${v.product}`,
    body: (v) =>
      `We're scaling a ${v.product} on Meta and TikTok and need a creative sprint: ${v.n} video concepts (15–30s, 9:16) and 24 static ads (1:1, 4:5), ` +
      `delivered in weekly drops with iteration based on our Ads Manager data (we'll share read-only access). ` +
      `Assets supplied: product photography, 30 customer reviews, brand guidelines. Tone: ${v.tone}. First drop within 7 days; full sprint ${v.days} days.`,
    anchor: true,
  },
  {
    key: "amazon-demo-ads",
    family: "paid-social-ugc",
    budget: { type: "fixed", min: 600, max: 1100 },
    skills: ["Product Video", "Amazon", "Video Editing"],
    products: ["cordless milk frother", "bamboo cutting board set", "travel neck pillow"],
    counts: [5, 6],
    days: [6, 9],
    title: (v) => `Faceless product demo videos for our ${v.product} Amazon listing`,
    body: (v) =>
      `Need ${v.n} faceless demo videos (30s, 16:9) for the Amazon listing plus ${v.n} vertical 9:16 versions for Sponsored Brands video. ` +
      `We'll ship samples and provide our listing copy and 8 lifestyle photos. Clean, ${v.tone} look; text overlays for key features. Deadline ${v.days} days.`,
  },
  // ---------------------------------------------------------------- image & design
  {
    key: "product-photo-edits",
    family: "image-design",
    budget: { type: "fixed", min: 400, max: 900 },
    skills: ["Product Photography", "Photoshop", "Retouching", "Shopify"],
    products: ["ceramic homeware", "handmade jewellery", "outdoor gear"],
    counts: [20, 25, 30],
    days: [5, 8],
    title: (v) => `${v.n} product images: white-background cleanup + lifestyle composites`,
    body: (v) =>
      `We sell ${v.product} on Shopify and need ${v.n} product images: white-background cleanup for ${Math.round(v.n * 0.6)} SKUs plus ${v.n - Math.round(v.n * 0.6)} lifestyle composites. ` +
      `Output: 2048×2048 PNG/JPG, consistent soft shadows, colour-accurate. We supply the raw photos (RAW + JPG) and 5 mood references. ` +
      `Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "yt-thumbnails",
    family: "image-design",
    budget: { type: "fixed", min: 250, max: 600 },
    skills: ["Thumbnail Design", "Photoshop", "YouTube"],
    products: ["personal finance channel", "home workshop channel", "tech review channel"],
    counts: [10, 12, 15],
    days: [5, 7],
    title: (v) => `YouTube thumbnail designer — ${v.n} thumbnails for a ${v.product}`,
    body: (v) =>
      `Need ${v.n} thumbnails (1280×720, 16:9) for our ${v.product}. High-contrast, readable at mobile size, max 4 words of text. ` +
      `We provide video titles, face cut-outs and our current CTR baseline (4.1%). Tone: ${v.tone}. ${v.days}-day turnaround.`,
  },
  {
    key: "brand-social-system",
    family: "image-design",
    budget: { type: "fixed", min: 1200, max: 2500 },
    skills: ["Brand Design", "Figma", "Canva", "Social Media Design"],
    products: ["boutique fitness studio", "B2B fintech", "specialty coffee roaster"],
    counts: [24, 30],
    days: [10, 14],
    title: (v) => `Brand refresh: ${v.n} social templates + visual system for a ${v.product}`,
    body: (v) =>
      `We're a ${v.product} refreshing our look. Need ${v.n} Instagram/LinkedIn templates (1:1 and 4:5) in Figma and Canva, a colour palette, type scale and 6 icon/graphic elements. ` +
      `Existing logo and brand guidelines supplied (we're keeping the logo). Tone: ${v.tone}. Deliver in ${v.days} days with a one-page usage guide.`,
  },
  {
    key: "logo-resize",
    family: "image-design",
    budget: { type: "fixed", min: 60, max: 120 },
    skills: ["Logo", "Illustrator"],
    products: ["bakery logo", "podcast logo"],
    counts: [3],
    days: [1, 2],
    title: (v) => `Resize ${v.product} + 3 banner sizes`,
    body: (v) => `Need our ${v.product} cleaned up as SVG and exported to 3 banner sizes (Facebook cover, LinkedIn banner, email header). Files supplied. ${v.days} days.`,
  },
  {
    key: "saas-hero-illustrations",
    family: "image-design",
    budget: { type: "fixed", min: 700, max: 1400 },
    skills: ["Illustration", "SaaS", "Figma", "Web Design"],
    products: ["scheduling platform", "security compliance tool", "AI note-taker"],
    counts: [6, 8],
    days: [7, 10],
    title: (v) => `${v.n} illustrated hero images for our ${v.product} landing page`,
    body: (v) =>
      `We need ${v.n} custom hero/section illustrations (16:9, SVG + PNG @2x) for the new landing page of our ${v.product}. ` +
      `Style references and page wireframes supplied; must match our brand palette. Tone: ${v.tone}. Deliver in ${v.days} days.`,
  },
  {
    key: "etsy-mockups",
    family: "image-design",
    budget: { type: "fixed", min: 350, max: 700 },
    skills: ["Mockups", "Etsy", "Photoshop"],
    products: ["printable wall art", "custom tote bags", "wedding stationery"],
    counts: [30, 40],
    days: [5, 7],
    title: (v) => `Etsy listing mockups — ${v.n} images for ${v.product}`,
    body: (v) =>
      `Need ${v.n} listing mockup images (2000×2000, 1:1) for ${v.product}: room scenes, flat-lays and a size guide graphic. ` +
      `We supply the artwork files (PDF/PNG). Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "deck-polish-hourly",
    family: "image-design",
    budget: { type: "hourly", min: 40, max: 70, hours: 15 },
    skills: ["Presentation Design", "Google Slides", "Keynote"],
    products: ["Series A pitch deck", "sales deck"],
    counts: [18, 22],
    days: [4, 6],
    title: (v) => `Visual polish for our ${v.product} (${v.n} slides, hourly)`,
    body: (v) =>
      `Our ${v.product} has solid content but looks dated. Redesign ${v.n} slides in Google Slides: charts, icons, consistent layouts. ~15 hours estimated. ` +
      `Brand assets supplied. Tone: ${v.tone}. Needed in ${v.days} days.`,
  },
  // ---------------------------------------------------------------- localization & repurposing
  {
    key: "subtitle-localise",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 900, max: 1600 },
    skills: ["Subtitles", "Translation", "Localization", "Premiere Pro"],
    products: ["product tutorial videos", "course lessons", "customer story videos"],
    counts: [10, 12],
    days: [8, 12],
    title: (v) => `Localise ${v.n} ${v.product} into Spanish, German and French (subtitles)`,
    body: (v) =>
      `We have ${v.n} ${v.product} (avg 90s each) in English. Need SRT subtitles in Spanish, German and French plus burned-in MP4 versions. ` +
      `We provide English transcripts, the Premiere projects and a glossary of 40 brand terms that must not be translated. ` +
      `Native-level quality, reading speed ≤ 17 cps. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "webinar-clips",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 800, max: 1500 },
    skills: ["Repurposing", "Video Editing", "Captions", "Short-form"],
    products: ["webinars", "conference talks", "podcast video episodes"],
    counts: [30, 40],
    days: [7, 10],
    title: (v) => `Repurpose 4 ${v.product} into ${v.n} short clips`,
    body: (v) =>
      `Turn 4 recorded ${v.product} (~60 min each) into ${v.n} short clips (9:16, 30–60s) with animated captions, a title hook and our lower-third. ` +
      `We supply recordings and brand kit. Pick the strongest moments; add a short caption per clip for LinkedIn. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "helpcenter-ptbr",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 1200, max: 2200 },
    skills: ["Translation", "Portuguese", "Localization", "Zendesk"],
    products: ["help-center articles", "knowledge-base articles"],
    counts: [50, 60],
    days: [10, 14],
    title: (v) => `Translate ${v.n} ${v.product} EN → Brazilian Portuguese`,
    body: (v) =>
      `Translate ${v.n} ${v.product} (avg 600 words) from English to Brazilian Portuguese, keeping Markdown formatting and UI string names. ` +
      `Glossary and style guide supplied; export via Zendesk Guide. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "dub-explainers",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 600, max: 1200 },
    skills: ["Dubbing", "Voiceover", "Spanish", "AI Voice"],
    products: ["explainer videos", "onboarding videos"],
    counts: [5, 6],
    days: [6, 9],
    title: (v) => `Dub ${v.n} ${v.product} into Spanish (AI voice OK)`,
    body: (v) =>
      `We need ${v.n} ${v.product} (2–3 min each) dubbed into Spanish. AI voice is fine if natural; we care about timing and terminology. ` +
      `Scripts and project files supplied. Deliver MP4 + SRT. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "blurb-italian",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 40, max: 90 },
    skills: ["Translation", "Italian"],
    products: ["product blurb"],
    counts: [1],
    days: [1, 2],
    title: () => `Translate a 300-word product blurb to Italian`,
    body: (v) => `Short job: translate a 300-word ${v.product} into Italian for our webshop. Needed in ${v.days} days.`,
  },
  {
    key: "podcast-repurpose",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 700, max: 1300 },
    skills: ["Repurposing", "Content Writing", "Social Media"],
    products: ["B2B podcast", "founder podcast"],
    counts: [8],
    days: [8, 12],
    title: (v) => `Repurpose ${v.n} ${v.product} episodes into blogs + social posts`,
    body: (v) =>
      `For each of ${v.n} episodes of our ${v.product}: one 1,000-word blog post, 5 LinkedIn posts and 3 quote graphics (1:1). ` +
      `Transcripts supplied. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "appstore-9lang",
    family: "localization-repurposing",
    budget: { type: "fixed", min: 450, max: 900 },
    skills: ["App Store Optimization", "Localization", "Translation"],
    products: ["meditation app", "photo editor app"],
    counts: [9],
    days: [5, 8],
    title: (v) => `App Store listing localisation for our ${v.product} — ${v.n} languages`,
    body: (v) =>
      `Localise our ${v.product} App Store + Google Play listing (title, subtitle, keywords, description, 6 screenshot captions) into ${v.n} languages: ` +
      `Spanish, German, French, Italian, Portuguese, Japanese, Korean, Dutch and Swedish. Keyword research per locale appreciated. Deadline ${v.days} days.`,
  },
  // ---------------------------------------------------------------- AI automation & agents
  {
    key: "shopify-hubspot-n8n",
    family: "ai-automation",
    budget: { type: "fixed", min: 1800, max: 3200 },
    skills: ["n8n", "Shopify", "HubSpot", "API Integration", "Automation"],
    products: ["Shopify → HubSpot"],
    counts: [1],
    days: [8, 12],
    title: () => `Shopify → HubSpot order & customer sync in n8n`,
    body: (v) =>
      `We need a reliable Shopify → HubSpot sync built in our self-hosted n8n. Sync orders, customers and line items to HubSpot contacts and deals in near real time.\n\n` +
      `Requirements:\n- Webhook triggers (orders/create, orders/updated, customers/update)\n- Dedupe contacts by email, map line items to deal products\n- Retry with backoff on 429s, dead-letter log\n- Slack alert on failures\n- README + runbook, handover call\n\n` +
      `Access to a staging store and HubSpot sandbox provided. Deliver in ${v.days} days. Tone for docs: ${v.tone}.`,
    anchor: true,
  },
  {
    key: "zendesk-ai-triage",
    family: "ai-automation",
    budget: { type: "fixed", min: 2500, max: 4000 },
    skills: ["AI Agents", "OpenAI", "Zendesk", "LLM", "Python"],
    products: ["Zendesk"],
    counts: [1],
    days: [12, 18],
    title: () => `AI support triage agent for Zendesk (LLM + our help docs)`,
    body: (v) =>
      `Build an AI agent that triages incoming Zendesk tickets: classify intent (billing, bug, how-to, refund), set priority, draft a first reply grounded in our 180 help-center articles, ` +
      `and escalate low-confidence cases to humans. Must log every decision for audit. We supply API access, 2,000 historical tickets for evaluation and our tone guide. ` +
      `Success = 70%+ correct routing on the eval set. Timeline ${v.days} days.`,
    anchor: true,
  },
  {
    key: "invoice-ocr-xero",
    family: "ai-automation",
    budget: { type: "fixed", min: 1500, max: 2800 },
    skills: ["Automation", "OCR", "Xero", "Gmail API", "Make.com"],
    products: ["Gmail → Xero"],
    counts: [1],
    days: [8, 12],
    title: () => `Automate supplier invoices: Gmail → OCR → Xero bills`,
    body: (v) =>
      `We receive ~300 supplier invoices/month by email. Automate: watch a Gmail label, extract invoice fields with OCR/LLM (supplier, number, date, line items, VAT), ` +
      `create draft bills in Xero, attach the PDF, and flag anomalies (duplicates, totals mismatch) to a Slack channel. Make.com or code, your call. ` +
      `Sample invoices (40 PDFs) supplied. Deliver in ${v.days} days with a runbook.`,
    anchor: true,
  },
  {
    key: "lead-enrichment",
    family: "ai-automation",
    budget: { type: "fixed", min: 1500, max: 2400 },
    skills: ["Automation", "Airtable", "Zapier", "Clearbit", "Slack"],
    products: ["Typeform → Airtable"],
    counts: [1],
    days: [7, 10],
    title: () => `Lead enrichment pipeline: Typeform → enrichment → Airtable → Slack`,
    body: (v) =>
      `When a lead submits our Typeform, enrich it (company size, industry, LinkedIn) via an enrichment API, score it with our ICP rules, store in Airtable and post hot leads to Slack with a summary. ` +
      `Handle rate limits and missing data gracefully. We'll provide API keys for a sandbox. Deliver in ${v.days} days, documented.`,
    anchor: true,
  },
  {
    key: "rag-assistant",
    family: "ai-automation",
    budget: { type: "fixed", min: 3000, max: 4000 },
    skills: ["RAG", "LLM", "Notion API", "Google Drive API", "Vector Database"],
    products: ["Notion + Google Drive"],
    counts: [1],
    days: [14, 20],
    title: () => `Internal knowledge assistant (RAG) over Notion + Google Drive`,
    body: (v) =>
      `Build an internal Slack assistant that answers questions from our Notion workspace (~1,200 pages) and a Google Drive folder (~400 docs). ` +
      `Needs incremental sync, permission-aware retrieval, citations in every answer, and an admin page to re-index. Our stack: TypeScript, Postgres. ` +
      `Deliver in ${v.days} days with evaluation results on 50 sample questions.`,
    anchor: true,
  },
  {
    key: "make-cleanup-hourly",
    family: "ai-automation",
    budget: { type: "hourly", min: 60, max: 110, hours: 25 },
    skills: ["Make.com", "Automation", "Error Handling"],
    products: ["Make.com"],
    counts: [14],
    days: [10, 14],
    title: (v) => `Make.com scenario cleanup + error handling (${v.n} scenarios, hourly)`,
    body: (v) =>
      `We have ${v.n} Make.com scenarios built over 2 years that fail silently. Audit them, add error handlers and alerting, consolidate duplicates and document each flow. ` +
      `Estimated ~25 hours. Admin access provided. Start this week; complete within ${v.days} days.`,
  },
  {
    key: "zapier-dup-fix",
    family: "ai-automation",
    budget: { type: "fixed", min: 80, max: 150 },
    skills: ["Zapier", "Google Sheets"],
    products: ["Zapier"],
    counts: [1],
    days: [1, 2],
    title: () => `Zapier fix: duplicate rows in Google Sheets`,
    body: (v) => `Our Zap creates duplicate rows in Google Sheets when a form is edited. Need a quick fix and a short explanation. ${v.days} days.`,
  },
  // ---------------------------------------------------------------- web & app builds
  {
    key: "nextjs-marketing-site",
    family: "web-app-builds",
    budget: { type: "fixed", min: 2500, max: 5500 },
    skills: ["Next.js", "React", "Tailwind", "Headless CMS", "Website"],
    products: ["climate-tech startup", "boutique law firm", "specialty clinic"],
    counts: [8, 10],
    days: [14, 21],
    title: (v) => `Next.js marketing website for a ${v.product} (${v.n} pages + CMS)`,
    body: (v) =>
      `We need a fast, accessible Next.js website for our ${v.product}: ${v.n} pages (home, about, services, 3 case studies, blog index/post, contact) with a headless CMS (Sanity or similar) for the blog and case studies. ` +
      `Figma designs are ready. Must score 90+ on Lighthouse, include SEO metadata, sitemap and a contact form with spam protection. Tone: ${v.tone}. Launch in ${v.days} days.`,
    anchor: true,
  },
  {
    key: "shopify-landing",
    family: "web-app-builds",
    budget: { type: "fixed", min: 1200, max: 2400 },
    skills: ["Shopify", "Liquid", "Landing Page", "CRO"],
    products: ["skincare brand", "coffee subscription", "pet supplements"],
    counts: [3],
    days: [8, 12],
    title: (v) => `Shopify theme customisation + ${v.n} landing pages for a ${v.product}`,
    body: (v) =>
      `Customise our Dawn-based Shopify theme and build ${v.n} campaign landing pages (sections reusable in the theme editor). ` +
      `Designs supplied in Figma; must be mobile-first with fast LCP. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "client-portal-mvp",
    family: "web-app-builds",
    budget: { type: "fixed", min: 4000, max: 6000 },
    skills: ["Next.js", "Supabase", "Stripe", "MVP", "Web App"],
    products: ["bookkeeping practice", "design agency", "physio clinic"],
    counts: [1],
    days: [21, 30],
    title: (v) => `MVP: client portal with Stripe billing for a ${v.product}`,
    body: (v) =>
      `Build an MVP client portal for our ${v.product}: magic-link login, document upload/download, request tracking, and Stripe subscription billing with customer portal. ` +
      `Stack: Next.js + Supabase (Postgres, storage). Wireframes supplied. Include tests for billing webhooks and a deployment guide. Timeline ${v.days} days.`,
    anchor: true,
  },
  {
    key: "webflow-migration",
    family: "web-app-builds",
    budget: { type: "fixed", min: 3000, max: 5000 },
    skills: ["Webflow", "Next.js", "Migration", "SEO"],
    products: ["B2B SaaS", "media publication"],
    counts: [30],
    days: [18, 25],
    title: (v) => `Webflow → Next.js migration (${v.n} pages) for a ${v.product}`,
    body: (v) =>
      `Migrate our ${v.product} website (${v.n} pages + 120 blog posts) from Webflow to Next.js with MDX. Preserve URLs and SEO (redirect map, metadata), improve Core Web Vitals. ` +
      `Designs stay the same. Deadline ${v.days} days.`,
  },
  {
    key: "ops-dashboard-hourly",
    family: "web-app-builds",
    budget: { type: "hourly", min: 70, max: 120, hours: 40 },
    skills: ["React", "Postgres", "Dashboard", "TypeScript"],
    products: ["logistics ops team", "support team"],
    counts: [6],
    days: [14, 21],
    title: (v) => `Internal KPI dashboard for our ${v.product} (React + Postgres, hourly)`,
    body: (v) =>
      `Build an internal dashboard for our ${v.product}: ${v.n} KPI views, filters, CSV export, role-based access. Read-only Postgres replica provided. ~40 hours estimated. ` +
      `Complete within ${v.days} days.`,
  },
  {
    key: "waitlist-landing",
    family: "web-app-builds",
    budget: { type: "fixed", min: 400, max: 900 },
    skills: ["Landing Page", "Next.js", "Tailwind"],
    products: ["AI writing tool", "smart water bottle"],
    counts: [1],
    days: [4, 6],
    title: (v) => `One-page waitlist landing page for our ${v.product}`,
    body: (v) =>
      `Need a fast one-page waitlist site for our ${v.product}: hero, 3 feature sections, FAQ, email capture to our Mailchimp list. Copy supplied. Tone: ${v.tone}. ${v.days} days.`,
  },
  {
    key: "wp-menu-bug",
    family: "web-app-builds",
    budget: { type: "fixed", min: 50, max: 120 },
    skills: ["WordPress", "CSS"],
    products: ["WordPress site"],
    counts: [1],
    days: [1, 2],
    title: () => `Fix mobile menu bug on our WordPress site`,
    body: (v) => `Mobile menu doesn't close after tapping a link on our ${v.product}. Quick fix needed within ${v.days} days.`,
  },
  // ---------------------------------------------------------------- research & content
  {
    key: "competitor-landscape",
    family: "research-content",
    budget: { type: "fixed", min: 800, max: 1600 },
    skills: ["Market Research", "Competitive Analysis", "Excel"],
    products: ["DTC pet food", "plant-based protein", "smart home security"],
    counts: [12, 15],
    days: [7, 10],
    title: (v) => `Market research: ${v.product} competitor landscape (${v.n} brands)`,
    body: (v) =>
      `We need a competitor landscape of ${v.n} ${v.product} brands: positioning, pricing tiers, channels, ad angles (Meta Ad Library), review themes and estimated traffic. ` +
      `Deliver a 10–15 page report with an executive summary, comparison table (Google Sheets) and 5 opportunity recommendations. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "seo-content-engine",
    family: "research-content",
    budget: { type: "fixed", min: 1200, max: 2400 },
    skills: ["SEO", "Content Writing", "Keyword Research", "Blog"],
    products: ["HR software", "accounting SaaS", "home energy"],
    counts: [8, 12],
    days: [14, 21],
    title: (v) => `SEO content engine: ${v.n} long-form articles for ${v.product}`,
    body: (v) =>
      `Build our SEO content engine: keyword clustering for ${v.product}, a content brief template, and ${v.n} long-form articles (1,800–2,200 words) optimised for search intent with internal linking. ` +
      `We provide our keyword list, product docs and brand voice guide. Tone: ${v.tone}. Deliver over ${v.days} days.`,
  },
  {
    key: "newsletter-ghostwriting",
    family: "research-content",
    budget: { type: "fixed", min: 500, max: 1000 },
    skills: ["Newsletter", "Ghostwriting", "B2B", "Content"],
    products: ["B2B SaaS founder", "supply-chain consultancy"],
    counts: [4],
    days: [10, 14],
    title: (v) => `Ghostwrite ${v.n} newsletter issues for a ${v.product}`,
    body: (v) =>
      `Ghostwrite ${v.n} weekly newsletter issues (900–1,200 words) for a ${v.product}. We supply topic notes and voice memos; you research, structure and write. ` +
      `Tone: ${v.tone}. First issue within 5 days, all within ${v.days} days.`,
  },
  {
    key: "ticket-knowledge-base",
    family: "research-content",
    budget: { type: "fixed", min: 900, max: 1800 },
    skills: ["Knowledge Base", "Technical Writing", "Support"],
    products: ["support tickets"],
    counts: [200],
    days: [10, 14],
    title: (v) => `Build an internal knowledge base from ${v.n} ${v.product}`,
    body: (v) =>
      `Analyse ${v.n} resolved ${v.product} (CSV export supplied), cluster the recurring issues and write 25 knowledge-base articles with troubleshooting steps. ` +
      `Include a taxonomy and a gap report. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "interview-synthesis",
    family: "research-content",
    budget: { type: "fixed", min: 700, max: 1300 },
    skills: ["User Research", "Synthesis", "Research"],
    products: ["customer interview transcripts"],
    counts: [18],
    days: [6, 9],
    title: (v) => `Synthesise ${v.n} ${v.product} into insights + personas`,
    body: (v) =>
      `We ran ${v.n} customer interviews (transcripts supplied). Need a synthesis: themes with quotes, 3 personas, jobs-to-be-done, and prioritised opportunities. ` +
      `Deliver as a report + Miro-ready summary. Tone: ${v.tone}. Deadline ${v.days} days.`,
  },
  {
    key: "proofread-post",
    family: "research-content",
    budget: { type: "fixed", min: 40, max: 80 },
    skills: ["Proofreading", "Editing"],
    products: ["blog post"],
    counts: [1],
    days: [1, 2],
    title: () => `Proofread a 1,500-word blog post`,
    body: (v) => `Quick proofread and light edit of a 1,500-word ${v.product}. Needed in ${v.days} days.`,
  },
  {
    key: "pricing-teardown-hourly",
    family: "research-content",
    budget: { type: "hourly", min: 45, max: 80, hours: 16 },
    skills: ["Pricing Research", "SaaS", "Competitive Analysis"],
    products: ["HR SaaS tools", "email marketing tools"],
    counts: [10],
    days: [7, 10],
    title: (v) => `Competitive pricing teardown: ${v.n} ${v.product} (hourly)`,
    body: (v) =>
      `Research and compare pricing/packaging of ${v.n} ${v.product}: tiers, value metrics, discounts, free-trial terms. ~16 hours. Deliver a spreadsheet + 2-page memo within ${v.days} days.`,
  },
];

// ------------------------------------------------------------------ helpers

function fnv(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

function round(n: number, step: number): number {
  return Math.max(step, Math.round(n / step) * step);
}

const ANCHORS = T.filter((t) => t.anchor);
const NON_ANCHORS = T.filter((t) => !t.anchor);

/** Normalised family weights (only positive weights of known families), or null when unweighted. */
function familyWeights(weights: MarketWeight[] | undefined): { family: Family; w: number }[] | null {
  if (!weights || weights.length === 0) return null;
  const known = new Set(T.map((t) => t.family));
  const list = weights
    .filter((m) => known.has(m.key as Family) && Number.isFinite(m.weight) && m.weight > 0)
    .map((m) => ({ family: m.key as Family, w: m.weight }));
  const total = list.reduce((a, x) => a + x.w, 0);
  if (total <= 0) return null;
  return list.map((x) => ({ family: x.family, w: x.w / total }));
}

/** Deterministic weighted pick: u ∈ [0,1) → family by cumulative weight. */
function pickFamily(weights: { family: Family; w: number }[], u: number): Family {
  let acc = 0;
  for (const x of weights) {
    acc += x.w;
    if (u < acc) return x.family;
  }
  return weights[weights.length - 1]!.family;
}

/** Stable signature of a weight set (part of the item id so a changed allocation yields new items). */
function weightSignature(weights: { family: Family; w: number }[] | null): string {
  if (!weights) return "";
  return fnv(weights.map((x) => `${x.family}:${x.w.toFixed(3)}`).join("|")).toString(36).slice(0, 5);
}

export interface MockSourceOptions {
  now?: () => Date;
}

export class MockSource implements SourceAdapter {
  readonly key = "mock";
  readonly name = "Demo marketplace";
  readonly capabilities: SourceCapabilities = {
    canSearch: true,
    canSubmit: true,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "mock",
    backgroundPollingAllowed: true,
    minPollIntervalMinutes: 15,
    maxCacheTtlHours: null,
    compliance: "Simulated demo marketplace — fictional briefs, no external requests; submissions are simulated after owner approval.",
  };

  private readonly now: () => Date;

  constructor(opts: MockSourceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    return {
      status: "mock",
      detail: "Demo marketplace — deterministic fictional feed (3–8 new briefs every 30 minutes)",
      checkedAt: new Date().toISOString(),
      meta: { templates: T.length },
    };
  }

  /**
   * Items introduced in one bucket (deterministic per tenant + bucket [+ weights]). With
   * Market Lab `weights`, each item's service family is sampled proportionally to the
   * weights (a 0-weight / disabled market never appears) and the item ids carry a weight
   * signature, so changing the allocation changes what the next refresh brings in.
   */
  bucketItems(tenantId: string, bucket: number, weights?: MarketWeight[]): RawOpportunity[] {
    const seed = fnv(`${tenantId}|${bucket}`);
    const count = 3 + (seed % 6); // 3–8
    const bucketStart = bucket * BUCKET_MS;
    const fw = familyWeights(weights);
    const sig = weightSignature(fw);
    const tShort = `${tenantId.replace(/-/g, "").slice(0, 8)}${sig ? `w${sig}` : ""}`;
    const items: RawOpportunity[] = [];
    for (let i = 0; i < count; i++) {
      const s = fnv(`${tenantId}|${bucket}|${i}`);
      const crossPost = i === count - 1 && count >= 4 && seed % 4 === 1;
      const stale = i === 1 && seed % 3 === 0;
      // Templates rotate deterministically so the same brief rarely repeats inside one feed window.
      const offset = fnv(tenantId);
      let template: BriefTemplate | null;
      if (crossPost) template = null;
      else if (!fw) {
        template = i === 0 ? ANCHORS[(offset + bucket) % ANCHORS.length]! : NON_ANCHORS[(offset + bucket * 7 + (i - 1)) % NON_ANCHORS.length]!;
      } else {
        const family = pickFamily(fw, (fnv(`${tenantId}|${bucket}|${i}|family`) % 10_000) / 10_000);
        const anchors = ANCHORS.filter((t) => t.family === family);
        const pool = i === 0 && anchors.length ? anchors : T.filter((t) => t.family === family && (i === 0 || !t.anchor || anchors.length === 0 || (s >>> 2) % 3 === 0));
        const list = pool.length ? pool : T.filter((t) => t.family === family);
        template = list[(offset + bucket * 7 + i) % list.length]!;
      }
      if (crossPost) {
        const original = items[0]!;
        items.push({
          ...original,
          externalId: `mock-${tShort}-${bucket}-${i}`,
          title: `${original.title.replace(/^(.)/, (c) => c.toUpperCase())} — reposted`,
          description: `Also posted on another board, same brief below.\n\n${original.description}`,
          proposalsCount: (original.proposalsCount ?? 0) + 3,
          raw: { ...(original.raw ?? {}), crossPostOf: original.externalId, crossPostedFrom: "another marketplace" },
        });
        continue;
      }
      items.push(this.materialise(template!, { tenantId, tShort, bucket, i, s, bucketStart, stale }));
    }
    return items;
  }

  private materialise(
    t: BriefTemplate,
    ctx: { tenantId: string; tShort: string; bucket: number; i: number; s: number; bucketStart: number; stale: boolean },
  ): RawOpportunity {
    const { s } = ctx;
    const client = pick(CLIENTS, s >>> 3);
    const days = t.days[0] + ((s >>> 5) % (t.days[1] - t.days[0] + 1));
    const vars: Vars = {
      brand: client.name,
      product: pick(t.products, s >>> 7),
      tone: pick(TONES, s >>> 9),
      days,
      n: pick(t.counts, s >>> 11),
    };
    let postedAt = new Date(ctx.bucketStart - (ctx.i + 1) * 3 * 60_000 - ((s >>> 13) % 3) * 60_000);
    let deadlineAt = new Date(postedAt.getTime() + days * 86_400_000);
    if (ctx.stale) {
      // Old listing still circulating in the feed: expired on arrival.
      const variant = (s >>> 15) % 2;
      postedAt = new Date(ctx.bucketStart - (5 + ((s >>> 17) % 4)) * 86_400_000);
      deadlineAt = variant === 0 ? new Date(ctx.bucketStart - 86_400_000) : new Date(postedAt.getTime() + days * 86_400_000);
    }
    const spread = t.budget.max - t.budget.min;
    const r1 = ((s >>> 4) % 1000) / 1000;
    let budgetMinUsd: number;
    let budgetMaxUsd: number;
    if (t.budget.type === "hourly") {
      budgetMinUsd = t.budget.min;
      budgetMaxUsd = t.budget.max;
    } else if ((s >>> 19) % 2 === 0) {
      const v = round(t.budget.min + spread * r1, t.budget.max >= 1000 ? 100 : 10);
      budgetMinUsd = v;
      budgetMaxUsd = v;
    } else {
      const lo = round(t.budget.min + spread * r1 * 0.5, t.budget.max >= 1000 ? 100 : 10);
      budgetMinUsd = lo;
      budgetMaxUsd = Math.max(lo, round(lo + spread * 0.45, t.budget.max >= 1000 ? 100 : 10));
    }
    const ageHours = Math.max(0, (this.now().getTime() - postedAt.getTime()) / 3_600_000);
    const newClient = (s >>> 21) % 5 === 0;
    return {
      sourceKey: this.key,
      externalId: `mock-${ctx.tShort}-${ctx.bucket}-${ctx.i}`,
      title: t.title(vars),
      description: t.body(vars),
      clientName: client.name,
      clientCountry: client.country,
      clientRating: newClient ? undefined : Math.round((3.9 + ((s >>> 23) % 12) / 10) * 10) / 10,
      clientSpendUsd: newClient ? 0 : round(((s >>> 6) % 250) * 1000 + 500, 100),
      budgetType: t.budget.type,
      budgetMinUsd,
      budgetMaxUsd,
      currency: "USD",
      skills: t.skills,
      postedAt: postedAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      proposalsCount: Math.min(50, Math.round(((s >>> 25) % 12) + ageHours * 0.8)),
      raw: {
        demo: true,
        template: t.key,
        family: t.family,
        estimatedHours: t.budget.hours ?? null,
        ingestion: "mock",
      },
    };
  }

  async fetchOpportunities(opts: FetchOpportunitiesOptions): Promise<RawOpportunity[]> {
    const current = Math.floor(this.now().getTime() / BUCKET_MS);
    const limit = Math.min(MAX_BATCH, Math.max(1, opts.limit ?? MAX_BATCH));
    const out: RawOpportunity[] = [];
    for (let b = current; b > current - 24 && out.length < MIN_BATCH + 5; b--) {
      out.push(...this.bucketItems(opts.tenantId, b, opts.weights));
    }
    // Newest first; cap to the batch size.
    const batch = out.slice(0, Math.min(limit, MAX_BATCH));
    if (opts.query) {
      const q = opts.query.toLowerCase();
      return batch.filter((o) => `${o.title} ${o.description} ${(o.skills ?? []).join(" ")}`.toLowerCase().includes(q));
    }
    return batch;
  }

  async submit(req: SubmissionRequest): Promise<SubmissionResult> {
    return {
      status: "submitted",
      externalRef: `mock-${fnv(req.idempotencyKey).toString(36)}`,
      detail: `Submitted to the demo marketplace (simulated) at $${Math.round(req.amountUsd)} over ${req.periodDays} days`,
    };
  }
}

export const MOCK_TEMPLATE_COUNT = T.length;
