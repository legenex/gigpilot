import { createHash } from "node:crypto";
import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";
import { parseBudget } from "../lib/inbound";
import { oneLine } from "../lib/text";

/**
 * Direct outbound — prospects the owner adds manually or imports from CSV.
 * Always connected; nothing is fetched and nothing is submitted (outreach is
 * drafted for the owner, who sends it). `parseDirectProspectsCsv` turns a CSV
 * export into RawOpportunity rows for the dashboard's import route.
 *
 * Credentials: none.
 */
export class DirectSource implements SourceAdapter {
  readonly key = "direct";
  readonly name = "Direct outbound";
  readonly capabilities: SourceCapabilities = {
    canSearch: false,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "manual",
    backgroundPollingAllowed: false,
    minPollIntervalMinutes: 0,
    maxCacheTtlHours: null,
    compliance: "Prospects you add or import yourself. GigPilot analyses them and drafts outreach for you to review and send — it never contacts anyone on its own.",
  };

  withTenant(_tenantId: string | null): DirectSource {
    return this;
  }

  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    return { status: "connected", detail: "Manual and CSV-imported prospects — always available.", checkedAt: new Date().toISOString(), meta: { ingestion: ["manual", "csv"] } };
  }

  async fetchOpportunities(_opts: { tenantId: string; query?: string; limit?: number; since?: Date }): Promise<RawOpportunity[]> {
    return [];
  }
}

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string, maxRows = 5000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows + 1) return rows;
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, string[]> = {
  title: ["title", "project", "name", "opportunity", "job", "job title"],
  description: ["description", "details", "brief", "notes", "summary"],
  url: ["url", "link", "website"],
  client: ["client", "company", "client name", "organisation", "organization", "contact"],
  country: ["country", "location", "client country"],
  budget: ["budget", "price", "value"],
  budgetMin: ["budget min", "budget_min", "min budget", "min"],
  budgetMax: ["budget max", "budget_max", "max budget", "max"],
  budgetType: ["budget type", "budget_type", "type", "pricing"],
  skills: ["skills", "tags", "services"],
  deadline: ["deadline", "due", "due date"],
  id: ["id", "external id", "external_id", "ref"],
};

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Convert a prospects CSV (header row required) into RawOpportunity rows. */
export function parseDirectProspectsCsv(csv: string, opts: { maxRows?: number } = {}): { opportunities: RawOpportunity[]; skipped: number } {
  const rows = parseCsv(csv, opts.maxRows ?? 2000);
  if (rows.length < 2) return { opportunities: [], skipped: 0 };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (field: string) => header.findIndex((h) => HEADER_ALIASES[field]!.includes(h));
  const idx = Object.fromEntries(Object.keys(HEADER_ALIASES).map((k) => [k, col(k)])) as Record<string, number>;
  const out: RawOpportunity[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const get = (k: string) => (idx[k]! >= 0 ? (r[idx[k]!] ?? "").trim() : undefined) || undefined;
    const title = get("title");
    if (!title) {
      skipped++;
      continue;
    }
    const url = get("url");
    const budgetText = get("budget");
    const parsed = budgetText ? parseBudget(/[$€£]|usd|eur|gbp/i.test(budgetText) ? budgetText : `$${budgetText}`) : undefined;
    const typeRaw = (get("budgetType") ?? "").toLowerCase();
    const budgetType: RawOpportunity["budgetType"] = typeRaw.startsWith("hour") ? "hourly" : typeRaw.startsWith("fix") ? "fixed" : (parsed?.type ?? "unknown");
    const usd = !parsed || parsed.currency === "USD";
    const deadline = get("deadline");
    out.push({
      sourceKey: "direct",
      externalId: get("id") ?? `csv:${createHash("sha256").update(`${title}\u0000${url ?? ""}\u0000${get("client") ?? ""}`).digest("hex").slice(0, 24)}`,
      url: url && /^https?:\/\//i.test(url) ? url : undefined,
      title: oneLine(title, 300),
      description: (get("description") ?? title).slice(0, 20_000),
      clientName: get("client"),
      clientCountry: get("country"),
      budgetType,
      budgetMinUsd: num(get("budgetMin")) ?? (usd ? parsed?.min : undefined),
      budgetMaxUsd: num(get("budgetMax")) ?? (usd ? parsed?.max : undefined),
      currency: parsed?.currency ?? "USD",
      skills: get("skills")
        ?.split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20),
      deadlineAt: deadline && !Number.isNaN(Date.parse(deadline)) ? new Date(deadline).toISOString() : undefined,
      raw: { ingestion: "csv" },
    });
  }
  return { opportunities: out, skipped };
}
