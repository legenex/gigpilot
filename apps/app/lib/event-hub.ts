import "server-only";
import { EVENTS_CHANNEL, getSql } from "@gigpilot/db";

/**
 * Process-wide LISTEN hub. One dedicated Postgres connection listens on
 * `gigpilot_events` (payload = tenantId) and wakes the SSE subscribers of
 * that tenant. If LISTEN is unavailable the stream falls back to polling.
 */
type Waker = () => void;

interface HubState {
  subs: Map<string, Set<Waker>>;
  listening: boolean;
  starting?: Promise<void>;
  failedAt?: number;
}

const g = globalThis as unknown as { __gigpilotEventHub?: HubState };
const hub: HubState = (g.__gigpilotEventHub ??= { subs: new Map(), listening: false });

async function ensureListening(): Promise<void> {
  if (hub.listening) return;
  if (hub.failedAt && Date.now() - hub.failedAt < 30_000) return;
  if (!hub.starting) {
    hub.starting = getSql()
      .listen(
        EVENTS_CHANNEL,
        (payload) => {
          const set = hub.subs.get(payload);
          if (set) for (const wake of set) wake();
        },
        () => {
          hub.listening = true;
        },
      )
      .then(() => {
        hub.listening = true;
      })
      .catch((err: unknown) => {
        hub.failedAt = Date.now();
        console.error(JSON.stringify({ level: "warn", msg: "event hub LISTEN failed; SSE falls back to polling", error: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => {
        hub.starting = undefined;
      });
  }
  await hub.starting;
}

export async function subscribeTenant(tenantId: string, wake: Waker): Promise<{ unsubscribe: () => void; listening: boolean }> {
  await ensureListening();
  let set = hub.subs.get(tenantId);
  if (!set) {
    set = new Set();
    hub.subs.set(tenantId, set);
  }
  set.add(wake);
  return {
    listening: hub.listening,
    unsubscribe: () => {
      const s = hub.subs.get(tenantId);
      if (!s) return;
      s.delete(wake);
      if (s.size === 0) hub.subs.delete(tenantId);
    },
  };
}
