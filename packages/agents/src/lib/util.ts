/** Small shared helpers for agents (formatting, hashing, error hygiene). */

export function fnv(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/** "$2,400" (whole dollars ≥ $100) or "$12.40" / "$0.056" for small amounts. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 100) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs === 0) return "$0";
  return `${sign}$${abs.toFixed(abs < 0.01 ? 4 : 3)}`;
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function quote(title: string, max = 60): string {
  return `'${truncate(title, max)}'`;
}

/** Secret-free, bounded error message for persistence and logs. */
export function safeError(err: unknown, max = 500): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return (raw ?? "unknown error")
    .replace(/(Bearer|Key)\s+[A-Za-z0-9._:-]+/gi, "$1 [redacted]")
    .replace(/\b(sk|fk|xai|gx)-[A-Za-z0-9_-]{6,}/gi, "[redacted]")
    .replace(/postgres(ql)?:\/\/[^\s@]+@/gi, "postgres://[redacted]@")
    .slice(0, max);
}

export function slugify(s: string, max = 48): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "item"
  );
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

export const FAMILY_LABELS: Record<string, string> = {
  "paid-social-ugc": "Paid social & UGC",
  "image-design": "Image & design",
  "localization-repurposing": "Localization & repurposing",
  "ai-automation": "AI automation",
  "web-app-builds": "Web & app builds",
  "research-content": "Research & content",
};

export function familyLabel(key: string | null | undefined): string {
  return (key && FAMILY_LABELS[key]) ?? key ?? "Unclassified";
}
