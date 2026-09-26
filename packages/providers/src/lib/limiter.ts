/**
 * Process-wide concurrency cap (e.g. GX slots) with priorities.
 *
 *  - `max` is read on every acquire so config changes apply without restart.
 *  - A released slot is handed directly to the next waiter, so the cap is
 *    never exceeded by a new caller racing a woken waiter.
 *  - Waiters are served highest `priority` first; equal priorities stay FIFO.
 *    (Owner-facing production work overtakes background refinement.)
 *  - `timeoutMs` bounds the wait: a caller that cannot get a slot in time gets
 *    a `SemaphoreTimeoutError` instead of queueing forever behind a brown-out.
 */

export class SemaphoreTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)} s waiting for a concurrency slot`);
    this.name = "SemaphoreTimeoutError";
  }
}

export interface AcquireOptions {
  /** Higher is served first (default 0). */
  priority?: number;
  /** Max wait in ms (default: unbounded). */
  timeoutMs?: number;
}

interface Waiter {
  priority: number;
  seq: number;
  wake: () => void;
}

export class Semaphore {
  private active = 0;
  private seq = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly maxFn: () => number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  private enqueue(w: Waiter): void {
    // Insert after every waiter with priority >= w.priority (stable → FIFO within a priority).
    let i = this.waiters.length;
    while (i > 0 && this.waiters[i - 1]!.priority < w.priority) i--;
    this.waiters.splice(i, 0, w);
  }

  async acquire(signal?: AbortSignal, opts: AcquireOptions = {}): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted while waiting for a concurrency slot");
    if (this.active < Math.max(1, this.maxFn()) && this.waiters.length === 0) {
      this.active++;
    } else {
      // Slot ownership is transferred by release(); `active` stays unchanged on hand-off.
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter: Waiter = {
          priority: opts.priority ?? 0,
          seq: this.seq++,
          wake: () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const remove = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
        };
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          remove();
          reject(new Error("aborted while waiting for a concurrency slot"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs)) {
          const ms = Math.max(0, opts.timeoutMs);
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            remove();
            reject(new SemaphoreTimeoutError(ms));
          }, ms);
          timer.unref?.();
        }
        this.enqueue(waiter);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.wake();
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, opts?: AcquireOptions): Promise<T> {
    const release = await this.acquire(signal, opts);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
