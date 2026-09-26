"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@gigpilot/ui";
import { RelTime } from "@/components/rel-time";
import { SampleBadge } from "@/components/sample/sample-badge";
import { agentName, cleanMessage, isSystemEvent } from "@/lib/labels";
import type { LiveEvent } from "@/lib/live-types";
import { isSample } from "@/lib/sample";
import { useLiveEvents, useLiveStatus } from "./live-provider";

const LEVEL_DOT: Record<string, string> = {
  success: "bg-profit",
  warn: "bg-warn",
  error: "bg-risk",
  info: "bg-fg-3",
  debug: "bg-fg-3",
};

/** Arrivals are coalesced into one insert per window so bursts never animate over each other. */
const BATCH_MS = 250;
/** Groups larger than this appear without an entrance animation. */
const ANIMATE_MAX = 3;

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

interface Arrival {
  e: LiveEvent;
  /** Size of the batch this event arrived in (0 = server-rendered history). */
  batch: number;
}

/**
 * Live activity stream: server-rendered history merged with SSE arrivals.
 * Arrivals are buffered for ~250ms and inserted as one group whose rows grow
 * in height together (no sibling transforms, so bursts can't overlap);
 * groups of more than three appear instantly. Operator/system plumbing
 * (provider health, queue maintenance) is filtered out of the owner view.
 */
export function ActivityStream({
  initial,
  filter,
  limit = 40,
  className,
  emptyText = "No agent activity yet. Sourcing starts as soon as a source is enabled.",
  dense,
  includeSystem = false,
  sampleBefore,
}: {
  initial: LiveEvent[];
  filter?: { subjectIds?: string[]; jobId?: string };
  limit?: number;
  className?: string;
  emptyText?: string;
  dense?: boolean;
  /** Show provider-health / system events too (operator views). */
  includeSystem?: boolean;
  /** Tenant creation time (ISO): events created before it are sample history. */
  sampleBefore?: string | null;
}) {
  const live = useLiveEvents();
  const status = useLiveStatus();
  const reduce = useReducedMotion();

  const matches = useMemo(() => {
    const ids = filter?.subjectIds ? new Set(filter.subjectIds) : null;
    return (e: LiveEvent) => {
      if (!includeSystem && isSystemEvent(e.type)) return false;
      if (!filter) return true;
      if (filter.jobId && e.jobId === filter.jobId) return true;
      if (ids && e.subjectId && ids.has(e.subjectId)) return true;
      return false;
    };
  }, [filter, includeSystem]);

  // Buffer SSE arrivals and flush them as one batch.
  const [arrived, setArrived] = useState<Arrival[]>([]);
  const known = useRef(new Set<string>());
  const pending = useRef<LiveEvent[]>([]);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    for (const e of initial) known.current.add(e.id);
  }, [initial]);
  useEffect(() => {
    const fresh = live.filter((e) => !known.current.has(e.id) && matches(e));
    if (!fresh.length) return;
    for (const e of fresh) known.current.add(e.id);
    pending.current.push(...fresh);
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const batch = pending.current.splice(0).sort((a, b) => b.seq - a.seq);
      setArrived((prev) => [...batch.map((e) => ({ e, batch: batch.length })), ...prev].slice(0, limit * 2));
    }, BATCH_MS);
  }, [live, matches, limit]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Arrival[] = [];
    for (const a of [...arrived, ...initial.map((e) => ({ e, batch: 0 }))]) {
      if (seen.has(a.e.id) || !matches(a.e)) continue;
      seen.add(a.e.id);
      out.push(a);
    }
    out.sort((x, y) => y.e.seq - x.e.seq);
    return out.slice(0, limit);
  }, [arrived, initial, matches, limit]);

  if (rows.length === 0) {
    return (
      <div className={cn("py-6 text-xs text-fg-3", className)} data-testid="event-stream">
        {emptyText}
      </div>
    );
  }

  return (
    <ol className={cn("relative", className)} data-testid="event-stream" aria-label="Agent activity" aria-live={status === "live" ? "polite" : "off"} aria-relevant="additions">
      <AnimatePresence mode="popLayout" initial={false}>
        {rows.map(({ e, batch }) => {
          const href = hrefFor(e);
          const animate = batch > 0 && batch <= ANIMATE_MAX && !reduce;
          const sample = isSample(e.createdAt, sampleBefore);
          const body = (
            <>
              <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", LEVEL_DOT[e.level] ?? "bg-fg-3")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-[11px] uppercase tracking-[0.06em] text-fg-3">{agentName(e.agent)}</span>
                  {sample ? <SampleBadge className="h-4" /> : null}
                  <RelTime date={e.createdAt} compact className="ml-auto shrink-0 font-mono text-[11px] text-fg-3" />
                </span>
                <span className={cn("block text-[13px] leading-5 text-fg-2", dense ? "truncate" : "line-clamp-2")}>{cleanMessage(e.message)}</span>
              </span>
            </>
          );
          return (
            <motion.li
              key={e.id}
              initial={animate ? { height: 0, opacity: 0 } : false}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ height: { duration: 0.32, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.24, delay: 0.08 } }}
              data-testid="event-item"
              data-type={e.type}
              className="overflow-hidden rounded-sm"
            >
              {href ? (
                <Link href={href} className={cn("focus-inset flex gap-2.5 rounded-sm px-1.5 hover:bg-surface-1", dense ? "py-1.5" : "py-2", animate && "gp-arrival")}>
                  {body}
                </Link>
              ) : (
                <div className={cn("flex gap-2.5 px-1.5", dense ? "py-1.5" : "py-2", animate && "gp-arrival")}>{body}</div>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
