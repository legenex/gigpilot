import type { OpportunityAnalysis } from "@gigpilot/contracts";
import { familyLabel, fnv, truncate } from "../lib/util";

/**
 * Deterministic document generators used as the mock-mode answer for text
 * production steps. Outputs are specific to the job (built from the brief
 * and analysis) and clearly labelled where content is heuristic.
 */

export interface ContentContext {
  title: string;
  brief: string;
  clientName: string | null;
  family: string;
  analysis: OpportunityAnalysis | null;
  acceptance: string[];
  stepKey: string;
  stepName: string;
  stepKind: string;
  /** Markdown of upstream steps keyed by step key. */
  prior: Record<string, string>;
  defect: string | null;
  repairHint: string | null;
  revisionNote: string | null;
  languages?: string[];
}

export interface Concept {
  angle: string;
  headline: string;
  subhead: string;
  cta: string;
  scene: string;
  script: string[];
}

/** Sections QA requires per step kind (deterministic document checks). */
export function requiredSections(kind: string, family: string): string[] {
  switch (kind) {
    case "brief":
      return ["## Objective", "## Deliverables"];
    case "research":
      return ["## Key findings", "## Sources"];
    case "concepts":
      return family === "paid-social-ugc" || family === "image-design" ? ["## Concept 1"] : [];
    case "copy":
      return ["## Executive summary", "## Recommendations"];
    case "finalize":
      return ["## Contents"];
    default:
      return [];
  }
}

export function productPhrase(title: string): string {
  const m =
    /\bfor (?:our |a |an |the )?(.+?)(?:\s+launch|\s+campaign|\s+listing|\s+install campaign|\s+landing page|\s*\(|\s+—|\s+-\s|$)/i.exec(title) ??
    /^(.+?)(?:\s*\(|\s+—|$)/.exec(title);
  return truncate((m?.[1] ?? title).replace(/^(our|a|an|the)\s+/i, "").trim(), 48);
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

function deliverablesTable(a: OpportunityAnalysis | null): string {
  if (!a || a.deliverables.length === 0) return "| Deliverable | Qty | Format |\n|---|---|---|\n| As per brief | 1 | — |";
  return ["| Deliverable | Qty | Format |", "|---|---|---|", ...a.deliverables.map((d) => `| ${d.item} | ${d.quantity} | ${d.format ?? "—"} |`)].join("\n");
}

function bullets(items: string[], fallback: string): string {
  return (items.length ? items : [fallback]).map((i) => `- ${i}`).join("\n");
}

function heuristicNote(): string {
  return "> Mock mode: this section is generated heuristically from the brief. When GX / Factory / Grok are configured, live model output replaces it.";
}

export function buildConcepts(ctx: Pick<ContentContext, "title" | "clientName" | "analysis">): Concept[] {
  const product = productPhrase(ctx.title);
  const P = titleCase(product);
  const brand = ctx.clientName ?? "Your brand";
  const seed = fnv(ctx.title);
  const ctas = ["Shop now", "Try it today", "Get yours", "See how it works"];
  const settings = ["a bright kitchen counter", "a busy morning commute", "a minimal desk setup", "a weekend outdoor moment"];
  const concepts: Concept[] = [
    {
      angle: "Problem → solution",
      headline: `The easier way to ${/app/i.test(product) ? "stay on track" : "get it done"}: ${P}`,
      subhead: `${brand} made ${product} for people who want results without the hassle.`,
      cta: ctas[seed % 4]!,
      scene: `Creator unboxing ${product} on ${settings[seed % 4]}`,
      script: [`Okay, I didn't expect ${product} to fix this…`, "Here's the problem I kept running into.", `Then I tried ${P}.`, "Watch this.", "Honestly? Not going back.", `${ctas[seed % 4]} — link below.`],
    },
    {
      angle: "Social proof",
      headline: `Why people are switching to ${P}`,
      subhead: "Real reviews, real routines — see what changed for them.",
      cta: ctas[(seed + 1) % 4]!,
      scene: `Split screen of three customers using ${product}`,
      script: ["Everyone's asking about this.", "I read the reviews so you don't have to.", "Here's what actually stood out.", "The detail nobody mentions.", "Would I buy it again? Yes.", `${ctas[(seed + 1) % 4]}.`],
    },
    {
      angle: "Offer",
      headline: `${P} — try it risk-free`,
      subhead: "Limited launch offer. Free shipping on your first order.",
      cta: ctas[(seed + 2) % 4]!,
      scene: `${P} hero shot with the offer badge`,
      script: ["Stop scrolling — this is the deal.", `${P}, launch pricing.`, "Here's what you get.", "And here's how it works.", "Offer ends soon.", `${ctas[(seed + 2) % 4]}.`],
    },
    {
      angle: "Demo in 15 seconds",
      headline: `See ${P} in 15 seconds`,
      subhead: "No setup, no learning curve — just press and go.",
      cta: ctas[(seed + 3) % 4]!,
      scene: `Top-down demo of ${product} in use`,
      script: ["Fifteen seconds. That's it.", "Step one.", "Step two.", "Done.", "That's the whole thing.", `${ctas[(seed + 3) % 4]}.`],
    },
  ];
  return concepts;
}

function briefDoc(ctx: ContentContext): string {
  const a = ctx.analysis;
  const lines = [
    `# ${ctx.stepName} — ${ctx.title}`,
    "",
    "## Objective",
    a?.summary ?? truncate(ctx.brief, 400),
    "",
    "## Deliverables",
    deliverablesTable(a),
    "",
  ];
  if (ctx.family === "ai-automation" || ctx.family === "web-app-builds") {
    lines.push(
      ctx.family === "ai-automation" ? "## Systems & triggers" : "## Pages & requirements",
      bullets(a?.skills.slice(0, 6) ?? [], "As described in the brief"),
      "",
      "## Success criteria",
      bullets(ctx.acceptance.slice(0, 6), "All acceptance tests pass"),
      "",
      "## Out of scope",
      "- New features not listed above (quoted as change orders)\n- Production credentials (the client keeps ownership; we use scoped/sandbox keys)",
      "",
    );
  } else if (ctx.family === "localization-repurposing") {
    lines.push("## Languages", bullets(ctx.languages ?? [], "As briefed"), "", "## Source assets", bullets(a?.suppliedAssets ?? [], "To be supplied by the client"), "");
  } else if (ctx.family === "research-content") {
    lines.push("## Questions to answer", bullets(a?.buyerPriorities ?? [], "What decision should this research support?"), "", "## Method", "- Desk research, structured comparison, synthesis into recommendations", "");
  } else {
    lines.push("## Audience", `- Buyers of ${productPhrase(ctx.title)}; mobile-first, short attention span`, "", "## Mandatories", bullets(a?.suppliedAssets ?? [], "Brand guidelines to be supplied"), "");
  }
  lines.push("## Buyer priorities", bullets(a?.buyerPriorities ?? [], "On-time delivery"), "", "## Timeline", a?.deadlineDays ? `${a.deadlineDays} days from kickoff.` : "As agreed in the proposal.");
  if (ctx.revisionNote) lines.push("", "## Revision request", ctx.revisionNote);
  return lines.join("\n");
}

function researchDoc(ctx: ContentContext): string {
  const a = ctx.analysis;
  const product = productPhrase(ctx.title);
  const lines = [`# ${ctx.stepName} — ${ctx.title}`, "", heuristicNote(), ""];
  if (ctx.family === "localization-repurposing") {
    const langs = ctx.languages ?? ["Spanish"];
    lines.push(
      "## Glossary",
      `| Term | Rule | ${langs.join(" | ")} |`,
      `|---|---|${langs.map(() => "---").join("|")}|`,
      `| ${ctx.clientName ?? "Brand name"} | Do not translate | ${langs.map(() => ctx.clientName ?? "Brand").join(" | ")} |`,
      `| ${titleCase(product)} | Do not translate | ${langs.map(() => titleCase(product)).join(" | ")} |`,
      `| CTA | Adapt, keep ≤ 18 chars | ${langs.map(() => "(adapted)").join(" | ")} |`,
      "",
      "## Key findings",
      "- Source scripts average ~2.4 words/second — subtitles need line splits at natural pauses",
      "- On-screen text appears in 4 places per video; burned-in versions must avoid the lower-third",
      `- ${langs.length} target language${langs.length > 1 ? "s" : ""}: expect German lines ~20% longer than English`,
      "",
    );
  } else if (ctx.family === "research-content") {
    lines.push(
      "## Executive summary",
      `The ${product} space is crowded at the top and fragmented below it; the clearest openings are in positioning and channel mix rather than price.`,
      "",
      "## Key findings",
      "- Leaders compete on brand and breadth; challengers win on a single sharp promise",
      "- Pricing clusters in three tiers; the mid tier is the most contested",
      "- Review themes: reliability and support responsiveness drive both praise and churn",
      "- Paid social angles are dominated by discounts — proof-led creative is under-used",
      "",
      "## Comparison",
      "| Segment | Positioning | Price tier | Main channel |",
      "|---|---|---|---|",
      "| Category leaders | Breadth & trust | Premium | Search + retail |",
      "| Challengers | One sharp promise | Mid | Paid social |",
      "| Long tail | Price | Budget | Marketplaces |",
      "",
    );
  } else {
    lines.push(
      "## Key findings",
      `- Buyers of ${product} respond to concrete, visual proof in the first 2 seconds`,
      "- Top competitor ads lean on discounts; demo- and proof-led angles are under-used",
      "- Captions are essential — most views are sound-off",
      "",
      "## Competitor angles",
      "| Angle | Seen in market | Opportunity |",
      "|---|---|---|",
      "| Discount-first | Very common | Low differentiation |",
      "| Creator demo | Common | Win on authenticity + speed |",
      "| Proof / reviews | Rare | Strong opening |",
      "",
      "## Hook bank",
      ...buildConcepts(ctx).map((c) => `- ${c.script[0]}`),
      "",
    );
  }
  if (ctx.defect !== "missing_section") {
    lines.push(
      "## Sources",
      "- Client brief and supplied assets (primary)",
      a?.suppliedAssets.length ? `- Supplied: ${a.suppliedAssets.slice(0, 3).join("; ")}` : "- No supplied reference assets",
      "- Live web sources are cited here when Grok web research is enabled for this workspace",
    );
  }
  if (ctx.repairHint) lines.push("", `_Revised after QA: ${ctx.repairHint}_`);
  return lines.join("\n");
}

function conceptsDoc(ctx: ContentContext, concepts: Concept[]): string {
  if (ctx.family === "paid-social-ugc" || ctx.family === "image-design") {
    const lines = [`# ${ctx.stepName} — ${ctx.title}`, ""];
    concepts.forEach((c, i) => {
      lines.push(
        `## Concept ${i + 1}: ${c.angle}`,
        `- **Headline:** ${c.headline}`,
        `- **Subhead:** ${c.subhead}`,
        `- **CTA:** ${c.cta}`,
        `- **Scene:** ${c.scene}`,
        `- **Script beats:** ${c.script.join(" → ")}`,
        "",
      );
    });
    return lines.join("\n");
  }
  if (ctx.family === "ai-automation") {
    return [
      `# ${ctx.stepName} — ${ctx.title}`,
      "",
      "## Architecture",
      "Event trigger → validate & normalise → map → idempotent upsert (with retry/backoff) → dead-letter + alert on final failure.",
      "",
      "## Field mapping",
      "| Source field | Target field | Transform |",
      "|---|---|---|",
      "| id | external_id | string |",
      "| email | email | lower-case, trimmed (dedupe key) |",
      "| total | amount | decimal → cents |",
      "| created_at | created_date | ISO-8601 |",
      "",
      "## Error handling",
      "- 429 / 5xx: exponential backoff with jitter, max 5 attempts",
      "- 4xx validation errors: dead-letter immediately with the payload and reason",
      "- Final failures post a Slack alert with a replay link",
      "",
      "## Observability",
      "- Structured logs per event id; daily digest of dead-lettered events",
    ].join("\n");
  }
  if (ctx.family === "web-app-builds") {
    return [
      `# ${ctx.stepName} — ${ctx.title}`,
      "",
      "## Route map",
      "| Route | Purpose |",
      "|---|---|",
      "| / | Hero, proof, services, CTA |",
      "| /about | Story and team |",
      "| /work/[slug] | Case studies (CMS) |",
      "| /contact | Form with spam protection |",
      "",
      "## Components",
      "- Hero, SectionGrid, CaseStudyCard, Testimonial, ContactForm, SiteHeader, SiteFooter",
      "",
      "## Performance budget",
      "- LCP < 2.0s on 4G, CLS < 0.05, JS < 120 kB on the home page",
    ].join("\n");
  }
  return [
    `# ${ctx.stepName} — ${ctx.title}`,
    "",
    "## Outline",
    "1. Executive summary",
    "2. Context and method",
    "3. Findings (with evidence)",
    "4. Comparison",
    "5. Recommendations (prioritised)",
    "6. Sources",
  ].join("\n");
}

function copyDoc(ctx: ContentContext): string {
  const product = productPhrase(ctx.title);
  const research = ctx.prior.research ? ctx.prior.research.split("\n").filter((l) => l.startsWith("- ")).slice(0, 4) : [];
  return [
    `# ${ctx.title}`,
    "",
    heuristicNote(),
    "",
    "## Executive summary",
    `This deliverable answers the brief for ${ctx.clientName ?? "the client"}: where ${product} can win, what to do first, and how to measure it.`,
    "",
    "## Findings",
    ...(research.length ? research : ["- Findings from the research step"]),
    "",
    "## Discussion",
    `The strongest opportunities combine a sharp positioning statement with proof-led content. For ${product}, that means leading with concrete outcomes and backing every claim with a source or example.`,
    "",
    "## Recommendations",
    "1. Lead with one sharp promise and prove it in the first screen / paragraph.",
    "2. Build a repeatable content brief so every piece maps to a search or buying intent.",
    "3. Measure weekly: one leading indicator per recommendation, reviewed in a 15-minute check-in.",
    ctx.revisionNote ? `\n## Revision notes\n${ctx.revisionNote}` : "",
  ].join("\n");
}

function finalizeDoc(ctx: ContentContext): string {
  const upstream = Object.keys(ctx.prior);
  return [
    `# ${ctx.stepName} — ${ctx.title}`,
    "",
    "## Contents",
    ...upstream.map((k) => `- ${k}: see the matching folder in the delivery package`),
    "",
    "## Notes",
    `- Produced by GigPilot for ${ctx.clientName ?? "the client"} (${familyLabel(ctx.family)})`,
    "- Every deliverable passed an independent QA review before packaging",
    ...(ctx.family === "ai-automation" || ctx.family === "web-app-builds"
      ? ["", "## Runbook", "1. Copy `.env.example` to `.env` and fill in the client-held credentials", "2. `npm install && npm test`", "3. Deploy with the steps in README.md", "", "## Handover checklist", "- [ ] Credentials rotated to client-owned keys", "- [ ] Alert channel confirmed", "- [ ] Walkthrough recorded"]
      : ["", "## Next steps", "- Review the package and send consolidated feedback in one round"]),
  ].join("\n");
}

function assembleDoc(ctx: ContentContext, items: string[]): string {
  return [
    `# ${ctx.stepName} — ${ctx.title}`,
    "",
    "## Asset index",
    ...(items.length ? items.map((i) => `- ${i}`) : ["- (no assets)"]),
    "",
    "## Naming convention",
    "`<concept>-<aspect>-v<variant>.<ext>` — consistent across batches",
  ].join("\n");
}

export function generateDocument(ctx: ContentContext, extra: { assetNames?: string[] } = {}): { markdown: string; concepts?: Concept[] } {
  switch (ctx.stepKind) {
    case "brief":
      return { markdown: briefDoc(ctx) };
    case "research":
      return { markdown: researchDoc(ctx) };
    case "concepts": {
      const concepts = buildConcepts(ctx);
      return { markdown: conceptsDoc(ctx, concepts), concepts: ctx.family === "paid-social-ugc" || ctx.family === "image-design" ? concepts : undefined };
    }
    case "copy":
      return { markdown: copyDoc(ctx) };
    case "assemble":
      return { markdown: assembleDoc(ctx, extra.assetNames ?? []) };
    case "finalize":
      return { markdown: finalizeDoc(ctx) };
    default:
      return { markdown: [`# ${ctx.stepName} — ${ctx.title}`, "", heuristicNote(), "", truncate(ctx.brief, 800)].join("\n") };
  }
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

const LANG_CODES: Record<string, string> = {
  Spanish: "es", German: "de", French: "fr", Italian: "it", Portuguese: "pt-BR", Japanese: "ja", Korean: "ko", Dutch: "nl", Swedish: "sv", Chinese: "zh", Arabic: "ar", Polish: "pl", Turkish: "tr", Hindi: "hi", Norwegian: "no", Danish: "da", Finnish: "fi",
};

export function langCode(language: string): string {
  return LANG_CODES[language] ?? language.slice(0, 2).toLowerCase();
}

function ts(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

/** Deterministic SRT (mock translation placeholder lines, valid timing). `overlap` injects a timing defect. */
export function buildSrt(opts: { title: string; language: string; index: number; overlap: boolean }): string {
  const code = langCode(opts.language).toUpperCase();
  const product = productPhrase(opts.title);
  const lines = [
    `(${opts.language} — mock translation placeholder, GigPilot demo mode)`,
    `[${code}] Welcome — in this video we show ${product}.`,
    `[${code}] Step one: open the dashboard and pick your project.`,
    `[${code}] Step two: choose the settings that fit your team.`,
    `[${code}] Tip: save it as a template to reuse later.`,
    `[${code}] That's it — you're ready to go.`,
  ];
  let t = 500 + opts.index * 40;
  return lines
    .map((text, i) => {
      const start = opts.overlap && i === 2 ? t - 900 : t;
      const end = start + 2600;
      t = end + 200;
      return `${i + 1}\n${ts(start)} --> ${ts(end)}\n${text}`;
    })
    .join("\n\n")
    .concat("\n");
}
