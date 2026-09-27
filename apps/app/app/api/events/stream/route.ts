import { getSessionContext } from "@gigpilot/auth";
import { subscribeTenant } from "@/lib/event-hub";
import { listEventsAfter, listLateEvents } from "@/lib/queries/events";
import { getLatestSeq } from "@/lib/queries/shell";
import { rateLimit } from "@/lib/rate-limit";
import { acquireStreamSlot } from "@/lib/stream-slots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
/** Safety net even when LISTEN works (missed notifications, other instances). */
const SAFETY_POLL_MS = 10_000;
/** Poll interval when LISTEN is unavailable. */
const FALLBACK_POLL_MS = 1_500;
/** Concurrent streams per user (tabs); more get 429. */
const MAX_STREAMS_PER_USER = 5;
/** Late-commit re-scan: seqs this far below the cursor, created in the last N seconds. */
const OVERLAP_SEQS = 500;
const OVERLAP_WINDOW_S = 60;
/** Per-connection de-duplication memory (event ids). */
const SEEN_MAX = 2_000;
const PAGE = 200;

/**
 * Server-Sent Events: tenant-scoped agent_event rows. Resumes from
 * Last-Event-ID (EventSource reconnects) or ?after=. Each drain streams
 * `seq > cursor` AND re-scans a recent overlap window for rows committed out
 * of seq order, de-duplicated by event id per connection. The frame `id:` is
 * the high-water seq, so Last-Event-ID never moves backwards.
 */
export async function GET(request: Request) {
  const ctx = await getSessionContext(request.headers);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  if (ctx.mustChangePassword) return new Response("Choose your password first", { status: 403 });
  const rl = rateLimit(`sse:${ctx.user.id}`, 30, 60_000);
  if (!rl.ok) return new Response("Too many connections", { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });
  if (request.signal.aborted) return new Response(null, { status: 499 });

  const url = new URL(request.url);
  const lastEventId = Number(request.headers.get("last-event-id") ?? NaN);
  const after = Number(url.searchParams.get("after") ?? NaN);
  const explicit = Number.isFinite(lastEventId) ? lastEventId : Number.isFinite(after) ? after : null;
  let cursor = explicit !== null ? Math.max(0, Math.trunc(explicit)) : await getLatestSeq(ctx.tenantId);
  const tenantId = ctx.tenantId;

  const slot = acquireStreamSlot(ctx.user.id, MAX_STREAMS_PER_USER);
  if (!slot) return new Response("Too many open live streams — close another GigPilot tab.", { status: 429, headers: { "Retry-After": "10" } });

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  let closed = false;
  let released = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  /** Idempotent: stops timers, drops the LISTEN subscription and frees the per-user slot. */
  const release = () => {
    closed = true;
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    if (poller) clearInterval(poller);
    heartbeat = poller = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    slot.release();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        release();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      const emit = (ev: { id: string; seq: number }) => {
        if (seen.has(ev.id)) return;
        remember(ev.id);
        cursor = Math.max(cursor, ev.seq);
        send(`id: ${cursor}\nevent: agent\ndata: ${JSON.stringify(ev)}\n\n`);
      };

      let draining = false;
      let again = false;
      const drain = async () => {
        if (closed) return;
        if (draining) {
          again = true;
          return;
        }
        draining = true;
        try {
          do {
            again = false;
            const base = cursor;
            const late = await listLateEvents(tenantId, base, { overlap: OVERLAP_SEQS, windowSeconds: OVERLAP_WINDOW_S });
            if (closed) return;
            for (const ev of late) emit(ev);
            const rows = await listEventsAfter(tenantId, base, PAGE);
            if (closed) return;
            for (const ev of rows) emit(ev);
            if (rows.length === PAGE) again = true;
          } while (again && !closed);
        } catch (err) {
          console.error(JSON.stringify({ level: "warn", msg: "sse drain failed", error: err instanceof Error ? err.message : String(err) }));
        } finally {
          draining = false;
        }
      };

      if (request.signal.aborted) return close();
      request.signal.addEventListener("abort", close, { once: true });

      send(`retry: 3000\n: connected ${new Date().toISOString()}\n\n`);
      let sub: Awaited<ReturnType<typeof subscribeTenant>>;
      try {
        sub = await subscribeTenant(tenantId, () => void drain());
      } catch {
        sub = { listening: false, unsubscribe: () => {} };
      }
      // The client may have gone away while we awaited: never leak the subscription or timers.
      if (closed) {
        sub.unsubscribe();
        return;
      }
      unsubscribe = sub.unsubscribe;
      poller = setInterval(() => void drain(), sub.listening ? SAFETY_POLL_MS : FALLBACK_POLL_MS);
      heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
      await drain();
    },
    cancel() {
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
