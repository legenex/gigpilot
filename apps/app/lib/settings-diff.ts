/**
 * Minimal settings patch: only leaves that differ from the current settings.
 * Arrays and non-plain values are compared structurally and replaced whole.
 * Used so the settings command (and its audit record) sees only what the
 * owner actually changed, never a full copy of every setting.
 */
type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffSettings(current: unknown, next: unknown): Plain {
  const out: Plain = {};
  if (!isPlain(next)) return out;
  const cur = isPlain(current) ? current : {};
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    if (isPlain(v) && isPlain(cur[k])) {
      const sub = diffSettings(cur[k], v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (!same(cur[k], v)) {
      out[k] = v;
    }
  }
  return out;
}

/** Dotted key paths of a (diffed) patch — safe to log/audit (no values). */
export function changedPaths(patch: unknown, prefix = ""): string[] {
  if (!isPlain(patch)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v) && Object.keys(v).length) out.push(...changedPaths(v, p));
    else out.push(p);
  }
  return out;
}
