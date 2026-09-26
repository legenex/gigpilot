import type { OpportunityAnalysis } from "@gigpilot/contracts";
import { triageBudget, type MarketDescriptor } from "@gigpilot/economics";
import { clamp, familyLabel, money } from "../lib/util";
import { templateForFamily, type TemplateContext } from "./workflows";

/**
 * Deterministic, keyword-driven opportunity analyser. It is the mock-mode
 * answer for the `analyse_opportunity` task and the sanity baseline for real
 * model output. It estimates QUANTITIES only (deliverables, units, attempts,
 * hours); every dollar is computed later by @gigpilot/economics.
 */

export interface AnalysisInput {
  title: string;
  description: string;
  skills: string[];
  sourceKey: string;
  budgetType: "fixed" | "hourly" | "unknown";
  budgetMinUsd: number | null;
  budgetMaxUsd: number | null;
  deadlineAt: Date | null;
  postedAt: Date | null;
  clientName: string | null;
  clientRating: number | null;
  clientSpendUsd: number | null;
  proposalsCount: number | null;
  marketKey: string | null;
}

export const FAMILY_KEYWORDS: Record<string, string[]> = {
  "paid-social-ugc": ["ugc", "tiktok", "reels", "meta ads", "facebook ads", "ad creative", "ad creatives", "static ads", "hook", "hooks", "paid social", "app install", "ads manager", "sponsored brands", "cpc", "cpi", "video ads", "ad testing", "cutdowns", "product demo", "demo videos", "faceless", "amazon listing", "reels"],
  "image-design": ["thumbnail", "thumbnails", "product images", "product image", "retouch", "retouching", "mockup", "mockups", "illustration", "illustrations", "illustrated", "brand refresh", "templates", "logo", "banner", "slides", "deck", "canva", "photoshop", "white-background", "composites"],
  "localization-repurposing": ["translate", "translation", "localise", "localize", "localisation", "localization", "subtitles", "srt", "dub", "dubbed", "dubbing", "voiceover", "repurpose", "short clips", "transcripts", "languages", "glossary"],
  "ai-automation": ["automation", "automate", "n8n", "zapier", "make.com", "webhook", "webhooks", "ai agent", "agent", "llm", "rag", "openai", "sync", "pipeline", "integration", "ocr", "triage", "enrichment", "scenarios", "slack alert", "xero", "hubspot"],
  "web-app-builds": ["website", "next.js", "landing page", "landing pages", "web app", "mvp", "webflow", "shopify theme", "wordpress", "react", "dashboard", "portal", "supabase", "lighthouse", "liquid", "migration", "tailwind", "stripe"],
  "research-content": ["research", "competitor", "landscape", "seo", "articles", "newsletter", "ghostwrite", "knowledge base", "knowledge-base", "synthesis", "synthesise", "interviews", "personas", "pricing", "teardown", "proofread", "report", "keyword"],
};

const LANGUAGES = ["Spanish", "German", "French", "Italian", "Portuguese", "Japanese", "Korean", "Dutch", "Swedish", "Chinese", "Arabic", "Polish", "Turkish", "Hindi", "Norwegian", "Danish", "Finnish"];

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

const NOUNS: Record<string, string> = {
  videos: "video", video: "video", clips: "clip", clip: "clip", cuts: "video", cutdowns: "video", ads: "ad", creatives: "static", images: "static", image: "static",
  thumbnails: "static", graphics: "static", templates: "static", illustrations: "static", mockups: "static", photos: "photo", slides: "slide", articles: "article",
  posts: "post", issues: "issue", pages: "page", languages: "language", scenarios: "scenario", brands: "brand", transcripts: "transcript", tickets: "ticket",
  episodes: "episode", variants: "variant", hooks: "hook", options: "variant", skus: "sku", lessons: "lesson", interviews: "interview", tools: "tool", views: "view", concepts: "video",
};

const SUPPLY_START =
  /^(we('| wi)?ll (supply|provide|share|ship)|we (supply|provide|have|ran|receive|sell|also have)|assets supplied|access to|brand kit|designs supplied|glossary|scripts and project|transcripts supplied|footage and music|files supplied|copy supplied|sample invoices|style references|existing logo|figma designs|wireframes|admin access|read-only|our stack|sample)/i;

export interface ParsedBrief {
  sentences: { text: string; supplied: boolean }[];
  counts: { kind: string; n: number; context: string; supplied: boolean }[];
  durationSec: number | null;
  aspectRatios: string[];
  languages: string[];
  wordsPerItem: number | null;
  hours: number | null;
  deadlineDaysFromText: number | null;
  supplied: string[];
}

function toNumber(tok: string): number | null {
  const clean = tok.replace(/,/g, "").toLowerCase();
  if (/^\d+$/.test(clean)) return Number(clean);
  return WORD_NUMBERS[clean] ?? null;
}

export function parseBrief(title: string, description: string): ParsedBrief {
  const body = `${title}.\n${description}`;
  const sentences = body
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((s) => s.replace(/^[-*•]\s*/, "").trim())
    .filter((s) => s.length > 0)
    .map((text) => ({ text, supplied: SUPPLY_START.test(text) || /\b(supplied|provided)\.?$/i.test(text) }));

  const counts: ParsedBrief["counts"] = [];
  const nounAlt = Object.keys(NOUNS).join("|");
  const re = new RegExp(`\\b(\\d{1,3}(?:,\\d{3})?|${Object.keys(WORD_NUMBERS).join("|")})\\s+((?:[A-Za-z0-9:/+&'().×-]+\\s+){0,3}?)(${nounAlt})\\b`, "gi");
  for (const s of sentences) {
    for (const m of s.text.matchAll(re)) {
      const n = toNumber(m[1]!);
      if (n === null || n <= 0 || n > 5000) continue;
      const noun = m[3]!.toLowerCase();
      let kind = NOUNS[noun] ?? noun;
      const mid = (m[2] ?? "").toLowerCase();
      const after = s.text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40).toLowerCase();
      if (kind === "ad") kind = /static/.test(mid) ? "static" : /video/.test(mid) || /\d+\s*(?:–|-)?\s*\d*\s*s\b|second/.test(after) ? "video" : "static";
      if (kind === "static" && /video/.test(mid)) kind = "video";
      if (kind === "video" && /concepts?$/.test(noun) && !/video/.test(mid)) continue;
      counts.push({ kind, n, context: m[0], supplied: s.supplied });
    }
  }

  const deliverableText = sentences.filter((s) => !s.supplied).map((s) => s.text).join(" \n");
  let durationSec: number | null = null;
  const range = /(\d{1,3})\s*(?:–|-|to)\s*(\d{1,3})\s*(?:s|sec|secs|seconds)\b/i.exec(deliverableText);
  const single = /(\d{1,3})\s*(?:s|sec|secs|seconds)\b(?!\w)/i.exec(deliverableText) ?? /(\d{1,3})-second/i.exec(deliverableText);
  if (range) durationSec = Math.round((Number(range[1]) + Number(range[2])) / 2);
  else if (single) durationSec = Number(single[1]);
  if (durationSec !== null && (durationSec < 3 || durationSec > 180)) durationSec = null;

  const aspectRatios = [...new Set([...deliverableText.matchAll(/\b(9:16|1:1|4:5|16:9|3:2)\b/g)].map((m) => m[1]!))];
  if (/square/i.test(deliverableText) && !aspectRatios.includes("1:1")) aspectRatios.push("1:1");
  if (/vertical/i.test(deliverableText) && !aspectRatios.includes("9:16")) aspectRatios.push("9:16");

  const languages = LANGUAGES.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(body) || (l === "Portuguese" && /\bPT-BR\b/i.test(body)));
  const words = /(\d{1,2}(?:,\d{3})|\d{3,4})\s*(?:–|-)?\s*(?:\d{1,2}(?:,\d{3})|\d{3,4})?\s*-?\s*words?\b/i.exec(body);
  const hours = /~?\s*(\d{1,3})\s*hours?\b/i.exec(body);
  const dl = /(?:within|in|over|deliver in|launch in)\s+(\d{1,2})\s+days/i.exec(body) ?? /(\d{1,2})-day\b/i.exec(body);

  const supplied: string[] = [];
  for (const s of sentences.filter((x) => x.supplied)) {
    const cleaned = s.text
      .replace(/^(we('| wi)?ll (supply|provide|share|ship)|we (supply|provide|have|also have))\s*:?\s*/i, "")
      .replace(/\.$/, "");
    for (const part of cleaned.split(/,\s*|\s+and\s+|\s+plus\s+/)) {
      const p = part.trim();
      if (p.length >= 4 && p.length <= 90 && supplied.length < 8) supplied.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }

  return {
    sentences,
    counts,
    durationSec,
    aspectRatios,
    languages,
    wordsPerItem: words ? Number(words[1]!.replace(/,/g, "")) : null,
    hours: hours ? Number(hours[1]) : null,
    deadlineDaysFromText: dl ? Number(dl[1]) : null,
    supplied,
  };
}

function maxCount(p: ParsedBrief, kinds: string[], supplied = false): number {
  return p.counts.filter((c) => kinds.includes(c.kind) && c.supplied === supplied).reduce((m, c) => Math.max(m, c.n), 0);
}

export function detectFamily(input: Pick<AnalysisInput, "title" | "description" | "skills" | "marketKey">): { family: string; hits: number } {
  const title = ` ${input.title.toLowerCase()} `;
  const text = ` ${`${input.description} ${input.skills.join(" ")}`.toLowerCase()} `;
  let best = { family: input.marketKey ?? "research-content", hits: 0 };
  for (const [family, kws] of Object.entries(FAMILY_KEYWORDS)) {
    let hits = 0;
    for (const kw of kws) {
      const needle = new RegExp(`[^a-z0-9]${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9]`);
      if (needle.test(title)) hits += 3;
      if (needle.test(text)) hits += 1;
    }
    if (family === input.marketKey) hits += 1;
    if (hits > best.hits) best = { family, hits };
  }
  return best;
}

const TOOL_WORDS = ["n8n", "Zapier", "Make.com", "HubSpot", "Shopify", "Slack", "Airtable", "Typeform", "Xero", "Gmail", "Zendesk", "Notion", "Google Drive", "Stripe", "Supabase", "Next.js", "React", "Tailwind", "Webflow", "WordPress", "Figma", "Canva", "Photoshop", "Premiere", "CapCut", "Postgres", "OpenAI", "Sanity", "Mailchimp", "Google Sheets", "Miro"];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function analyseOpportunityHeuristically(
  input: AnalysisInput,
  opts: { markets?: MarketDescriptor[]; preferredMinBudgetUsd: number; now: Date },
): OpportunityAnalysis {
  const text = `${input.title}\n${input.description}`;
  const lower = text.toLowerCase();
  const p = parseBrief(input.title, input.description);
  const enabledMarkets = opts.markets?.filter((m) => m.enabled).map((m) => m.key);
  const detected = detectFamily(input);
  let family = detected.family;
  const hits = detected.hits;
  if (enabledMarkets && enabledMarkets.length && !enabledMarkets.includes(family) && input.marketKey && enabledMarkets.includes(input.marketKey)) {
    family = input.marketKey;
  }

  const fromDate = input.deadlineAt !== null ? Math.max(0, Math.ceil((input.deadlineAt.getTime() - opts.now.getTime()) / 86_400_000)) : null;
  // The brief's own wording ("deliver in 9 days") wins when it is tighter than the listing deadline.
  const deadlineDays = fromDate !== null && p.deadlineDaysFromText !== null ? Math.min(fromDate, p.deadlineDaysFromText) : (fromDate ?? p.deadlineDaysFromText);
  const triage = triageBudget(
    { budgetType: input.budgetType, budgetMinUsd: input.budgetMinUsd, budgetMaxUsd: input.budgetMaxUsd },
    opts.preferredMinBudgetUsd,
  );
  const lowBudget = triage === "low_budget";
  const small = lowBudget || /\b(quick (edit|fix|job)|small budget|short job|fix\b)/i.test(lower);

  const videos = maxCount(p, ["video", "clip"]);
  const statics = maxCount(p, ["static"]);
  const photos = maxCount(p, ["photo"]);
  const hooksN = maxCount(p, ["hook", "variant"]);
  const pages = maxCount(p, ["page"]);
  const articles = maxCount(p, ["article", "post", "issue"]);
  const brands = maxCount(p, ["brand", "tool"]);
  const slides = maxCount(p, ["slide"]);
  const suppliedVideos = maxCount(p, ["video", "clip", "lesson"], true);
  const suppliedItems = Math.max(suppliedVideos, maxCount(p, ["article", "transcript", "ticket", "episode", "interview"], true));
  const primaryAspect = p.aspectRatios[0] ?? (family === "paid-social-ugc" ? "9:16" : "1:1");
  const secondaryAspect = p.aspectRatios.find((a) => a !== primaryAspect) ?? (family === "paid-social-ugc" ? "1:1" : primaryAspect);
  const duration = p.durationSec ?? 15;
  const hourly = input.budgetType === "hourly";

  const production: OpportunityAnalysis["productionEstimates"] = [];
  const inference: OpportunityAnalysis["inferenceEstimates"] = [
    { task: "analysis & proposal", family: "gx", kTokensIn: 10, kTokensOut: 3, calls: 3 },
    { task: "independent QA review", family: "gx", kTokensIn: 8, kTokensOut: 2, calls: 6 },
  ];
  const deliverables: OpportunityAnalysis["deliverables"] = [];
  const tmpl: TemplateContext = {};
  let humanHours = 2;
  let complexity = 0.4;
  let fit = 0.78;
  let billableDefault = 20;

  const editingJob = /\b(raw|existing|recorded)\b[^.]*\b(footage|clips|recordings|video)\b/i.test(lower) || /footage (and music )?(provided|supplied)/i.test(lower);

  switch (family) {
    case "paid-social-ugc": {
      const V = videos || (statics ? 0 : small ? 2 : 6);
      const S = statics;
      billableDefault = 20;
      if (V > 0) {
        const label = editingJob ? `${V}× edited ${primaryAspect} ad (${duration}s)` : `${V}× ${primaryAspect} UGC-style video (${duration}s)`;
        production.push(
          editingJob
            ? { label, capability: "video.generate", units: V, attemptsPerUnit: 1.2 }
            : { label, capability: "video.generate", units: V, attemptsPerUnit: 2.5 },
        );
        deliverables.push({ item: editingJob ? `Edited ad (${duration}s, ${primaryAspect})` : `UGC-style video (${duration}s, ${primaryAspect})`, quantity: V, format: "MP4, captions burned in" });
        tmpl.primary = { capability: "video.generate", label, aspectRatio: primaryAspect };
      }
      if (S > 0) {
        const label = `${S}× static ad creative (${S && p.aspectRatios.length > 1 ? p.aspectRatios.slice(0, 2).join(" + ") : secondaryAspect})`;
        production.push({ label, capability: "image.generate", units: S, attemptsPerUnit: 1.8 });
        deliverables.push({ item: `Static ad creative (${p.aspectRatios.slice(0, 2).join(", ") || secondaryAspect})`, quantity: S, format: "PNG + editable source" });
        const staticAspect = p.aspectRatios.includes("4:5") ? "4:5" : p.aspectRatios.includes("1:1") ? "1:1" : secondaryAspect;
        if (tmpl.primary) tmpl.secondary = { capability: "image.generate", label, aspectRatio: staticAspect };
        else tmpl.primary = { capability: "image.generate", label, aspectRatio: staticAspect };
      }
      if (hooksN > 0 || /hook/i.test(lower)) deliverables.push({ item: "Hook variants + script doc", quantity: Math.max(hooksN, 3), format: "Google Doc / Markdown" });
      inference.push({ task: "hooks, scripts & prompts", family: "factory", kTokensIn: 6, kTokensOut: 3, calls: Math.ceil((V + S) / 2) + 2 });
      humanHours = editingJob ? Math.max(4, 0.45 * (p.hours ?? V * 2)) : 2.5 + 0.35 * V + 0.08 * S;
      humanHours = Math.min(14, humanHours);
      complexity = 0.4 + (V + S > 20 ? 0.1 : 0) + (/iteration|weekly|drops/i.test(lower) ? 0.1 : 0);
      fit = editingJob ? 0.68 : 0.8;
      break;
    }
    case "image-design": {
      const I = Math.max(statics, photos) || (small ? 3 : 10);
      billableDefault = 15;
      if (slides > 0 || /\bdeck\b|slides/i.test(lower)) {
        const label = `${slides || 15}× redesigned slide`;
        production.push({ label, capability: "media.finishing", units: slides || 15, attemptsPerUnit: 1.2 });
        deliverables.push({ item: "Redesigned slide", quantity: slides || 15, format: "Google Slides" });
        tmpl.primary = { capability: "image.generate", label: "Slide visual system", aspectRatio: "16:9" };
        humanHours = Math.max(3, 0.45 * (p.hours ?? 15));
      } else if (/clean ?up|retouch|white-background|background removal/i.test(lower)) {
        const edits = /for\s+(\d{1,3})\s+skus/i.exec(lower)?.[1] ? Number(/for\s+(\d{1,3})\s+skus/i.exec(lower)![1]) : Math.round(I * 0.6);
        const composites = Math.max(0, I - edits);
        const editLabel = `${edits}× product retouch (${primaryAspect})`;
        const compLabel = `${composites}× lifestyle composite (${primaryAspect})`;
        production.push({ label: editLabel, capability: "image.edit", units: edits, attemptsPerUnit: 1.4 });
        if (composites > 0) production.push({ label: compLabel, capability: "image.generate", units: composites, attemptsPerUnit: 2 });
        deliverables.push({ item: "White-background product image", quantity: edits, format: "2048×2048 PNG/JPG" });
        if (composites > 0) deliverables.push({ item: "Lifestyle composite", quantity: composites, format: "2048×2048 JPG" });
        tmpl.primary = { capability: "image.edit", label: editLabel, aspectRatio: primaryAspect };
        tmpl.secondary = composites > 0 ? { capability: "image.generate", label: compLabel, aspectRatio: primaryAspect } : tmpl.primary;
        humanHours = 1.5 + 0.12 * I;
      } else {
        const noun = /thumbnail/i.test(lower) ? "thumbnail" : /template/i.test(lower) ? "social template" : /illustrat/i.test(lower) ? "illustration" : /mockup/i.test(lower) ? "listing mockup" : /logo|banner/i.test(lower) ? "banner export" : "design visual";
        const aspect = /thumbnail/i.test(lower) ? "16:9" : primaryAspect;
        const label = `${I}× ${noun} (${aspect})`;
        production.push({ label, capability: "image.generate", units: I, attemptsPerUnit: 1.6 });
        deliverables.push({ item: noun.charAt(0).toUpperCase() + noun.slice(1), quantity: I, format: aspect === "16:9" ? "1920×1080 PNG" : "PNG + source" });
        tmpl.primary = { capability: "image.generate", label, aspectRatio: aspect };
        humanHours = 1.5 + 0.12 * I;
      }
      inference.push({ task: "art direction & prompts", family: "factory", kTokensIn: 5, kTokensOut: 2, calls: Math.ceil(I / 3) + 2 });
      humanHours = Math.min(10, Math.max(small ? 1 : 2, humanHours));
      complexity = 0.3 + (I > 25 ? 0.1 : 0);
      fit = small ? 0.6 : 0.8;
      break;
    }
    case "localization-repurposing": {
      const langs = p.languages.length ? p.languages : ["Spanish"];
      const L = Math.max(langs.length, maxCount(p, ["language"]));
      const N = Math.max(suppliedItems, maxCount(p, ["article", "video", "lesson", "episode"]), small ? 1 : 0) || 5;
      billableDefault = 20;
      const clips = maxCount(p, ["clip"]);
      if (/repurpose|short clips/i.test(lower) && clips > 0) {
        const label = `${clips}× short clip (9:16, 45s)`;
        production.push({ label, capability: "video.generate", units: clips, attemptsPerUnit: 1.2 });
        deliverables.push({ item: "Short vertical clip with captions", quantity: clips, format: "MP4 9:16" });
        tmpl.primary = { capability: "video.generate", label, aspectRatio: "9:16" };
        humanHours = 2 + 0.12 * clips;
      } else {
        const label = `${N * L}× translated file (${N} source × ${L} language${L > 1 ? "s" : ""})`;
        production.push({ label, capability: "text.translate", units: N * L, attemptsPerUnit: 1.2 });
        deliverables.push({ item: /subtitle|srt/i.test(lower) ? "SRT subtitle file" : "Translated file", quantity: N * L, format: /subtitle|srt/i.test(lower) ? "SRT (UTF-8)" : "Markdown / source format" });
        if (/burned-in|burn/i.test(lower)) deliverables.push({ item: "Burned-in subtitle video", quantity: N * L, format: "MP4" });
        humanHours = 2 + 0.08 * N * L;
      }
      if (/dub|voice/i.test(lower)) {
        production.push({ label: `${N}× dubbed video`, capability: "audio.dub", units: N, attemptsPerUnit: 1.5 });
        deliverables.push({ item: "Dubbed video", quantity: N, format: "MP4 + SRT" });
        humanHours += 2;
      }
      const words = p.wordsPerItem ?? (/(subtitle|srt|video)/i.test(lower) ? 220 : 600);
      inference.push({ task: "translation & adaptation", family: "factory", kTokensIn: round1(Math.max(1.5, (words * 1.5) / 1000)), kTokensOut: round1(Math.max(1.5, (words * 1.6) / 1000)), calls: N * L });
      tmpl.languages = langs;
      humanHours = Math.min(12, Math.max(small ? 0.75 : 2, humanHours));
      complexity = 0.35 + (/dub|voice/i.test(lower) ? 0.1 : 0) + (L >= 6 ? 0.1 : 0);
      fit = small ? 0.62 : 0.74;
      break;
    }
    case "ai-automation": {
      billableDefault = 25;
      complexity = 0.5 + (/\b(rag|permission|agent|llm|ocr|eval)/i.test(lower) ? 0.15 : 0) + (/legacy|migration|audit/i.test(lower) ? 0.05 : 0);
      if (small) complexity = 0.2;
      production.push({ label: small ? "Automation fix" : "Automation build (1 integration)", capability: "code.automation", units: 1, attemptsPerUnit: 1.3 });
      deliverables.push({ item: small ? "Fixed automation + explanation" : "Working automation with source, tests and README", quantity: 1, format: "Repository / exported workflow" });
      if (!small) deliverables.push({ item: "Runbook & handover", quantity: 1, format: "Markdown" });
      inference.push({ task: "code generation & review", family: "factory", kTokensIn: 60, kTokensOut: 14, calls: small ? 3 : Math.round(12 + complexity * 24) });
      humanHours = small ? 1 : 3 + 7 * complexity;
      fit = small ? 0.62 : 0.86;
      break;
    }
    case "web-app-builds": {
      billableDefault = 40;
      const P = pages || (small ? 1 : 5);
      complexity = 0.45 + (/\b(mvp|portal|billing|stripe|auth|login|supabase)/i.test(lower) ? 0.2 : 0) + (P > 20 ? 0.1 : 0);
      if (small) complexity = 0.2;
      production.push({ label: small ? "Site fix" : `Web build (${P} page${P > 1 ? "s" : ""})`, capability: "code.build", units: 1, attemptsPerUnit: 1.3 });
      deliverables.push({ item: small ? "Bug fix with explanation" : `${P}-page build with source and deployment guide`, quantity: 1, format: "Repository" });
      inference.push({ task: "code generation & review", family: "factory", kTokensIn: 70, kTokensOut: 18, calls: small ? 3 : Math.round(14 + Math.min(P, 30) * 1.5 + complexity * 20) });
      humanHours = small ? 1 : Math.min(18, 4 + 0.35 * Math.min(P, 30) + 8 * complexity);
      fit = small ? 0.58 : /wordpress|liquid/i.test(lower) ? 0.7 : 0.8;
      break;
    }
    default: {
      family = "research-content";
      billableDefault = 16;
      const A = articles;
      const B = brands;
      production.push({ label: A > 0 ? `${A}× long-form piece` : "Research report", capability: A > 0 ? "text.copy" : "text.research", units: Math.max(1, A), attemptsPerUnit: 1.3 });
      if (A > 0) deliverables.push({ item: /newsletter|issue/i.test(lower) ? "Newsletter issue" : /knowledge/i.test(lower) ? "Knowledge-base article" : "Long-form article", quantity: A, format: "Google Doc / Markdown" });
      if (B > 0) deliverables.push({ item: /pricing/i.test(lower) ? "Pricing profile" : "Competitor profile", quantity: B, format: "Comparison table (Sheets)" });
      if (B > 0 || /research|synthes|teardown|landscape/i.test(lower)) deliverables.push({ item: "Research report with executive summary", quantity: 1, format: "PDF / Markdown" });
      if (deliverables.length === 0) deliverables.push({ item: small ? "Edited document" : "Written deliverable", quantity: 1, format: "Markdown" });
      inference.push({ task: "web research", family: "grok", kTokensIn: 25, kTokensOut: 5, calls: small ? 0 : 8 + Math.min(B, 20) });
      inference.push({ task: "drafting", family: "factory", kTokensIn: 20, kTokensOut: 8, calls: Math.max(2, A) });
      humanHours = small ? 0.75 : Math.min(14, 2.5 + 0.1 * B + 0.4 * A);
      complexity = small ? 0.15 : 0.35 + (A > 10 ? 0.1 : 0);
      fit = small ? 0.6 : 0.82;
    }
  }

  const billableHours = hourly ? (p.hours ?? billableDefault) : null;
  if (hourly && billableHours) humanHours = Math.max(humanHours, 0.3 * billableHours);
  humanHours = round1(Math.max(small ? 0.75 : 1, humanHours));
  if (hits >= 6) fit += 0.04;
  if (lowBudget) fit -= 0.15;

  // --- risks ---------------------------------------------------------------
  const risks: OpportunityAnalysis["risks"] = [];
  if (deadlineDays !== null && deadlineDays <= 3) {
    risks.push({ kind: "deadline", severity: deadlineDays <= 1 ? "high" : "medium", note: `Only ${deadlineDays} day${deadlineDays === 1 ? "" : "s"} to deliver` });
  }
  if (lowBudget) {
    risks.push({ kind: "payment", severity: "medium", note: `Budget ${money(input.budgetMaxUsd ?? input.budgetMinUsd)} is below the preferred ${money(opts.preferredMinBudgetUsd)} minimum` });
  }
  if (input.clientRating === null && !input.clientSpendUsd) risks.push({ kind: "client", severity: "low", note: "New client — no rating or hiring history yet" });
  else if (input.clientRating !== null && input.clientRating < 4.3) risks.push({ kind: "client", severity: "medium", note: `Client rating ${input.clientRating.toFixed(1)}★` });
  if (/iteration|weekly|drops|ongoing/i.test(lower)) risks.push({ kind: "revision", severity: "medium", note: "Iterative scope — agree revision rounds up front" });
  if (/unlimited revisions/i.test(lower)) risks.push({ kind: "revision", severity: "high", note: "Client expects unlimited revisions" });
  if (complexity >= 0.65) risks.push({ kind: "technical", severity: "medium", note: family === "ai-automation" ? "LLM/permission-aware logic needs an evaluation set before sign-off" : "Auth, billing webhooks and data model need careful testing" });
  if ((input.proposalsCount ?? 0) > 30) risks.push({ kind: "client", severity: "low", note: `Crowded listing — ${input.proposalsCount} proposals already` });
  if (/ai voice/i.test(lower)) risks.push({ kind: "compliance", severity: "low", note: "Disclose AI voice usage in the delivery notes" });

  // --- inputs --------------------------------------------------------------
  const missingInputs: string[] = [];
  const requiredAssets: string[] = [];
  if (family === "paid-social-ugc" || family === "image-design") {
    requiredAssets.push("Brand guidelines", "Logo (SVG)", "Product imagery or footage");
    if (!/brand (guidelines|kit|assets|palette)|logo/i.test(lower)) missingInputs.push("Brand guidelines / logo files");
    if (!/product (shots|photos|photography|images)|samples|footage|screen recordings|photos|artwork|raw photos|face cut-outs|recordings/i.test(lower)) missingInputs.push("Product imagery or footage");
  } else if (family === "ai-automation") {
    requiredAssets.push("Sandbox / staging access", "API credentials held by the client");
    if (!/access|sandbox|api keys?|credentials|staging/i.test(lower)) missingInputs.push("API / sandbox access for the systems involved");
  } else if (family === "web-app-builds") {
    requiredAssets.push("Design files or wireframes", "Final copy", "Hosting / domain access");
    if (!/figma|designs?|wireframes/i.test(lower)) missingInputs.push("Design files or wireframes");
  } else if (family === "localization-repurposing") {
    requiredAssets.push("Source files or transcripts", "Glossary / style guide");
    if (!/transcripts?|scripts?|source|project files|recordings|footage|blurb|listing/i.test(lower)) missingInputs.push("Source transcripts or project files");
  } else {
    requiredAssets.push("Research questions / brief", "Existing data or notes");
  }
  if (missingInputs.length) risks.push({ kind: "input", severity: "low", note: `Missing: ${missingInputs.join("; ")}` });

  // --- scores --------------------------------------------------------------
  const deadlineRisk = deadlineDays === null ? 0.3 : deadlineDays <= 2 ? 0.8 : deadlineDays <= 4 ? 0.55 : deadlineDays <= 7 ? 0.35 : 0.2;
  let revisionRisk = 0.25 + (family === "paid-social-ugc" || family === "image-design" ? 0.15 : 0);
  if (/iteration|weekly|drops|ongoing/i.test(lower)) revisionRisk += 0.1;
  if (/unlimited revisions/i.test(lower)) revisionRisk += 0.3;
  let confidence = 0.82;
  if (triage === "unknown_budget") confidence -= 0.15;
  if (input.description.length < 200) confidence -= 0.12;
  if (hits < 2) confidence -= 0.15;
  if (deliverables.length === 0) confidence -= 0.1;

  // --- narrative -----------------------------------------------------------
  const skills = [...new Set([...input.skills, ...TOOL_WORDS.filter((t) => lower.includes(t.toLowerCase()))])].slice(0, 12);
  const deliverableSummary = deliverables
    .slice(0, 3)
    .map((d) => `${d.quantity}× ${d.item}`)
    .join(", ");
  const budgetText =
    input.budgetType === "hourly"
      ? `${money(input.budgetMinUsd)}–${money(input.budgetMaxUsd)}/h${billableHours ? ` (~${billableHours}h)` : ""}`
      : input.budgetMinUsd && input.budgetMaxUsd && input.budgetMinUsd !== input.budgetMaxUsd
        ? `${money(input.budgetMinUsd)}–${money(input.budgetMaxUsd)} fixed`
        : input.budgetMaxUsd || input.budgetMinUsd
          ? `${money(input.budgetMaxUsd ?? input.budgetMinUsd)} fixed`
          : "budget not stated";
  const summary = `${input.clientName ?? "The client"} needs ${deliverableSummary || input.title}. ${budgetText}; ${
    deadlineDays !== null ? `due in ${deadlineDays} day${deadlineDays === 1 ? "" : "s"}` : "no hard deadline"
  }.`;

  const buyerPriorities: string[] = [];
  if (/cpc|cpi|ctr|convert|performance|roas/i.test(lower)) buyerPriorities.push("Performance — creatives must beat the current CPC/CPI/CTR benchmark");
  if (/native|creator|ugc|thumb-stopping|scroll/i.test(lower)) buyerPriorities.push("Native, scroll-stopping creative that doesn't look templated");
  if (/retry|reliab|fail|dead-letter|error/i.test(lower)) buyerPriorities.push("Reliability — retries, alerting and no silent failures");
  if (/readme|runbook|document|handover|explanation/i.test(lower)) buyerPriorities.push("Clear documentation and handover");
  if (/lighthouse|core web vitals|fast|lcp|seo/i.test(lower)) buyerPriorities.push("Speed and SEO (Lighthouse / Core Web Vitals)");
  if (/glossary|terminology|native-level|brand terms/i.test(lower)) buyerPriorities.push("Terminology accuracy against the supplied glossary");
  if (/citation|grounded|evidence|sources/i.test(lower)) buyerPriorities.push("Grounded answers with citations");
  if (/executive summary|recommendations|insights|personas/i.test(lower)) buyerPriorities.push("Actionable recommendations, not just data");
  if (deadlineDays !== null && deadlineDays <= 7) buyerPriorities.push(`Turnaround within ${deadlineDays} days`);
  if (buyerPriorities.length === 0) buyerPriorities.push("Clear scope and on-time delivery");

  const rationale = [
    `${familyLabel(family)} brief (${hits} keyword signal${hits === 1 ? "" : "s"})`,
    deliverableSummary ? `Deliverables parsed: ${deliverableSummary}` : "Deliverables not quantified in the brief",
    p.supplied.length ? `Client supplies: ${p.supplied.slice(0, 3).join("; ")}` : "No client assets mentioned",
    deadlineDays !== null
      ? `${deadlineDays}-day window — ${deadlineDays >= 7 ? "comfortable" : deadlineDays >= 4 ? "tight but workable" : "very tight"} for this scope`
      : "No deadline stated",
    lowBudget ? "Budget below the preferred minimum — analysed cheaply; unlikely to clear the gates" : `Owner time estimated at ${humanHours}h; production priced from the catalog`,
  ];

  return {
    summary,
    clientRequest: input.description.replace(/\s+/g, " ").slice(0, 400),
    serviceFamily: family,
    deliverables,
    suppliedAssets: p.supplied,
    requiredAssets,
    missingInputs,
    skills,
    risks,
    deadlineDays,
    productionEstimates: production,
    inferenceEstimates: inference,
    humanHours,
    billableHours,
    proposedWorkflow: templateForFamily(family, tmpl),
    fitScore: round2(clamp(fit, 0.2, 0.97)),
    complexity: round2(clamp(complexity, 0.05, 0.95)),
    revisionRisk: round2(clamp(revisionRisk, 0.05, 0.95)),
    deadlineRisk: round2(clamp(deadlineRisk, 0.05, 0.95)),
    confidence: round2(clamp(confidence, 0.3, 0.92)),
    rationale,
    buyerPriorities: buyerPriorities.slice(0, 4),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Clamp model-produced quantities into sane bounds and fill gaps from the
 * deterministic baseline (defence in depth before economics runs).
 */
export function sanitiseAnalysis(model: OpportunityAnalysis, baseline: OpportunityAnalysis): OpportunityAnalysis {
  const families = Object.keys(FAMILY_KEYWORDS);
  const serviceFamily = families.includes(model.serviceFamily) ? model.serviceFamily : baseline.serviceFamily;
  const production = (model.productionEstimates.length ? model.productionEstimates : baseline.productionEstimates).map((e) => ({
    ...e,
    units: clamp(e.units, 0, 500),
    attemptsPerUnit: clamp(e.attemptsPerUnit, 1, 6),
  }));
  const inference = (model.inferenceEstimates.length ? model.inferenceEstimates : baseline.inferenceEstimates).map((e) => ({
    ...e,
    kTokensIn: clamp(e.kTokensIn, 0, 400),
    kTokensOut: clamp(e.kTokensOut, 0, 200),
    calls: clamp(e.calls, 0, 200),
  }));
  return {
    ...model,
    serviceFamily,
    productionEstimates: production,
    inferenceEstimates: inference,
    humanHours: clamp(model.humanHours, 0.5, 200),
    billableHours: model.billableHours === null ? baseline.billableHours : clamp(model.billableHours, 0, 400),
    deliverables: model.deliverables.length ? model.deliverables : baseline.deliverables,
    proposedWorkflow: model.proposedWorkflow.length ? model.proposedWorkflow : baseline.proposedWorkflow,
    rationale: model.rationale.length ? model.rationale.slice(0, 8) : baseline.rationale,
  };
}

