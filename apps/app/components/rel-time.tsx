"use client";

import { useEffect, useState } from "react";

function rel(ms: number): string {
  const s = Math.round(ms / 1000);
  const abs = Math.abs(s);
  const future = s < 0;
  let v: string;
  if (abs < 45) v = "now";
  else if (abs < 3600) v = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) v = `${Math.round(abs / 3600)}h`;
  else v = `${Math.round(abs / 86400)}d`;
  if (v === "now") return "just now";
  return future ? `in ${v}` : `${v} ago`;
}

/** Relative time that stays fresh; absolute timestamp on hover. */
export function RelTime({ date, className, compact }: { date: Date | string | null | undefined; className?: string; compact?: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to the client clock after hydration
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!date) return <span className={className}>—</span>;
  const d = typeof date === "string" ? new Date(date) : date;
  const base = now ?? d.getTime();
  const text = now === null ? "" : rel(base - d.getTime());
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className={className} suppressHydrationWarning>
      {compact ? (text === "just now" ? "now" : text.replace(" ago", "")) : text}
    </time>
  );
}
