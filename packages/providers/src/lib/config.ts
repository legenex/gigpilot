import { envSchema, type Env } from "@gigpilot/config";

/**
 * Read one server setting per call (no process-wide cache) so tests and
 * long-running processes see env changes. Defaults come from the single
 * source of truth — `envSchema` in @gigpilot/config — never duplicated here.
 * An invalid value falls back to the schema default instead of throwing.
 */
export function setting<K extends keyof Env>(name: K): Env[K] {
  const field = envSchema.shape[name];
  const parsed = field.safeParse(process.env[name]);
  if (parsed.success) return parsed.data as Env[K];
  const fallback = field.safeParse(undefined);
  return (fallback.success ? fallback.data : undefined) as Env[K];
}

/** Trimmed env value or undefined (for secrets / names not in the schema). */
export function envValue(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Positive integer env var outside the shared schema (adapter tuning knobs). */
export function intEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function boolEnv(name: string, fallback = false): boolean {
  const raw = envValue(name);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
