import { getSessionContext } from "@gigpilot/auth";
import { subscribeTenant } from "@/lib/event-hub";
import { listEventsAfter } from "@/lib/queries/events";
import { getLatestSeq } from "@/lib/queries/shell";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
/** Safety net even when LISTEN works (missed notifications, other instances). */
const SAFETY_POLL_MS = 10_000;
/** Poll interval when LISTEN is unavailable. */
const FALLBACK_POLL_MS = 1_500;

/**
 * Server-Sent Events: tenant-scoped agent_event rows streamed by `seq`
 * cursor. Resumes from Last-Event-ID (EventSource reconnects) or ?after=.
 */
export async function GET(request: Request) {
  const ctx = await getSessionContext(request.headers);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const rl = rateLimit(`sse:${ctx.user.id}`, 30, 60_000);
  if (!rl.ok) return new Response("Too many connections", { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });

  const url = new URL(request.url);
  const lastEventId = Number(request.headers.get("last-event-id") ?? NaN);
  const after = Number(url.searchParams.get("after") ?? NaN);
  let cursor = Number.isFinite(lastEventId) ? lastEventId : Number.isFinite(after) ? after : await getLatestSeq(ctx.tenantId);
  const tenantId = ctx.tenantId;
  const encoder = new TextEncoder();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
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
            const rows = await listEventsAfter(tenantId, cursor, 200);
            for (const ev of rows) {
              cursor = ev.seq;
              send(`id: ${ev.seq}\nevent: agent\ndata: ${JSON.stringify(ev)}\n\n`);
            }
            if (rows.length === 200) again = true;
          } while (again && !closed);
        } catch (err) {
          console.error(JSON.stringify({ level: "warn", msg: "sse drain failed", error: err instanceof Error ? err.message : String(err) }));
        } finally {
          draining = false;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (poller) clearInterval(poller);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener("abort", cleanup);

      send(`retry: 3000\n: connected ${new Date().toISOString()}\n\n`);
      const sub = await subscribeTenant(tenantId, () => void drain());
      unsubscribe = sub.unsubscribe;
      poller = setInterval(() => void drain(), sub.listening ? SAFETY_POLL_MS : FALLBACK_POLL_MS);
      heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
      await drain();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (poller) clearInterval(poller);
      unsubscribe?.();
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
