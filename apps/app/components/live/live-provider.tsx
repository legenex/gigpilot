"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { shouldRefresh, type LiveEvent } from "@/lib/live-types";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

interface LiveStore {
  subscribe: (fn: () => void) => () => void;
  getEvents: () => LiveEvent[];
  getStatus: () => LiveStatus;
}

const Ctx = createContext<LiveStore | null>(null);

const MAX_EVENTS = 200;
const REFRESH_DEBOUNCE_MS = 900;
const REFRESH_MIN_INTERVAL_MS = 2500;

/**
 * Consumes /api/events/stream (SSE). Keeps a bounded in-memory buffer of new
 * events for live streams and triggers a debounced router.refresh() when an
 * event affects the current page. Never polls; EventSource reconnects with
 * Last-Event-ID automatically. Refreshes pause while the tab is hidden.
 */
export function LiveProvider({ initialSeq, children }: { initialSeq: number; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const seedSeq = useRef(initialSeq);
  const eventsRef = useRef<LiveEvent[]>([]);
  const statusRef = useRef<LiveStatus>("connecting");
  const listeners = useRef(new Set<() => void>());
  const emit = useCallback(() => listeners.current.forEach((l) => l()), []);

  const store = useMemo<LiveStore>(
    () => ({
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      getEvents: () => eventsRef.current,
      getStatus: () => statusRef.current,
    }),
    [],
  );

  // Debounced, rate-limited refresh.
  const timer = useRef<number | null>(null);
  const lastRefresh = useRef(0);
  const dirty = useRef(false);
  const scheduleRefresh = useCallback(() => {
    if (document.hidden) {
      dirty.current = true;
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    const wait = Math.max(REFRESH_DEBOUNCE_MS, lastRefresh.current + REFRESH_MIN_INTERVAL_MS - Date.now());
    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastRefresh.current = Date.now();
      dirty.current = false;
      router.refresh();
    }, wait);
  }, [router]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && dirty.current) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [scheduleRefresh]);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: number | null = null;
    // The layout re-renders on every refresh with a newer max seq; only the
    // first value seeds the cursor so the stream is never torn down.
    let lastSeq = seedSeq.current;
    let failures = 0;

    const setStatus = (s: LiveStatus) => {
      if (statusRef.current !== s) {
        statusRef.current = s;
        emit();
      }
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/events/stream?after=${lastSeq}`);
      es.addEventListener("open", () => {
        failures = 0;
        setStatus("live");
      });
      es.addEventListener("agent", (msg) => {
        try {
          const ev = JSON.parse((msg as MessageEvent<string>).data) as LiveEvent;
          if (ev.seq <= lastSeq) return;
          lastSeq = ev.seq;
          eventsRef.current = [ev, ...eventsRef.current].slice(0, MAX_EVENTS);
          emit();
          if (shouldRefresh(pathRef.current, ev.type)) scheduleRefresh();
        } catch {
          /* ignore malformed frames */
        }
      });
      es.addEventListener("error", () => {
        // 401 or server gone: EventSource retries itself for network errors;
        // after repeated failures back off manually to avoid hammering.
        failures += 1;
        setStatus(failures > 3 ? "offline" : "reconnecting");
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
          retry = window.setTimeout(connect, delay);
        }
      });
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      es?.close();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [emit, scheduleRefresh]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

const EMPTY: LiveEvent[] = [];

export function useLiveEvents(): LiveEvent[] {
  const store = useContext(Ctx);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getEvents ?? (() => EMPTY),
    () => EMPTY,
  );
}

export function useLiveStatus(): LiveStatus {
  const store = useContext(Ctx);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getStatus ?? (() => "offline" as LiveStatus),
    () => "connecting" as LiveStatus,
  );
}

/** Ticks every `ms` while mounted — for live runtimes/ages. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
