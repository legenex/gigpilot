import { SERVICE_FAMILIES } from "@gigpilot/config/defaults";
import { AGENTS, INTEGRATIONS, type ApplicationState, type JobState, type OpportunityState, type ProposalState, type RunState, type StepState } from "@gigpilot/contracts";
import type { Tone } from "@gigpilot/ui";

export interface StateMeta {
  label: string;
  tone: Tone;
  /** Work is actively happening in this state (status dot pulses). */
  live?: boolean;
}

export const OPPORTUNITY_META: Record<OpportunityState, StateMeta> = {
  new: { label: "New", tone: "neutral" },
  analysing: { label: "Analysing", tone: "info", live: true },
  analysed: { label: "Analysed", tone: "neutral" },
  shortlisted: { label: "Shortlisted", tone: "violet" },
  rejected: { label: "Rejected", tone: "neutral" },
  pursuing: { label: "Pursuing", tone: "info" },
  applied: { label: "Applied", tone: "info" },
  won: { label: "Won", tone: "profit" },
  lost: { label: "Lost", tone: "risk" },
  expired: { label: "Expired", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export const PROPOSAL_META: Record<ProposalState, StateMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "accent" },
  approved: { label: "Approved", tone: "profit" },
  rejected: { label: "Rejected", tone: "risk" },
  superseded: { label: "Superseded", tone: "neutral" },
};

export const APPLICATION_META: Record<ApplicationState, StateMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  submitted: { label: "Submitted", tone: "info" },
  client_response: { label: "Client response", tone: "violet" },
  negotiating: { label: "Negotiating", tone: "violet" },
  won: { label: "Won", tone: "profit" },
  lost: { label: "Lost", tone: "risk" },
  expired: { label: "Expired", tone: "neutral" },
};

export const JOB_META: Record<JobState, StateMeta> = {
  intake: { label: "Intake", tone: "neutral", live: true },
  planning: { label: "Planning", tone: "info", live: true },
  awaiting_inputs: { label: "Awaiting inputs", tone: "warn" },
  ready: { label: "Ready", tone: "info" },
  executing: { label: "Executing", tone: "info", live: true },
  qa: { label: "QA", tone: "violet", live: true },
  repairing: { label: "Repairing", tone: "warn", live: true },
  awaiting_final_approval: { label: "Awaiting final approval", tone: "accent" },
  delivered: { label: "Delivered", tone: "profit" },
  closed: { label: "Closed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "risk" },
};

export const STEP_META: Record<StepState, StateMeta> = {
  pending: { label: "Pending", tone: "neutral" },
  ready: { label: "Ready", tone: "neutral" },
  running: { label: "Running", tone: "info", live: true },
  succeeded: { label: "Succeeded", tone: "profit" },
  failed: { label: "Failed", tone: "risk" },
  blocked: { label: "Blocked", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const RUN_META: Record<RunState, StateMeta> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info", live: true },
  succeeded: { label: "Succeeded", tone: "profit" },
  failed: { label: "Failed", tone: "risk" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const DELIVERY_META: Record<string, StateMeta> = {
  preparing: { label: "Preparing", tone: "info", live: true },
  prepared: { label: "Ready for review", tone: "accent" },
  approved: { label: "Approved", tone: "profit" },
  sent: { label: "Sent", tone: "profit" },
  rejected: { label: "Changes requested", tone: "warn" },
};

export const RECOMMENDATION_META: Record<"pursue" | "consider" | "skip", StateMeta> = {
  pursue: { label: "Pursue", tone: "profit" },
  consider: { label: "Consider", tone: "warn" },
  skip: { label: "Skip", tone: "neutral" },
};

export const INTEGRATION_STATUS_META: Record<string, StateMeta> = {
  connected: { label: "Connected", tone: "profit" },
  needs_configuration: { label: "Not configured", tone: "neutral" },
  unavailable: { label: "Unavailable", tone: "neutral" },
  degraded: { label: "Degraded", tone: "warn" },
  error: { label: "Error", tone: "risk" },
  mock: { label: "Simulated", tone: "info" },
};

export function sourceName(key: string): string {
  return INTEGRATIONS.find((i) => i.key === key)?.name ?? key;
}

/** Short source label for dense tables. */
export const SOURCE_SHORT: Record<string, string> = {
  upwork: "Upwork",
  freelancer: "Freelancer",
  contra: "Contra",
  fiverr: "Fiverr",
  web: "Web feed",
  direct: "Direct",
  mock: "Demo",
};

export function agentName(key: string | null | undefined): string {
  if (!key) return "System";
  return (AGENTS as Record<string, { name: string }>)[key]?.name ?? key;
}

export const COST_CATEGORY_META: Record<string, { label: string; color: string }> = {
  inference: { label: "Inference", color: "var(--gp-series-1)" },
  creative: { label: "Creative", color: "var(--gp-series-2)" },
  tool: { label: "Tools", color: "var(--gp-series-3)" },
  subcontractor: { label: "Subcontractor", color: "var(--gp-series-3)" },
  marketplace_fee: { label: "Marketplace fees", color: "var(--gp-series-4)" },
  human_shadow: { label: "Human shadow", color: "var(--gp-fg-3)" },
  revenue: { label: "Revenue", color: "var(--gp-profit)" },
};

export const LEVEL_TONE: Record<string, Tone> = {
  debug: "neutral",
  info: "neutral",
  success: "profit",
  warn: "warn",
  error: "risk",
};

export function humanize(s: string): string {
  return s.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Service families — one lookup, never lowercase slugs in the UI.
// ---------------------------------------------------------------------------

const FAMILY_NAMES: Record<string, string> = Object.fromEntries(SERVICE_FAMILIES.map((f) => [f.key, f.name]));
const FAMILY_SHORT: Record<string, string> = {
  "paid-social-ugc": "Paid social & UGC",
  "image-design": "Image & design",
  "localization-repurposing": "Localization",
  "ai-automation": "AI automation",
  "web-app-builds": "Web & app builds",
  "research-content": "Research & content",
};

/** "paid-social-ugc" → "Paid social creatives & UGC" (short: "Paid social & UGC"). */
export function serviceFamilyLabel(key: string | null | undefined, short = false): string {
  if (!key) return "Unclassified";
  return (short ? FAMILY_SHORT[key] : undefined) ?? FAMILY_NAMES[key] ?? humanize(key);
}

// ---------------------------------------------------------------------------
// Routes (provider/model) — owner-facing labels; raw ids live behind
// "Operator details" disclosures and title attributes only.
// ---------------------------------------------------------------------------

const VENDOR_PREFIX = /^(google|openai|bytedance|black-forest-labs|kwai|runway|luma|minimax)\//i;
const PROVIDER_NAME: Record<string, string> = { kie: "Kie", higgsfield: "Higgsfield", factory: "Factory", grok: "Grok", gx: "GX" };

function prettyModel(model: string): string {
  const segs = model.replace(VENDOR_PREFIX, "").split("/").filter((x) => !/^(video|image|audio)$/i.test(x));
  const core = (segs[0] ?? model).replace(/-(\d)-(\d)\b/, "-$1.$2");
  return core
    .split("-")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Human route label: "Local model · free", "Simulated", "Preliminary triage", "Kie · Veo 3.1". */
export function routeLabel(provider: string | null | undefined, model?: string | null): string {
  if (!provider) return "—";
  const p = provider.toLowerCase();
  const m = (model ?? "").toLowerCase();
  if (p === "mock" || m.startsWith("mock")) return "Simulated";
  if (p === "sample") return "Sample history";
  if (p === "heuristic") return "Preliminary triage";
  if (p === "deterministic") return "Deterministic calculator";
  if (p === "local") return "Local tooling · free";
  if (p === "gx") return "Local model · free";
  if (p === "factory") return "Cloud model · Factory";
  if (p === "grok") return "Grok · web research";
  if (PROVIDER_NAME[p] && model) return `${PROVIDER_NAME[p]} · ${prettyModel(model)}`;
  return PROVIDER_NAME[p] ?? humanize(provider);
}

/** Raw operator identifier, for title attributes / operator disclosures. */
export function routeId(provider: string | null | undefined, model?: string | null): string {
  if (!provider) return "";
  return model ? `${provider}/${model}` : provider;
}

const STEP_KIND_LABEL: Record<string, string> = {
  brief: "Brief",
  research: "Research",
  concepts: "Concepts",
  copy: "Copywriting",
  code: "Build",
  test: "Tests",
  qa: "QA review",
  review: "Code review",
  generate: "Generation",
  translate: "Translation",
  transcribe: "Transcription",
  subtitle: "Subtitles",
  assemble: "Assembly",
  finalize: "Packaging",
  plan: "Planning",
  scope: "Scoping",
  implement: "Build",
};

/** Agent-run task names → owner copy ("analyse_opportunity.refine" → "Deep analysis"). */
export function taskLabel(task: string): string {
  const t = task.trim();
  if (t === "analyse_opportunity") return "Triage & pricing";
  if (t === "analyse_opportunity.refine") return "Deep analysis";
  if (t === "market_research") return "Market scan";
  if (t === "source.refresh") return "Source refresh";
  const step = /^step\.([a-z_]+)$/.exec(t);
  if (step) return STEP_KIND_LABEL[step[1]!] ?? humanize(step[1]!);
  const norm = /^Normalise listing from (\w+)$/.exec(t);
  if (norm) return `Normalise ${SOURCE_SHORT[norm[1]!] ?? norm[1]} listing`;
  // Raw identifiers (no spaces) get humanised; sentences pass through.
  if (!/\s/.test(t) && /[._]/.test(t)) return humanize(t);
  return t;
}

/** Step keys used in event copy ("implement", "qa") → labels. */
export function stepKindLabel(kind: string): string {
  return STEP_KIND_LABEL[kind] ?? humanize(kind);
}

// ---------------------------------------------------------------------------
// QA findings
// ---------------------------------------------------------------------------

const FINDING_LABEL: Record<string, string> = {
  demo_injected_defect: "Simulated defect — demo",
  tests_not_executed: "Tests generated, not executed",
  produced_by_mock: "Simulated output",
  failing_tests: "Failing tests",
  missing_section: "Missing section",
  no_output: "No output",
  too_short: "Too short",
  srt_timing: "Subtitle timing",
};

/** Owner label for a QA finding code; detects the demo defect by message when the code is generic. */
export function findingLabel(code: string, message = ""): string | null {
  if (/demo defect injected|injected defect/i.test(message)) return FINDING_LABEL.demo_injected_defect!;
  return FINDING_LABEL[code] ?? null;
}

// ---------------------------------------------------------------------------
// Activity stream hygiene
// ---------------------------------------------------------------------------

/** Operator/system plumbing kept out of the owner's activity stream. */
export const SYSTEM_EVENT_TYPES = [
  "provider.health",
  "provider.quota",
  "source.failed",
  "agent.run",
  "system",
  "outbox.requeued",
  "budget.reserved",
  "step.stale_result",
  "security.output_rejected",
] as const;
const SYSTEM_SET = new Set<string>(SYSTEM_EVENT_TYPES);

export function isSystemEvent(type: string): boolean {
  return SYSTEM_SET.has(type);
}

const ROUTE_TOKEN = /\b(gx|mock|heuristic|factory|grok|kie|higgsfield|local|deterministic)\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g;
const PATH_WITH_LABEL = /[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{2,4}\s*\(([^)]+)\)/gi;
const BARE_PATH = /(?:\/?[\w.-]+\/)+([\w.-]+\.[a-z0-9]{2,4})\b/gi;
const QUOTED = /'([^']{3,})'/g;

function stripEllipsis(t: string): string {
  return t.replace(/(…|\.\.\.)$/, "").trim();
}

/**
 * Owner-facing copy for an event message: human route labels instead of
 * provider/model ids, no file paths or mock refs, no "Demo marketplace
 * (demo marketplace)" doubling, no title repeated twice, proper minus signs.
 */
export function cleanMessage(raw: string): string {
  let m = raw;
  // "Analysis of 'X' finished — Analysed 'X…' — …" → "Analysed 'X' — …"
  const parts = m.split(" — ");
  if (parts.length > 1) {
    const head = [...parts[0]!.matchAll(QUOTED)].map((x) => x[1]!)[0];
    if (head) {
      const rest = parts.slice(1).join(" — ");
      const dup = [...rest.matchAll(QUOTED)].map((x) => x[1]!).find((q) => {
        const a = stripEllipsis(head);
        const b = stripEllipsis(q);
        return a.startsWith(b) || b.startsWith(a);
      });
      if (dup) {
        const longest = stripEllipsis(dup).length > stripEllipsis(head).length ? dup : head;
        m = rest.replace(`'${dup}'`, `'${longest}'`);
      }
    }
  }
  m = m.replace(PATH_WITH_LABEL, "$1");
  m = m.replace(BARE_PATH, "$1");
  m = m.replace(ROUTE_TOKEN, (_all, p: string, model: string) => routeLabel(p, model));
  m = m.replace(/\s*\(?\bmock-[0-9a-f]{6,}\b\)?/gi, "");
  m = m.replace(/(Demo marketplace[^()]*?)\s*\(demo marketplace\)/gi, "$1");
  m = m.replace(/\bDEMO\s*\[DEMO\]/g, "Demo");
  m = m.replace(/\$-(\d)/g, "−$$$1");
  m = m.replace(/-\$(\d)/g, "−$$$1");
  m = m.replace(/\bReceived via generic:/, "Received via forwarded email:");
  m = m.replace(/\s{2,}/g, " ").trim();
  return m;
}
