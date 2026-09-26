import { describe, expect, it } from "vitest";
import { HttpError, assertPublicUrl, redactText, redactUrl, safeFetch } from "./http";
import { isBlockedHostname, isPrivateAddress } from "./ip";
import { hangingFetch, jsonResponse, lookupTo, mockFetch, publicLookup } from "./testing";

const noSleep = async () => {};

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "127.8.9.10", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.105.214.61", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"])(
    "blocks IPv4 %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["::1", "::", "fe80::1", "fd00::1234", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:0a00:0001::1", "2001:db8::1", "[::1]", "fe80::1%eth0"])(
    "blocks IPv6 %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
  it("treats garbage as private", () => expect(isPrivateAddress("not-an-ip")).toBe(true));
});

describe("isBlockedHostname", () => {
  it.each(["localhost", "foo.localhost", "metadata.google.internal", "gx-litellm", "postgres", "printer.local"])("blocks %s", (h) => expect(isBlockedHostname(h)).toBe(true));
  it.each(["weworkremotely.com", "api.x.ai"])("allows %s", (h) => expect(isBlockedHostname(h)).toBe(false));
});

describe("assertPublicUrl", () => {
  it("blocks loopback / private / metadata literals", async () => {
    for (const url of ["http://127.0.0.1/feed", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      await expect(assertPublicUrl(url)).rejects.toMatchObject({ code: "blocked" });
    }
  });
  it("blocks hostnames resolving to private addresses (any answer)", async () => {
    const mixed = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(assertPublicUrl("https://evil.example.com/rss", { lookup: mixed })).rejects.toMatchObject({ code: "blocked" });
    await expect(assertPublicUrl("https://evil.example.com/rss", { lookup: lookupTo("::1") })).rejects.toMatchObject({ code: "blocked" });
  });
  it("blocks bad schemes, credentials and non-standard ports", async () => {
    await expect(assertPublicUrl("ftp://example.com/x", { lookup: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    await expect(assertPublicUrl("file:///etc/passwd", { lookup: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    await expect(assertPublicUrl("https://user:pw@example.com/", { lookup: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    await expect(assertPublicUrl("http://example.com:8080/", { lookup: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    await expect(assertPublicUrl("http://example.com:8080/", { lookup: publicLookup, allowPorts: [80, 443, 8080] })).resolves.toBeTruthy();
  });
  it("allows public hosts", async () => {
    const r = await assertPublicUrl("https://example.com/feed.xml", { lookup: publicLookup });
    expect(r.addresses[0]!.address).toBe("93.184.216.34");
  });
});

describe("safeFetch", () => {
  it("blocks redirects to private addresses when guarded", async () => {
    const f = mockFetch(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:80/admin" } }));
    await expect(safeFetch("https://feeds.example.com/rss", {}, { ssrfGuard: true, fetch: f, lookup: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    expect(f.calls).toHaveLength(1);
  });

  it("blocks redirects to hostnames that resolve privately", async () => {
    const lookup = async (h: string) => (h === "internal.example.com" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
    const f = mockFetch(() => new Response(null, { status: 301, headers: { location: "https://internal.example.com/" } }));
    await expect(safeFetch("https://feeds.example.com/rss", {}, { ssrfGuard: true, fetch: f, lookup })).rejects.toMatchObject({ code: "blocked" });
  });

  it("follows at most maxRedirects and strips credentials on cross-origin hops", async () => {
    const f = mockFetch((url) => {
      if (url.hostname === "a.example.com") return new Response(null, { status: 302, headers: { location: "https://b.example.com/next" } });
      return jsonResponse({ ok: true });
    });
    const res = await safeFetch("https://a.example.com/start", { headers: { authorization: "Bearer secret-token-123" } }, { fetch: f });
    expect(res.json()).toEqual({ ok: true });
    expect(res.redirected).toBe(true);
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer secret-token-123");
    expect(f.calls[1]!.headers.get("authorization")).toBeNull();

    const loop = mockFetch((url) => new Response(null, { status: 302, headers: { location: `${url.origin}/again` } }));
    await expect(safeFetch("https://a.example.com/", {}, { fetch: loop, maxRedirects: 3 })).rejects.toMatchObject({ code: "redirect" });
    expect(loop.calls).toHaveLength(4);
  });

  it("enforces allowHosts on every hop", async () => {
    const f = mockFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.org/" } }));
    await expect(safeFetch("https://api.x.ai/v1/x", {}, { fetch: f, allowHosts: ["api.x.ai"] })).rejects.toMatchObject({ code: "blocked" });
    await expect(safeFetch("https://evil.example.org/", {}, { fetch: f, allowHosts: ["api.x.ai"] })).rejects.toMatchObject({ code: "blocked" });
  });

  it("times out hung requests", async () => {
    const f = hangingFetch();
    await expect(safeFetch("https://api.example.com/slow", {}, { fetch: f, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("retries idempotent requests on 503 but never POSTs by default", async () => {
    let n = 0;
    const f = mockFetch(() => (++n < 3 ? new Response("busy", { status: 503 }) : jsonResponse({ ok: 1 })));
    const res = await safeFetch("https://api.example.com/x", {}, { fetch: f, retries: 3, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(3);

    const p = mockFetch(() => new Response("busy", { status: 503 }));
    const res2 = await safeFetch("https://api.example.com/x", { method: "POST", body: "{}" }, { fetch: p, retries: 3, sleep: noSleep });
    expect(res2.status).toBe(503);
    expect(p.calls).toHaveLength(1);
  });

  it("caps response size", async () => {
    const big = new Uint8Array(2048);
    const f = mockFetch(() => new Response(big, { status: 200 }));
    await expect(safeFetch("https://api.example.com/big", {}, { fetch: f, maxBytes: 1024 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("reports invalid JSON clearly and redacts secrets", async () => {
    const f = mockFetch(() => new Response("<html>token=abc123secret Bearer sk-livekey-000000000</html>", { status: 502 }));
    const res = await safeFetch("https://api.example.com/x?api_key=zzz", {}, { fetch: f, redact: ["abc123secret"] });
    let err: unknown;
    try {
      res.json();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    const msg = (err as Error).message;
    expect(msg).toContain("invalid JSON");
    expect(msg).not.toContain("abc123secret");
    expect(msg).not.toContain("zzz");
    expect(msg).not.toContain("sk-livekey-000000000");
  });
});

describe("redaction", () => {
  it("scrubs auth headers, keys and query secrets", () => {
    const t = redactText('Authorization: Bearer abcdefghijkl, "authorization":"Key id123:sec456", Freelancer-OAuth-V1: tok999999, xai-ABCDEFGHIJKLMNOP, url?token=hunter2&x=1', ["tok999999"]);
    expect(t).not.toMatch(/abcdefghijkl|id123|sec456|tok999999|ABCDEFGHIJKLMNOP|hunter2/);
    expect(redactUrl("https://u:p@example.com/a?key=secret&q=ok")).toBe("https://example.com/a?key=[redacted]&q=ok");
  });
});
