import type { OpportunityAnalysis, ProposalDraft, TenantSettings } from "@gigpilot/contracts";
import { familyLabel, money } from "../lib/util";

/**
 * Deterministic proposal pricing and drafting. Price is ALWAYS computed
 * here (never by a model): fixed budgets price within the client's range at
 * min(max(midpoint, break-even × 1.6), budget max); hourly work prices at the
 * tenant rate clamped to the client's range × estimated hours.
 */

export interface PricingInput {
  budgetType: "fixed" | "hourly" | "unknown";
  budgetMinUsd: number | null;
  budgetMaxUsd: number | null;
  breakEvenPriceUsd: number | null;
  billableHours: number | null;
}

export interface PriceDecision {
  priceUsd: number;
  basis: string;
  rateUsd?: number;
  hours?: number;
}

function roundPrice(n: number): number {
  if (n >= 1000) return Math.round(n / 50) * 50;
  if (n >= 200) return Math.round(n / 10) * 10;
  return Math.max(5, Math.round(n / 5) * 5);
}

export function priceProposal(input: PricingInput, settings: TenantSettings): PriceDecision {
  const min = input.budgetMinUsd && input.budgetMinUsd > 0 ? input.budgetMinUsd : null;
  const max = input.budgetMaxUsd && input.budgetMaxUsd > 0 ? input.budgetMaxUsd : null;
  const be = input.breakEvenPriceUsd && input.breakEvenPriceUsd > 0 ? input.breakEvenPriceUsd : 0;

  if (input.budgetType === "hourly") {
    let rate = settings.economics.defaultHourlyRateUsd;
    if (max !== null && rate > max) rate = max;
    if (min !== null && rate < min) rate = min;
    const hours = input.billableHours && input.billableHours > 0 ? input.billableHours : 10;
    return { priceUsd: Math.round(rate * hours), basis: `${money(rate)}/h × ${hours}h estimated`, rateUsd: rate, hours };
  }

  if (min !== null || max !== null) {
    const lo = min ?? max!;
    const hi = max ?? min!;
    const mid = (lo + hi) / 2;
    let price = Math.min(Math.max(mid, be * 1.6), hi);
    price = Math.min(roundPrice(price), hi);
    const basis =
      price >= hi && be * 1.6 > mid
        ? "top of the client's range (break-even × 1.6 exceeds the midpoint)"
        : lo === hi
          ? "client's stated fixed budget"
          : "midpoint of the client's range";
    return { priceUsd: price, basis };
  }

  const fallback = be > 0 ? roundPrice(be * 2) : 0;
  return { priceUsd: fallback, basis: fallback > 0 ? "2× break-even (no budget stated)" : "no budget stated" };
}

export function timelineDaysFor(analysis: OpportunityAnalysis): number {
  const defaults: Record<string, number> = {
    "paid-social-ugc": 7,
    "image-design": 5,
    "localization-repurposing": 8,
    "ai-automation": 10,
    "web-app-builds": 18,
    "research-content": 7,
  };
  const base = defaults[analysis.serviceFamily] ?? 7;
  if (analysis.deadlineDays !== null && analysis.deadlineDays > 0) return Math.max(1, Math.min(analysis.deadlineDays, Math.max(base, Math.ceil(analysis.deadlineDays * 0.85))));
  return base;
}

const APPROACH: Record<string, (a: OpportunityAnalysis) => string[]> = {
  "paid-social-ugc": (a) => [
    "Day 1–2: angle research on your category and competitors' live ads, then a hook bank mapped to buyer objections.",
    `Day 2–3: concepts and scripts for sign-off — every ${a.deliverables[0]?.item.toLowerCase() ?? "asset"} opens with a pattern interrupt in the first 1.5 seconds.`,
    "Two delivery drops so you can put the first batch into Ads Manager while the second is in production.",
    "Every file checked for aspect ratio, safe zones and caption legibility before it reaches you.",
  ],
  "image-design": () => [
    "A quick style frame first so we lock direction before producing the full set.",
    "Consistent lighting, shadows and colour across the whole batch (colour-checked against your references).",
    "Exported at the exact sizes you listed plus editable sources.",
    "Each file checked for dimensions, safe margins and text fit before delivery.",
  ],
  "localization-repurposing": (a) => [
    `Glossary first: your do-not-translate terms locked before any ${a.deliverables[0]?.item.toLowerCase() ?? "file"} is produced.`,
    "Native-quality adaptation (not literal translation), with reading speed kept under 17 characters per second.",
    "Timing checked cue by cue — no overlaps, no flashes shorter than a second.",
    "Delivered per language with consistent naming so your editors can drop them straight in.",
  ],
  "ai-automation": () => [
    "Day 1: confirm triggers, field mapping and failure modes with you (a one-page design you sign off).",
    "Build with idempotent upserts, retry with backoff on rate limits and a dead-letter log — nothing fails silently.",
    "Automated tests for mapping, dedupe and retry paths, plus a test report you can re-run.",
    "Runbook and a recorded walkthrough so your team owns it after handover.",
  ],
  "web-app-builds": () => [
    "Route map and component plan agreed up front, built straight from your designs.",
    "Performance budget from day one (Lighthouse 90+, image optimisation, no layout shift).",
    "Tests on the critical paths and a staging preview link for every milestone.",
    "Deployment guide and handover checklist so you're not locked in.",
  ],
  "research-content": () => [
    "A short research plan confirming the questions and the decision the work supports.",
    "Evidence-backed findings with sources for every claim — no filler.",
    "An executive summary you can forward as-is, with specific, prioritised recommendations.",
    "One structured revision round included.",
  ],
};

export interface DraftInput {
  title: string;
  clientName: string | null;
  analysis: OpportunityAnalysis;
  priceUsd: number;
  priceBasis: string;
  timelineDays: number;
  budgetType: "fixed" | "hourly" | "unknown";
  rateUsd?: number;
  hours?: number;
  expectedMargin: number | null;
}

/** Specific (never generic) proposal draft built from the analysed brief. */
export function draftProposal(input: DraftInput): ProposalDraft {
  const a = input.analysis;
  const greeting = input.clientName ? `Hi ${input.clientName} team,` : "Hi there,";
  const deliverables = a.deliverables.slice(0, 4);
  const deliverableLine = deliverables.length
    ? deliverables.map((d) => `${d.quantity > 1 ? `${d.quantity}× ` : ""}${d.item}${d.format ? ` (${d.format})` : ""}`).join(", ")
    : input.title;
  const priority = a.buyerPriorities[0] ?? "clear scope and on-time delivery";
  const supplied = a.suppliedAssets.slice(0, 2);
  const approach = (APPROACH[a.serviceFamily] ?? APPROACH["research-content"]!)(a);
  const priceLine =
    input.budgetType === "hourly" && input.rateUsd && input.hours
      ? `${money(input.rateUsd)}/hour, estimated ${input.hours} hours (${money(input.priceUsd)}), with a weekly hours report`
      : `${money(input.priceUsd)} fixed`;
  const question =
    a.missingInputs[0] !== undefined
      ? `One question before I start: can you share ${a.missingInputs[0].toLowerCase()}?`
      : a.serviceFamily === "ai-automation"
        ? "One question: which failure should page someone immediately versus land in the daily digest?"
        : a.serviceFamily === "paid-social-ugc"
          ? "One question: which of your current ads is the control we're trying to beat?"
          : "One question: who signs off each milestone on your side?";

  const coverLetter = [
    greeting,
    "",
    a.buyerPriorities.length && !/^clear scope/i.test(priority)
      ? `You need ${deliverableLine} for “${input.title}”, and the brief makes it clear that ${priority.charAt(0).toLowerCase()}${priority.slice(1)} matters most. Here's how I'd run it:`
      : `You need ${deliverableLine} for “${input.title}”. Here's how I'd run it:`,
    "",
    ...approach.map((l, i) => `${i + 1}. ${l}`),
    "",
    supplied.length ? `I'll work from what you already have (${supplied.join("; ").toLowerCase()}), so there's no duplicated effort.` : "",
    `Price: ${priceLine}, delivered in ${input.timelineDays} day${input.timelineDays === 1 ? "" : "s"} with one revision round included.`,
    "",
    question,
    "",
    "Thanks — happy to start as soon as you confirm.",
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");

  const scope = [
    ...deliverables.map((d) => ({ item: `${d.quantity > 1 ? `${d.quantity}× ` : ""}${d.item}`, detail: d.format })),
    ...(a.serviceFamily === "ai-automation" || a.serviceFamily === "web-app-builds"
      ? [{ item: "Tests + test report", detail: "Re-runnable" }, { item: "Runbook & handover", detail: "Written + walkthrough" }]
      : [{ item: "One revision round", detail: "Consolidated feedback" }]),
  ];

  const assumptions = [
    `Priced from the brief as written (${input.priceBasis}).`,
    "One consolidated revision round; further changes quoted as a change order.",
    ...(a.suppliedAssets.length ? [`Client supplies: ${a.suppliedAssets.slice(0, 3).join("; ")}.`] : []),
    ...(a.serviceFamily === "ai-automation" || a.serviceFamily === "web-app-builds" ? ["Credentials stay in your accounts; access via scoped keys or sandbox."] : []),
  ];
  const questions = [...a.missingInputs.map((m) => `Can you share ${m.toLowerCase()}?`), question.replace(/^One question( before I start)?: /, "")].slice(0, 4);

  return {
    headline: `${familyLabel(a.serviceFamily)}: ${input.title}`.slice(0, 200),
    coverLetter,
    scope,
    priceUsd: input.priceUsd,
    timelineDays: input.timelineDays,
    assumptions,
    questions: [...new Set(questions)],
  };
}
