"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { cn } from "@gigpilot/ui";
import { RelTime } from "@/components/rel-time";
import { agentName } from "@/lib/labels";
import type { LiveEvent } from "@/lib/live-types";
import { useLiveEvents, useLiveStatus } from "./live-provider";

const LEVEL_DOT: Record<string, string> = {
  success: "bg-profit",
  warn: "bg-warn",
  error: "bg-risk",
  info: "bg-fg-3",
  debug: "bg-fg-4",
};

function hrefFor(e: LiveEvent): string | null {
  if (e.jobId) return `/jobs/${e.jobId}`;
  if (e.subjectType === "opportunity" && e.subjectId) return `/radar/${e.subjectId}`;
  if (e.subjectType === "job" && e.subjectId) return `/jobs/${e.subjectId}`;
  if (e.type.startsWith("market.")) return "/markets";
  if (e.type.startsWith("source.") || e.type.startsWith("provider.")) return "/integrations";
  if (e.type.startsWith("proposal.") || e.type.startsWith("application.")) return "/applications";
  if (e.type.startsWith("cost.") || e.type.startsWith("budget.")) return "/costs";
  return null;
}

/**
 * Live activity stream: server-rendered history merged with SSE arrivals.
 * New rows slide in from the top; filter narrows to a subject/job.
 */
export function ActivityStream({
  initial,
  filter,
  limit = 40,
  className,
  emptyText = "No agent activity yet. Sourcing starts as soon as a source is enabled.",
  dense,
}: {
  initial: LiveEvent[];
  filter?: { subjectIds?: string[]; jobId?: string };
  limit?: number;
  className?: string;
  emptyText?: string;
  dense?: boolean;
}) {
  const live = useLiveEvents();
  const status = useLiveStatus();
  const reduce = useReducedMotion();
  const initialIds = useMemo(() => new Set(initial.map((e) => e.id)), [initial]);

  const events = useMemo(() => {
    const matches = (e: LiveEvent) => {
      if (!filter) return true;
      if (filter.jobId && e.jobId === filter.jobId) return true;
      if (filter.subjectIds && e.subjectId && filter.subjectIds.includes(e.subjectId)) return true;
      return false;
    };
    const seen = new Set<string>();
    const out: LiveEvent[] = [];
    for (const e of [...live, ...initial]) {
      if (seen.has(e.id) || !matches(e)) continue;
      seen.add(e.id);
      out.push(e);
    }
    out.sort((a, b) => b.seq - a.seq);
    return out.slice(0, limit);
  }, [live, initial, filter, limit]);

  if (events.length === 0) {
    return (
      <div className={cn("py-6 text-xs text-fg-3", className)} data-testid="event-stream">
        {emptyText}
      </div>
    );
  }

  return (
    <ol className={cn("relative", className)} data-testid="event-stream" aria-label="Agent activity" aria-live={status === "live" ? "polite" : "off"} aria-relevant="additions">
      <AnimatePresence initial={false}>
        {events.map((e) => {
          const href = hrefFor(e);
          const fresh = !initialIds.has(e.id);
          const body = (
            <>
              <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", LEVEL_DOT[e.level] ?? "bg-fg-3")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3">{agentName(e.agent)}</span>
                  <RelTime date={e.createdAt} compact className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-3" />
                </span>
                <span className={cn("block text-[13px] leading-5 text-fg-2", dense ? "truncate" : "line-clamp-2")}>{e.message}</span>
              </span>
            </>
          );
          return (
            <motion.li
              key={e.id}
              layout={reduce ? false : "position"}
              initial={fresh && !reduce ? { opacity: 0, y: -6, backgroundColor: "rgba(255,255,255,0.04)" } : false}
              animate={{ opacity: 1, y: 0, backgroundColor: "rgba(255,255,255,0)" }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1], backgroundColor: { duration: 1.6 } }}
              data-testid="event-item"
              data-type={e.type}
              className="rounded-sm"
            >
              {href ? (
                <Link href={href} className={cn("flex gap-2.5 rounded-sm px-1.5 outline-none hover:bg-surface-1 focus-visible:bg-surface-1", dense ? "py-1.5" : "py-2")}>
                  {body}
                </Link>
              ) : (
                <div className={cn("flex gap-2.5 px-1.5", dense ? "py-1.5" : "py-2")}>{body}</div>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
