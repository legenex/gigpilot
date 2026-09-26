/**
 * Minimal FIFO semaphore (process-wide concurrency caps, e.g. GX slots).
 * `max` is read on every acquire so config changes apply without restart.
 * A released slot is handed directly to the next waiter, so the cap is never
 * exceeded by a new caller racing a woken waiter.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly maxFn: () => number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted while waiting for a concurrency slot");
    if (this.active < Math.max(1, this.maxFn()) && this.waiters.length === 0) {
      this.active++;
    } else {
      // Slot ownership is transferred by release(); `active` stays unchanged on hand-off.
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("aborted while waiting for a concurrency slot"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
