import type { Capability, WorkflowStepPlan } from "@gigpilot/contracts";

/**
 * Per-service-family production templates. The planner uses the analysis'
 * proposed workflow when it is valid and falls back to these otherwise; the
 * deterministic analyser proposes exactly these.
 */

export interface TemplateContext {
  /** Primary creative batch (A). */
  primary?: { capability: Capability; label: string; aspectRatio?: string };
  /** Secondary creative batch (B). */
  secondary?: { capability: Capability; label: string; aspectRatio?: string };
  languages?: string[];
}

const step = (s: Omit<WorkflowStepPlan, "dependsOn" | "acceptance"> & { dependsOn?: string[]; acceptance?: string[] }): WorkflowStepPlan => ({
  dependsOn: [],
  acceptance: [],
  ...s,
});

function creativeAcceptance(capability: Capability, aspect?: string): string[] {
  if (capability.startsWith("video.")) {
    return [
      `Frame aspect ratio exactly ${aspect ?? "as briefed"}`,
      "Hook lands in the first 2 seconds",
      "Shot list covers hook → demo → proof → CTA",
    ];
  }
  return [`Aspect ratio exactly ${aspect ?? "as briefed"}`, "Logo inside the safe zone", "Headline fits the canvas", "CTA legible at mobile size"];
}

/** "10× 9:16 UGC-style video (20s)" → "9:16 UGC-style videos (20s)" for step names. */
export function batchName(label: string): string {
  const stripped = label.replace(/^\d+\s*×\s*/, "").trim();
  return stripped.replace(/\b(video|creative|composite|retouch|thumbnail|visual|illustration|mockup|clip|ad|template|export|slide)\b(?!s)/, "$1s");
}

export function creativeTemplate(ctx: TemplateContext): WorkflowStepPlan[] {
  const a = ctx.primary ?? { capability: "image.generate" as Capability, label: "Hero creatives", aspectRatio: "1:1" };
  const b = ctx.secondary ?? a;
  return [
    step({ key: "brief", name: "Creative brief", kind: "brief", agent: "copywriter", capability: "text.copy", acceptance: ["Objective, audience and offer captured", "Deliverables listed with formats and aspect ratios", "Brand mandatories listed"] }),
    step({ key: "research", name: "Audience & angle research", kind: "research", agent: "researcher", capability: "text.research", dependsOn: ["brief"], acceptance: ["At least 3 audience insights", "Competitor angle scan", "Sources section included"] }),
    step({ key: "concepts", name: "Concepts, hooks & scripts", kind: "concepts", agent: "copywriter", capability: "text.copy", dependsOn: ["research"], acceptance: ["Headline, subhead and CTA per concept", "Script beats for video concepts"] }),
    step({ key: "asset_a", name: `${batchName(a.label)} — batch A`, kind: "generate", agent: "creative", capability: a.capability, dependsOn: ["concepts"], estimateLabel: a.label, acceptance: creativeAcceptance(a.capability, a.aspectRatio) }),
    step({ key: "asset_b", name: `${batchName(b.label)} — batch B`, kind: "generate", agent: "creative", capability: b.capability, dependsOn: ["concepts"], estimateLabel: b.label, acceptance: creativeAcceptance(b.capability, b.aspectRatio) }),
    step({ key: "assemble", name: "Assemble & format pack", kind: "assemble", agent: "finisher", capability: "media.finishing", dependsOn: ["asset_a", "asset_b"], acceptance: ["Contact sheet of every asset", "Consistent file naming"] }),
    step({ key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["assemble"], acceptance: ["Every asset passes format checks", "Matches the brief and brand mandatories"] }),
    step({ key: "finalize", name: "Final package & notes", kind: "finalize", agent: "finisher", capability: "media.finishing", dependsOn: ["qa"], acceptance: ["Final selects and delivery notes"] }),
  ];
}

export function codingTemplate(kind: "automation" | "web"): WorkflowStepPlan[] {
  const agent = kind === "automation" ? "automation" : "coder";
  const capability: Capability = kind === "automation" ? "code.automation" : "code.build";
  return [
    step({ key: "scope", name: kind === "automation" ? "Scope systems & data flows" : "Scope pages & requirements", kind: "brief", agent, capability: "text.research", acceptance: ["Systems/pages and success criteria listed", "Out-of-scope items explicit"] }),
    step({ key: "plan", name: kind === "automation" ? "Integration design" : "Architecture & page plan", kind: "concepts", agent, capability: "text.research", dependsOn: ["scope"], acceptance: kind === "automation" ? ["Field mapping table", "Retry and error-handling strategy"] : ["Route map and components", "Performance budget"] }),
    step({ key: "implement", name: kind === "automation" ? "Build the automation" : "Build the site", kind: "code", agent, capability, dependsOn: ["plan"], acceptance: ["Source and README included", "All tests pass", "Secrets only via environment variables"] }),
    step({ key: "test", name: kind === "automation" ? "Test run & report" : "Build, tests & Lighthouse", kind: "test", agent, capability, dependsOn: ["implement"], acceptance: ["Test report attached", "Edge cases covered"] }),
    step({ key: "review", name: "Independent code review (QA)", kind: "review", agent: "qa", capability: "qa.review", dependsOn: ["test"], acceptance: ["Independent review passed", "No failing tests"] }),
    step({ key: "finalize", name: "Handoff & runbook", kind: "finalize", agent: "finisher", capability: "text.copy", dependsOn: ["review"], acceptance: ["Runbook with setup steps", "Handover checklist"] }),
  ];
}

export function localizationTemplate(ctx: TemplateContext): WorkflowStepPlan[] {
  const langs = ctx.languages && ctx.languages.length ? ctx.languages : ["Spanish"];
  const half = Math.ceil(langs.length / 2);
  const a = langs.slice(0, half);
  const b = langs.slice(half);
  return [
    step({ key: "brief", name: "Localisation brief", kind: "brief", agent: "localiser", capability: "text.copy", acceptance: ["Source assets, languages and formats listed"] }),
    step({ key: "glossary", name: "Source analysis & glossary", kind: "research", agent: "localiser", capability: "text.research", dependsOn: ["brief"], acceptance: ["Do-not-translate terms", "Sources section included"] }),
    step({ key: "translate_a", name: `Translations — ${a.join(", ")}`, kind: "translate", agent: "localiser", capability: "text.translate", dependsOn: ["glossary"], acceptance: ["Valid SRT, no overlapping cues", "Glossary respected"] }),
    ...(b.length
      ? [step({ key: "translate_b", name: `Translations — ${b.join(", ")}`, kind: "translate", agent: "localiser", capability: "text.translate", dependsOn: ["glossary"], acceptance: ["Valid SRT, no overlapping cues", "Glossary respected"] })]
      : []),
    step({ key: "format", name: "Subtitle timing & formatting", kind: "assemble", agent: "finisher", capability: "media.finishing", dependsOn: b.length ? ["translate_a", "translate_b"] : ["translate_a"], acceptance: ["Reading speed ≤ 17 cps", "Consistent file naming"] }),
    step({ key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["format"], acceptance: ["Every file passes format checks"] }),
    step({ key: "finalize", name: "Final package & notes", kind: "finalize", agent: "finisher", capability: "media.finishing", dependsOn: ["qa"], acceptance: ["Delivery notes per language"] }),
  ];
}

export function researchTemplate(): WorkflowStepPlan[] {
  return [
    step({ key: "brief", name: "Research brief", kind: "brief", agent: "researcher", capability: "text.research", acceptance: ["Questions and decision the research supports"] }),
    step({ key: "research", name: "Desk research & evidence", kind: "research", agent: "researcher", capability: "text.research", dependsOn: ["brief"], acceptance: ["Key findings with evidence", "Sources section included"] }),
    step({ key: "outline", name: "Structure & outline", kind: "concepts", agent: "researcher", capability: "text.research", dependsOn: ["research"], acceptance: ["Outline maps to the brief"] }),
    step({ key: "draft", name: "Write the deliverable", kind: "copy", agent: "copywriter", capability: "text.copy", dependsOn: ["outline"], acceptance: ["Executive summary", "Recommendations are specific"] }),
    step({ key: "qa", name: "Independent QA", kind: "qa", agent: "qa", capability: "qa.review", dependsOn: ["draft"], acceptance: ["Required sections present", "Claims trace to sources"] }),
    step({ key: "finalize", name: "Final package & notes", kind: "finalize", agent: "finisher", capability: "text.copy", dependsOn: ["qa"], acceptance: ["Contents list and delivery notes"] }),
  ];
}

export function templateForFamily(family: string, ctx: TemplateContext = {}): WorkflowStepPlan[] {
  switch (family) {
    case "paid-social-ugc":
    case "image-design":
      return creativeTemplate(ctx);
    case "ai-automation":
      return codingTemplate("automation");
    case "web-app-builds":
      return codingTemplate("web");
    case "localization-repurposing":
      return localizationTemplate(ctx);
    default:
      return researchTemplate();
  }
}

/** Step kinds whose output is reviewed by QA. */
export const REVIEWABLE_KINDS = new Set(["generate", "code", "test", "copy", "translate", "research", "assemble"]);
/** Step kinds that produce the primary deliverables (defect injection targets). */
export const PRODUCTION_KINDS = new Set(["generate", "code", "copy", "translate", "research"]);

export function isQaStep(s: { agent: string }): boolean {
  return s.agent === "qa";
}
