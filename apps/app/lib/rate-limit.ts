/**
 * Tiny in-memory fixed-window rate limiter (per process). Sufficient for V1
 * single-instance deployments; swap for a shared store when scaling out.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const g = globalThis as unknown as { __gigpilotRate?: Map<string, Bucket> };
const buckets = (g.__gigpilotRate ??= new Map<string, Bucket>());

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return { ok: true, retryAfterMs: 0 };
  }
  b.count += 1;
  if (b.count > limit) return { ok: false, retryAfterMs: b.resetAt - now };
  return { ok: true, retryAfterMs: 0 };
}
