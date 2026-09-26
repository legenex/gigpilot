import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { opportunityAnalysisSchema } from "@gigpilot/contracts";
import { SHAREABLE_ENV_CREDENTIALS, clearCredentialCache, resolveCredential, resolveTenantOnlyCredential, setOperatorTenantCheck, setTenantSecretLookup } from "./credentials";
import { Semaphore } from "./limiter";
import { imageDimensions, sniffMime } from "./media";
import { extractJsonText, jsonSchemaFor, mergeSystemMessages, parseAndValidate, repairMessages } from "./structured";
import { PNG_1x1, setEnv } from "./testing";
import { decodeEntities, htmlToText } from "./text";

describe("structured output helpers", () => {
  it("extracts JSON from fences, think blocks and prose", () => {
    expect(JSON.parse(extractJsonText('```json\n{"a":1}\n```'))).toEqual({ a: 1 });
    expect(JSON.parse(extractJsonText('<think>hmm {"no":1}</think>\nHere you go: {"a":"}"} trailing'))).toEqual({ a: "}" });
    expect(JSON.parse(extractJsonText('reasoning...</think>{"b":[1,2]}'))).toEqual({ b: [1, 2] });
  });

  it("validates and summarises issues", () => {
    const schema = z.object({ n: z.number(), kind: z.enum(["a", "b"]) });
    expect(parseAndValidate(schema, '{"n":1,"kind":"a"}')).toEqual({ ok: true, data: { n: 1, kind: "a" } });
    const bad = parseAndValidate(schema, '{"n":"1","kind":"c"}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join("\n")).toMatch(/n:.*\n?.*kind/s);
    const notJson = parseAndValidate(schema, "sorry, I cannot");
    expect(notJson.ok).toBe(false);
  });

  it("derives a JSON schema with defaulted fields required (output io)", () => {
    const js = jsonSchemaFor(opportunityAnalysisSchema) as { required?: string[]; $schema?: string };
    expect(js.$schema).toBeUndefined();
    expect(js.required).toEqual(expect.arrayContaining(["summary", "productionEstimates", "proposedWorkflow", "fitScore"]));
  });

  it("merges system messages into one leading message and builds a repair turn", () => {
    const merged = mergeSystemMessages(
      [
        { role: "user", content: "u1" },
        { role: "system", content: "s1" },
      ],
      "extra",
    );
    expect(merged[0]).toEqual({ role: "system", content: "s1\n\nextra" });
    expect(merged[1]).toEqual({ role: "user", content: "u1" });
    const rep = repairMessages(merged, "{bad", ["x: required"], "Thing");
    expect(rep.at(-2)).toEqual({ role: "assistant", content: "{bad" });
    expect(rep.at(-1)!.content).toContain("x: required");
  });
});

describe("Semaphore", () => {
  it("never exceeds the cap, even when a new caller races a woken waiter", async () => {
    const sem = new Semaphore(() => 2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
    expect(sem.inFlight).toBe(0);
  });
});

describe("credentials — env fallback policy (H1)", () => {
  afterEach(() => {
    setTenantSecretLookup(null);
    setOperatorTenantCheck(null);
  });

  const PAID_AND_MARKETPLACE: [string, string][] = [
    ["factory", "FACTORY_API_KEY"],
    ["grok", "XAI_API_KEY"],
    ["kie", "KIE_API_KEY"],
    ["higgsfield", "HIGGSFIELD_API_KEY"],
    ["higgsfield", "HIGGSFIELD_API_SECRET"],
    ["freelancer", "FREELANCER_OAUTH_TOKEN"],
    ["upwork", "UPWORK_ACCESS_TOKEN"],
    ["upwork", "UPWORK_CLIENT_ID"],
  ];
  const envAll = () => setEnv(Object.fromEntries([...PAID_AND_MARKETPLACE.map(([, n]) => [n, `env-${n}`]), ["GX_API_KEY", "env-gx"]]));

  it("only the local GX gateway key is shareable", () => {
    expect([...SHAREABLE_ENV_CREDENTIALS]).toEqual(["GX_API_KEY"]);
  });

  it("prefers the tenant's own secret and caches ≤ 60 s", async () => {
    const restore = envAll();
    let calls = 0;
    setTenantSecretLookup(async (tenantId) => {
      calls++;
      return tenantId === "t1" ? "tenant-key" : undefined;
    });
    setOperatorTenantCheck(async () => false);
    expect(await resolveCredential("kie", "KIE_API_KEY", "t1")).toBe("tenant-key");
    expect(await resolveCredential("kie", "KIE_API_KEY", "t1")).toBe("tenant-key");
    expect(calls).toBe(1);
    clearCredentialCache("t1");
    await resolveCredential("kie", "KIE_API_KEY", "t1");
    expect(calls).toBe(2);
    restore();
  });

  it("never falls back to server env for marketplace or paid providers in a non-operator workspace", async () => {
    const restore = envAll();
    setTenantSecretLookup(async () => undefined);
    setOperatorTenantCheck(async () => false);
    for (const [provider, name] of PAID_AND_MARKETPLACE) {
      expect(await resolveCredential(provider, name, "tenant-x"), name).toBeUndefined();
    }
    restore();
  });

  it("shares the GX gateway key with every workspace", async () => {
    const restore = envAll();
    setTenantSecretLookup(async () => undefined);
    setOperatorTenantCheck(async () => false);
    expect(await resolveCredential("gx", "GX_API_KEY", "tenant-x")).toBe("env-gx");
    restore();
  });

  it("operator workspaces fall back to every server env credential", async () => {
    const restore = envAll();
    setTenantSecretLookup(async () => undefined);
    const checked: string[] = [];
    setOperatorTenantCheck(async (t) => {
      checked.push(t);
      return t === "op";
    });
    for (const [provider, name] of PAID_AND_MARKETPLACE) {
      expect(await resolveCredential(provider, name, "op"), name).toBe(`env-${name}`);
      expect(await resolveCredential(provider, name, "not-op"), name).toBeUndefined();
    }
    expect(checked).toContain("op");
    restore();
  });

  it("system context (no tenant) reads server env", async () => {
    const restore = envAll();
    setTenantSecretLookup(async () => {
      throw new Error("must not be called");
    });
    expect(await resolveCredential("kie", "KIE_API_KEY", null)).toBe("env-KIE_API_KEY");
    expect(await resolveCredential("kie", "KIE_API_KEY", undefined)).toBe("env-KIE_API_KEY");
    restore();
  });

  it("fails closed when the tenant store or the operator check fails (GX still shared)", async () => {
    const restore = envAll();
    setTenantSecretLookup(async () => {
      throw new Error("db down: connection string postgres://user:pw@host");
    });
    setOperatorTenantCheck(async () => true);
    expect(await resolveCredential("kie", "KIE_API_KEY", "t9")).toBeUndefined();
    expect(await resolveCredential("gx", "GX_API_KEY", "t9")).toBe("env-gx");
    setTenantSecretLookup(async () => undefined);
    setOperatorTenantCheck(async () => {
      throw new Error("db down");
    });
    expect(await resolveCredential("factory", "FACTORY_API_KEY", "t9")).toBeUndefined();
    restore();
  });

  it("resolveTenantOnlyCredential never returns the env value", async () => {
    const restore = setEnv({ INBOUND_WEBHOOK_SECRET: "env-inbound" });
    setTenantSecretLookup(async (t, p, n) => (t === "t1" && p === "inbound" && n === "INBOUND_WEBHOOK_SECRET" ? "tenant-inbound" : undefined));
    setOperatorTenantCheck(async () => true);
    expect(await resolveTenantOnlyCredential("inbound", "INBOUND_WEBHOOK_SECRET", "t1")).toBe("tenant-inbound");
    expect(await resolveTenantOnlyCredential("inbound", "INBOUND_WEBHOOK_SECRET", "t2")).toBeUndefined();
    expect(await resolveTenantOnlyCredential("inbound", "INBOUND_WEBHOOK_SECRET", null)).toBeUndefined();
    restore();
  });
});

describe("text + media", () => {
  it("converts HTML to text without retaining markup or scripts", () => {
    const html = '<div><h1>Title &amp; more</h1><script>alert("x")</script><style>p{}</style><p>Line one<br>Line&nbsp;two</p><ul><li>A</li><li>B</li></ul><!-- hidden --><img src=x onerror=alert(1)></div>';
    const t = htmlToText(html);
    expect(t).toContain("Title & more");
    expect(t).toContain("Line one\nLine two");
    expect(t).toContain("- A");
    expect(t).not.toMatch(/<|alert|hidden|onerror/);
  });

  it("stays linear on hostile input", () => {
    const hostile = "<".repeat(200_000) + "<a " .repeat(50_000);
    const t0 = Date.now();
    htmlToText(hostile);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("decodes entities", () => {
    expect(decodeEntities("&lt;b&gt; &#x27;x&#39; &euro;5 &bogus;")).toBe("<b> 'x' €5 &bogus;");
  });

  it("sniffs mime and dimensions", () => {
    expect(sniffMime(PNG_1x1)).toBe("image/png");
    expect(imageDimensions(PNG_1x1, "image/png")).toEqual({ width: 1, height: 1 });
    expect(sniffMime(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe("video/mp4");
  });
});
