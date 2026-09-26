/**
 * Dependency-free text utilities: HTML → plain text (no markup retained) and
 * entity decoding. Output is TEXT ONLY and must never be rendered as HTML.
 * All regexes are linear (no nested quantifiers) to avoid ReDoS on hostile input.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  laquo: "«",
  raquo: "»",
  shy: "",
  zwnj: "",
  zwj: "",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return "";
      return String.fromCodePoint(code);
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function dropBlock(html: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^<>]{0,2000}>`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "i");
  let out = "";
  let idx = 0;
  for (;;) {
    open.lastIndex = idx;
    const m = open.exec(html);
    if (!m) {
      out += html.slice(idx);
      return out;
    }
    out += html.slice(idx, m.index);
    const rest = html.slice(m.index + m[0].length);
    const c = close.exec(rest);
    if (!c) return out; // unterminated block → drop the remainder
    idx = m.index + m[0].length + c.index + c[0].length;
  }
}

function dropComments(html: string): string {
  let out = "";
  let idx = 0;
  for (;;) {
    const start = html.indexOf("<!--", idx);
    if (start < 0) return out + html.slice(idx);
    out += html.slice(idx, start) + " ";
    const end = html.indexOf("-->", start + 4);
    if (end < 0) return out;
    idx = end + 3;
  }
}

/** Extract absolute http(s) hrefs from HTML (before tags are stripped). */
export function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^<>]{0,2000}?\bhref\s*=\s*(?:"([^"<>]{0,4000})"|'([^'<>]{0,4000})'|([^\s<>]{1,4000}))/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (/^https?:\/\//i.test(href)) out.push(href);
    if (out.length >= 200) break;
  }
  return out;
}

/** Convert HTML to readable plain text. No markup survives. */
export function htmlToText(html: string, maxLength = 50_000): string {
  let s = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  s = dropComments(s);
  for (const tag of ["script", "style", "head", "noscript", "template", "svg", "iframe", "object"]) s = dropBlock(s, tag);
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^<>]{0,2000}>/gi, "\n- ")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|section|article|blockquote|pre)\s*>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|table|ul|ol|section|article|blockquote|pre)\b[^<>]{0,2000}>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^<>]{0,5000}>/g, "")
    .replace(/</g, " "); // stray "<" from malformed tags
  s = decodeEntities(s);
  s = s
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
}

/** Collapse whitespace to one line. */
export function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
