"use client";

import { StatusDot, Tooltip, cn } from "@gigpilot/ui";
import { useLiveStatus } from "@/components/live/live-provider";

/** Stream health + agent activity. Pulses only when agents are actually running. */
export function LiveIndicator({ runningAgents, compact }: { runningAgents: number; compact?: boolean }) {
  const status = useLiveStatus();
  const tone = status === "live" ? "profit" : status === "offline" ? "risk" : "warn";
  const text =
    status === "live"
      ? runningAgents > 0
        ? `Live · ${runningAgents} agent${runningAgents === 1 ? "" : "s"} running`
        : "Live · agents idle"
      : status === "offline"
        ? "Stream offline"
        : status === "reconnecting"
          ? "Reconnecting…"
          : "Connecting…";
  if (compact) {
    return (
      <Tooltip content={text} side="right">
        <span className="grid size-8 place-items-center" role="status" aria-label={text}>
          <StatusDot tone={tone} live={status === "live" && runningAgents > 0} className="size-2" />
        </span>
      </Tooltip>
    );
  }
  return (
    <span className={cn("flex items-center gap-2 text-xs", status === "live" ? "text-fg-2" : "text-fg-3")} role="status" aria-live="polite">
      <StatusDot tone={tone} live={status === "live" && runningAgents > 0} className="size-[7px]" />
      {text}
    </span>
  );
}
