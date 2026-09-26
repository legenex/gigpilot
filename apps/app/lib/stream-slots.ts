/**
 * Per-user concurrent-stream counter (per process). A slot must be released
 * exactly once; `release()` is idempotent.
 */
const g = globalThis as unknown as { __gigpilotStreamSlots?: Map<string, number> };
const slots = (g.__gigpilotStreamSlots ??= new Map<string, number>());

export function acquireStreamSlot(userId: string, max: number): { release: () => void } | null {
  const current = slots.get(userId) ?? 0;
  if (current >= max) return null;
  slots.set(userId, current + 1);
  let done = false;
  return {
    release: () => {
      if (done) return;
      done = true;
      const n = (slots.get(userId) ?? 1) - 1;
      if (n <= 0) slots.delete(userId);
      else slots.set(userId, n);
    },
  };
}

export function openStreamCount(userId: string): number {
  return slots.get(userId) ?? 0;
}
