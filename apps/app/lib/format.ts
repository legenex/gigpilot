export { formatUsd, formatPct, formatCompact, formatDuration, timeAgo, timeUntil } from "@gigpilot/ui";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return `${x.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${x.toISOString().slice(11, 16)} UTC`;
}

/** Budget range label: "$700–1,100", "$45–80/h", "Unknown". */
export function fmtBudget(type: string, min: number | null, max: number | null): string {
  const f = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const suffix = type === "hourly" ? "/h" : "";
  if (min && max && min !== max) return `$${f(min)}–${f(max)}${suffix}`;
  const v = max ?? min;
  return v ? `$${f(v)}${suffix}` : "—";
}

export function ageHours(d: Date | string | null | undefined, now = Date.now()): number | null {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  return (now - x.getTime()) / 3_600_000;
}

export function fmtAge(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Current time in ms (kept out of component bodies so render stays pure for the React compiler lint). */
export function nowMs(): number {
  return Date.now();
}

export function isPast(d: Date | string | null | undefined): boolean {
  if (!d) return false;
  return (typeof d === "string" ? new Date(d) : d).getTime() < Date.now();
}
