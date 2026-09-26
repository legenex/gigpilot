/**
 * Sanitise a post-login `?next=` target (security review M1: no open
 * redirects). Only a same-origin, relative path is honoured; everything else
 * becomes "/". The value is resolved with the WHATWG URL parser (which strips
 * tabs/newlines and treats "\" like "/") against a dummy origin, so tricks
 * like "/\t/evil", "/\evil", "//evil", "https://evil" or their %-encoded
 * forms can never produce a cross-origin destination. Returns only
 * pathname + search + hash. API routes are never a destination.
 */
const DUMMY_ORIGIN = "http://gigpilot.invalid";
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\\]/;

export function safeNext(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return "/";
  if (UNSAFE.test(next)) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";

  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return "/";
  }
  if (UNSAFE.test(decoded) || decoded.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(next, DUMMY_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== DUMMY_ORIGIN || url.username || url.password) return "/";

  const out = `${url.pathname}${url.search}${url.hash}`;
  if (!out.startsWith("/") || out.startsWith("//")) return "/";
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return "/";
  }
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("//")) return "/";
  return out;
}
