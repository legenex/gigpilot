/**
 * Pure opportunity rules: duplicate detection, service-family matching,
 * expiry and low-budget handling. Deterministic and unit tested.
 */

const STOP = new Set(
  "a an and are as at be but by for from has have i in is it of on or our the this to we with you your will looking need needed want project job".split(" "),
);

export function normaliseText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9$ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(input: string): string[] {
  return normaliseText(input)
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** FNV-1a 32-bit — stable, dependency-free hash for dedupe keys. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Exact-duplicate key: normalised title + first 60 significant description
 * tokens (sorted-insensitive to whitespace/punctuation/case changes).
 */
export function dedupeHash(title: string, description: string): string {
  const t = tokens(title).join(" ");
  const d = tokens(description).slice(0, 60).join(" ");
  return `${fnv1a(t)}${fnv1a(d)}`;
}

function shingles(input: string, size = 3): Set<string> {
  const toks = tokens(input);
  const out = new Set<string>();
  if (toks.length < size) {
    if (toks.length) out.add(toks.join(" "));
    return out;
  }
  for (let i = 0; i <= toks.length - size; i++) out.add(toks.slice(i, i + size).join(" "));
  return out;
}

function jaccard(sa: Set<string>, sb: Set<string>): number {
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Text similarity (0..1): the max of 3-token shingle Jaccard (order-aware,
 * catches copy-paste) and significant-token set Jaccard (catches rephrased
 * cross-posts). Stop words are removed first.
 */
export function similarity(a: string, b: string): number {
  return Math.max(jaccard(shingles(a), shingles(b)), jaccard(new Set(tokens(a)), new Set(tokens(b))));
}

export interface DedupeCandidate {
  id: string;
  title: string;
  description: string;
  dedupeHash: string;
}

/**
 * Returns the id of an existing opportunity this one duplicates (exact hash
 * match, or near-duplicate text across sources), else null.
 */
export function findDuplicate(
  incoming: { title: string; description: string },
  existing: DedupeCandidate[],
  threshold = 0.72,
): string | null {
  const hash = dedupeHash(incoming.title, incoming.description);
  const exact = existing.find((e) => e.dedupeHash === hash);
  if (exact) return exact.id;
  const text = `${incoming.title} ${incoming.description}`;
  let best: { id: string; score: number } | null = null;
  for (const e of existing) {
    const score = similarity(text, `${e.title} ${e.description}`);
    if (score >= threshold && (!best || score > best.score)) best = { id: e.id, score };
  }
  return best?.id ?? null;
}

export interface MarketDescriptor {
  key: string;
  enabled: boolean;
  keywords: string[];
}

/**
 * Keyword-based service-family matching (the deterministic baseline; the
 * analyst may refine it). Returns the best enabled market or null.
 */
export function matchServiceFamily(
  text: string,
  skills: string[],
  markets: MarketDescriptor[],
): { key: string; score: number } | null {
  const hay = ` ${normaliseText(`${text} ${skills.join(" ")}`)} `;
  let best: { key: string; score: number } | null = null;
  for (const m of markets) {
    if (!m.enabled) continue;
    let score = 0;
    for (const kw of m.keywords) {
      const k = normaliseText(kw);
      if (!k) continue;
      if (hay.includes(` ${k} `)) score += k.includes(" ") ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { key: m.key, score };
  }
  return best;
}

export function isExpired(
  opp: { postedAt?: Date | null; expiresAt?: Date | null; deadlineAt?: Date | null },
  maxAgeHours: number,
  now: Date = new Date(),
): boolean {
  if (opp.expiresAt && opp.expiresAt.getTime() <= now.getTime()) return true;
  if (opp.deadlineAt && opp.deadlineAt.getTime() <= now.getTime()) return true;
  if (opp.postedAt && now.getTime() - opp.postedAt.getTime() > maxAgeHours * 3_600_000) return true;
  return false;
}

export type BudgetTriage = "ok" | "low_budget" | "unknown_budget";

/**
 * Early triage before spending any inference on analysis. Low-budget work is
 * still analysed cheaply (local GX) but is flagged so it rarely reaches the
 * shortlist.
 */
export function triageBudget(
  opp: { budgetType: "fixed" | "hourly" | "unknown"; budgetMinUsd?: number | null; budgetMaxUsd?: number | null },
  preferredMinBudgetUsd: number,
  hourlyRateFloorUsd = 25,
): BudgetTriage {
  const max = opp.budgetMaxUsd ?? opp.budgetMinUsd ?? null;
  if (opp.budgetType === "unknown" || max === null || max <= 0) return "unknown_budget";
  if (opp.budgetType === "hourly") return max < hourlyRateFloorUsd ? "low_budget" : "ok";
  return max < preferredMinBudgetUsd ? "low_budget" : "ok";
}
