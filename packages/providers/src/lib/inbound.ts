import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RawOpportunity } from "@gigpilot/contracts";
import { decodeEntities, extractHrefs, htmlToText, oneLine } from "./text";

/**
 * Inbound notification ingestion (Contra / Fiverr / Upwork / generic).
 *
 * Marketplaces without a permitted API reach GigPilot only through the
 * OWNER'S OWN notification emails, forwarded to GigPilot's inbound webhook
 * (or pasted manually). This module turns one such email into a best-effort
 * RawOpportunity. It never fetches anything, never follows links and never
 * retains HTML (bodies are converted to plain text).
 *
 * Webhook authenticity: `verifyInboundSignature(body, header, secret)` —
 * HMAC-SHA256 over the raw request body, hex, timing-safe compare, using
 * INBOUND_WEBHOOK_SECRET. Accepts "sha256=<hex>" or bare "<hex>".
 */

export type InboundProvider = "contra" | "fiverr" | "upwork" | "generic";

export interface InboundNotification {
  provider: InboundProvider;
  subject?: string;
  text?: string;
  html?: string;
  /** Sender address (stored as-is in raw for audit; no display name). */
  from?: string;
  receivedAt?: string;
  /** Override the RawOpportunity.sourceKey (default: provider, or "direct" for generic). */
  sourceKey?: string;
}

const LINK_PATTERNS: Record<InboundProvider, RegExp[]> = {
  upwork: [/^https:\/\/(?:www\.)?upwork\.com\/(?:jobs|freelance-jobs|ab\/proposals\/job|nx\/proposals\/job)\/[^\s]+/i],
  contra: [/^https:\/\/(?:www\.)?contra\.com\/(?:opportunity|opportunities|project|projects|job|jobs|p)\/[^\s]+/i, /^https:\/\/(?:www\.)?contra\.com\/[^\s]+/i],
  fiverr: [/^https:\/\/(?:www\.)?fiverr\.com\/(?:briefs|brief|requests|inbox|users\/[^/]+\/requests)[^\s]*/i, /^https:\/\/(?:www\.)?fiverr\.com\/[^\s]+/i],
  generic: [],
};

const NOISE_LINK = /unsubscribe|notification[-_]?settings|preferences|privacy|terms|help|support|mailto:|\/login|\/signin|app-store|play\.google|facebook\.com|twitter\.com|x\.com\/|linkedin\.com|instagram\.com|\.(png|jpe?g|gif|svg)(\?|$)/i;
const NOT_AN_OPPORTUNITY = /password|verify your (email|account)|verification code|security (alert|code)|sign[- ]in|log[- ]?in attempt|receipt|invoice|payment (received|sent|processed)|withdrawal|payout|your order|order #|newsletter|weekly digest|welcome to/i;
const FOOTER = /^(unsubscribe|you (are )?receiv|manage (your )?(email|notification)|this (e-?mail|message) was sent|©|copyright|privacy policy|download the app|sent from my)/i;

function cleanUrl(u: string): string {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|mc_|ref$|source$|_hs|trk)/i.test(k)) url.searchParams.delete(k);
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

function pickLink(provider: InboundProvider, hrefs: string[], text: string): string | undefined {
  const textUrls = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const all = [...hrefs, ...textUrls].map((u) => decodeEntities(u).replace(/[.,;:!?]+$/, ""));
  for (const re of LINK_PATTERNS[provider]) {
    const hit = all.find((u) => re.test(u) && !NOISE_LINK.test(u));
    if (hit) return cleanUrl(hit);
  }
  const generic = all.find((u) => /^https:\/\//i.test(u) && !NOISE_LINK.test(u));
  return generic ? cleanUrl(generic) : undefined;
}

function cleanSubject(subject: string): string {
  let s = subject;
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/^\s*(?:re|fwd?|fw)\s*:\s*/i, "")
      .replace(/^\s*\[[^\]]{1,40}\]\s*/, "")
      .replace(/^\s*(?:new (?:job|opportunity|project|brief|request|lead)s?(?: posted| alert| match(?:es)?)?|job alert|upwork|contra|fiverr)\s*[:\-–—|]\s*/i, "");
  }
  return oneLine(s, 200);
}

function labelled(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:\\-–]\\s*([^\\n]{2,200})`, "i");
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

export interface ParsedBudget {
  type: RawOpportunity["budgetType"];
  min?: number;
  max?: number;
  currency?: string;
}

const CURRENCY_SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

/** Extract a budget like "$500", "USD 1,200", "$20-$40/hr", "$30 - $50 per hour". */
export function parseBudget(text: string): ParsedBudget {
  const num = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k)?`;
  const cur = String.raw`(US\$|\$|USD|€|EUR|£|GBP)`;
  const re = new RegExp(String.raw`${cur}\s?${num}(?:\s*(?:-|–|—|to)\s*${cur}?\s?${num})?(\s*(?:\/\s*h(?:ou)?r|per\s+hour|an\s+hour|hourly|\/\s*hour))?`, "i");
  const m = re.exec(text);
  const hourlyContext = /\bhourly\b|per hour|\/\s*hr\b/i.test(text);
  if (!m) return { type: hourlyContext ? "hourly" : /fixed[- ]price|fixed budget/i.test(text) ? "fixed" : "unknown" };
  const toNum = (int?: string, dec?: string, k?: string) => {
    if (!int) return undefined;
    const n = Number(int.replace(/,/g, "") + (dec ? `.${dec}` : ""));
    return k ? n * 1000 : n;
  };
  const symbol = (m[1] ?? "").toUpperCase();
  const currency = symbol === "US$" ? "USD" : (CURRENCY_SYMBOL[m[1] ?? ""] ?? symbol);
  const min = toNum(m[2], m[3], m[4]);
  const max = toNum(m[6], m[7], m[8]) ?? min;
  const hourly = Boolean(m[9]) || (hourlyContext && (min ?? 0) < 300);
  return { type: hourly ? "hourly" : "fixed", min, max, currency };
}

function stableId(provider: string, parts: (string | undefined)[]): string {
  return createHash("sha256").update([provider, ...parts.map((p) => p ?? "")].join("\u0000")).digest("hex").slice(0, 24);
}

function idFromLink(provider: InboundProvider, link?: string): string | undefined {
  if (!link) return undefined;
  if (provider === "upwork") {
    const m = /(~0[0-9a-z]{10,})/i.exec(link) ?? /_(~?[0-9a-z]{12,})\/?(?:\?|$)/i.exec(link);
    if (m?.[1]) return m[1];
  }
  try {
    const u = new URL(link);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && last.length >= 6 && last.length <= 120) return `${u.hostname.replace(/^www\./, "")}:${last}`;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Best-effort extraction of one opportunity from a forwarded notification
 * email. Returns null when the message does not look like an opportunity.
 */
export function parseInboundNotification(n: InboundNotification): RawOpportunity | null {
  const subject = (n.subject ?? "").slice(0, 500);
  const hrefs = n.html ? extractHrefs(n.html.slice(0, 1_000_000)) : [];
  const bodyRaw = n.text?.trim() ? n.text : n.html ? htmlToText(n.html) : "";
  const body = bodyRaw.replace(/\r\n?/g, "\n").slice(0, 60_000);
  if (NOT_AN_OPPORTUNITY.test(subject)) return null;
  if (!subject.trim() && body.trim().length < 40) return null;

  // Description: drop quoted-forward headers and footers.
  const lines = body.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (FOOTER.test(t)) break;
    if (/^(from|sent|to|date|subject|cc)\s*:/i.test(t) && kept.length < 8) continue;
    if (/^-{2,}\s*forwarded message\s*-{2,}$/i.test(t)) continue;
    kept.push(line);
  }
  const description = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);

  const title = oneLine(labelled(body, ["job title", "project title", "title", "brief", "project", "job"]) ?? cleanSubject(subject) ?? "", 200) || oneLine(description.split("\n")[0] ?? "", 200);
  if (!title || (description.length < 20 && !labelled(body, ["budget"]))) return null;

  const link = pickLink(n.provider, hrefs, body);
  const budget = parseBudget(labelled(body, ["budget", "hourly range", "hourly rate", "fixed[- ]price", "price", "rate"]) ?? `${subject}\n${body.slice(0, 4000)}`);
  const isUsd = budget.currency === "USD";
  const skillsLine = labelled(body, ["skills", "skills required", "tags", "expertise"]);
  const skills = skillsLine
    ?.split(/[,;|•·]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 20);
  const country = labelled(body, ["client location", "location", "country"]);
  const sourceKey = n.sourceKey ?? (n.provider === "generic" ? "direct" : n.provider);
  const fromAddress = n.from ? (/<([^<>@\s]+@[^<>\s]+)>/.exec(n.from)?.[1] ?? n.from.trim()).slice(0, 200) : undefined;

  return {
    sourceKey,
    externalId: idFromLink(n.provider, link) ?? stableId(n.provider, [title, link, description.slice(0, 500)]),
    url: link,
    title,
    description: description || title,
    clientCountry: country ? oneLine(country, 80) : undefined,
    budgetType: budget.type,
    budgetMinUsd: isUsd ? budget.min : undefined,
    budgetMaxUsd: isUsd ? budget.max : undefined,
    currency: budget.currency,
    skills: skills?.length ? skills : undefined,
    postedAt: n.receivedAt && !Number.isNaN(Date.parse(n.receivedAt)) ? new Date(n.receivedAt).toISOString() : undefined,
    raw: {
      ingestion: "email",
      provider: n.provider,
      subject: oneLine(subject, 300),
      from: fromAddress,
      ...(budget.min !== undefined && !isUsd ? { budgetOriginal: { min: budget.min, max: budget.max, currency: budget.currency } } : {}),
    },
  };
}

/**
 * Verify an inbound webhook: header = hex(HMAC-SHA256(rawBody, secret)),
 * optionally prefixed "sha256=". Timing-safe. False when the secret is unset.
 */
export function verifyInboundSignature(body: string | Uint8Array, signatureHeader: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !signatureHeader) return false;
  const provided = signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body)).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

/** Sign a body (for tests and for configuring email-forwarding relays). */
export function signInboundBody(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body)).digest("hex")}`;
}
