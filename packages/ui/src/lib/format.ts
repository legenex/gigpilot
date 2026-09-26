/** Shared number/date formatting so marketing and dashboard read identically. */

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatUsd(n: number | null | undefined, opts: { cents?: boolean; sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s = opts.cents || (abs > 0 && abs < 10) ? usd2.format(abs) : usd0.format(abs);
  if (n < 0) return `−${s}`;
  return opts.sign && n > 0 ? `+${s}` : s;
}

export function formatPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return compact.format(n);
}

export function timeAgo(date: Date | string | null | undefined, now: Date = new Date()): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 0) return timeUntil(d, now);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function timeUntil(date: Date | string | null | undefined, now: Date = new Date()): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const s = Math.round((d.getTime() - now.getTime()) / 1000);
  if (s <= 0) return "overdue";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
