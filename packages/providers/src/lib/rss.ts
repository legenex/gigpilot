import { decodeEntities } from "./text";

/**
 * Tiny dependency-free RSS 2.0 / Atom parser for official job feeds.
 * Handles CDATA (verbatim) and XML entities (decoded outside CDATA).
 * Not a general XML parser: it reads flat item/entry children, which is all
 * job feeds use. Input is size-capped by the fetcher; item count is capped here.
 */

export interface FeedItem {
  title: string;
  link?: string;
  guid?: string;
  published?: string;
  /** Raw (possibly HTML) description/content — convert with htmlToText before use. */
  description: string;
  categories: string[];
  /** Other simple child elements by local name (e.g. WWR `region`, `type`, `skills`). */
  fields: Record<string, string>;
}

/** Decode an element's inner XML: CDATA verbatim, entities decoded elsewhere. */
export function decodeXmlText(inner: string): string {
  let out = "";
  let idx = 0;
  for (;;) {
    const start = inner.indexOf("<![CDATA[", idx);
    if (start < 0) {
      out += decodeEntities(inner.slice(idx));
      break;
    }
    out += decodeEntities(inner.slice(idx, start));
    const end = inner.indexOf("]]>", start + 9);
    if (end < 0) {
      out += inner.slice(start + 9);
      break;
    }
    out += inner.slice(start + 9, end);
    idx = end + 3;
  }
  return out.trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split into blocks of <tag>…</tag> using indexOf (linear, CDATA-aware). */
function blocks(xml: string, tags: string[], max: number): string[] {
  const out: string[] = [];
  const openRe = new RegExp(`<(${tags.map(escapeRe).join("|")})(\\s[^<>]{0,2000})?>`, "gi");
  let m: RegExpExecArray | null;
  while (out.length < max && (m = openRe.exec(xml))) {
    const tag = m[1]!;
    const closeTag = `</${tag}>`;
    // Skip over CDATA sections when searching for the close tag.
    let pos = m.index + m[0].length;
    let end = -1;
    for (;;) {
      const close = xml.indexOf(closeTag, pos);
      const cdata = xml.indexOf("<![CDATA[", pos);
      if (close < 0) break;
      if (cdata >= 0 && cdata < close) {
        const cend = xml.indexOf("]]>", cdata + 9);
        if (cend < 0) break;
        pos = cend + 3;
        continue;
      }
      end = close;
      break;
    }
    if (end < 0) break;
    out.push(xml.slice(m.index + m[0].length, end));
    openRe.lastIndex = end + closeTag.length;
  }
  return out;
}

interface Child {
  name: string;
  attrs: string;
  inner: string;
}

/** Direct children of an item block (flat). */
function children(block: string): Child[] {
  const out: Child[] = [];
  const re = /<([A-Za-z_][\w.:-]{0,60})(\s[^<>]{0,2000}?)?(\/)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) && out.length < 200) {
    const name = m[1]!;
    const attrs = m[2] ?? "";
    if (m[3]) {
      out.push({ name, attrs, inner: "" });
      continue;
    }
    const closeTag = `</${name}>`;
    let pos = m.index + m[0].length;
    let end = -1;
    for (;;) {
      const close = block.indexOf(closeTag, pos);
      const cdata = block.indexOf("<![CDATA[", pos);
      if (close < 0) break;
      if (cdata >= 0 && cdata < close) {
        const cend = block.indexOf("]]>", cdata + 9);
        if (cend < 0) break;
        pos = cend + 3;
        continue;
      }
      end = close;
      break;
    }
    if (end < 0) {
      out.push({ name, attrs, inner: "" });
      continue;
    }
    out.push({ name, attrs, inner: block.slice(m.index + m[0].length, end) });
    re.lastIndex = end + closeTag.length;
  }
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${escapeRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const v = m?.[1] ?? m?.[2];
  return v === undefined ? undefined : decodeEntities(v);
}

function localName(name: string): string {
  const i = name.indexOf(":");
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

export function parseFeed(xml: string, maxItems = 200): FeedItem[] {
  const items: FeedItem[] = [];
  for (const block of blocks(xml, ["item", "entry"], maxItems)) {
    const item: FeedItem = { title: "", description: "", categories: [], fields: {} };
    let content = "";
    for (const c of children(block)) {
      const name = localName(c.name);
      const text = c.inner ? decodeXmlText(c.inner) : "";
      switch (name) {
        case "title":
          item.title = text;
          break;
        case "link": {
          const href = attr(c.attrs, "href");
          const rel = attr(c.attrs, "rel");
          if (href && (!rel || rel === "alternate")) item.link ??= href;
          else if (!href && text) item.link ??= text;
          break;
        }
        case "guid":
        case "id":
          item.guid ??= text;
          break;
        case "pubdate":
        case "published":
        case "updated":
        case "date":
          item.published ??= text;
          break;
        case "description":
        case "summary":
          item.description ||= text;
          break;
        case "encoded":
        case "content":
          content ||= text;
          break;
        case "category": {
          const term = attr(c.attrs, "term") ?? text;
          if (term) item.categories.push(term);
          break;
        }
        default:
          if (text && text.length <= 2000 && !(name in item.fields)) item.fields[name] = text;
      }
    }
    if (!item.description && content) item.description = content;
    if (item.published && !Number.isNaN(Date.parse(item.published))) item.published = new Date(item.published).toISOString();
    else item.published = undefined;
    if (item.title || item.link) items.push(item);
  }
  return items;
}
