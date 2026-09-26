"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@gigpilot/ui";

/** Elapsed runtime; ticks every second while running (no end), static otherwise. */
export function Runtime({ start, end, className }: { start: string | Date | null; end?: string | Date | null; className?: string }) {
  const running = Boolean(start && !end);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to client clock after hydration
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  if (!start) return <span className={className}>—</span>;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : now;
  if (e === null) return <span className={className} suppressHydrationWarning>…</span>;
  return (
    <span className={className} suppressHydrationWarning>
      {formatDuration(Math.max(0, e - s))}
    </span>
  );
}
