import { z } from "zod";
import { slugify } from "../lib/util";

/**
 * Deterministic code-artifact generator — the mock-mode answer for the
 * `code` task. Produces a small but real TypeScript project (source, tests,
 * README, runbook, test report). The test report is explicitly marked as
 * simulated in mock mode; `npm test` in the package verifies it for real.
 */

export const codeArtifactSchema = z.object({
  summary: z.string().min(10),
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string() })).min(2).max(60),
  testReport: z.object({
    runner: z.string(),
    simulated: z.boolean().default(false),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    tests: z.array(z.object({ name: z.string(), status: z.enum(["passed", "failed", "skipped"]), durationMs: z.number().min(0).default(0), error: z.string().optional() })),
  }),
});
export type CodeArtifact = z.infer<typeof codeArtifactSchema>;

interface SystemInfo {
  key: string;
  name: string;
  entity: string;
  env: string;
}

const SYSTEMS: SystemInfo[] = [
  { key: "shopify", name: "Shopify", entity: "order", env: "SHOPIFY_ADMIN_TOKEN" },
  { key: "typeform", name: "Typeform", entity: "response", env: "TYPEFORM_TOKEN" },
  { key: "gmail", name: "Gmail", entity: "message", env: "GMAIL_OAUTH_TOKEN" },
  { key: "zendesk", name: "Zendesk", entity: "ticket", env: "ZENDESK_API_TOKEN" },
  { key: "notion", name: "Notion", entity: "page", env: "NOTION_TOKEN" },
  { key: "google drive", name: "Google Drive", entity: "document", env: "GOOGLE_SERVICE_ACCOUNT_JSON" },
  { key: "stripe", name: "Stripe", entity: "invoice", env: "STRIPE_SECRET_KEY" },
  { key: "hubspot", name: "HubSpot", entity: "deal", env: "HUBSPOT_PRIVATE_APP_TOKEN" },
  { key: "airtable", name: "Airtable", entity: "record", env: "AIRTABLE_PAT" },
  { key: "xero", name: "Xero", entity: "bill", env: "XERO_ACCESS_TOKEN" },
  { key: "google sheets", name: "Google Sheets", entity: "row", env: "GOOGLE_SERVICE_ACCOUNT_JSON" },
  { key: "slack", name: "Slack", entity: "message", env: "SLACK_WEBHOOK_URL" },
];

function detectSystems(text: string): { source: SystemInfo; target: SystemInfo } {
  const lower = text.toLowerCase();
  const found = SYSTEMS.map((s) => ({ s, at: lower.indexOf(s.key) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.s);
  const nonSlack = found.filter((s) => s.key !== "slack");
  const source = nonSlack[0] ?? { key: "source", name: "Source API", entity: "record", env: "SOURCE_API_TOKEN" };
  const target = nonSlack.find((s) => s.key !== source.key) ?? found.find((s) => s.key !== source.key) ?? { key: "target", name: "Target API", entity: "record", env: "TARGET_API_TOKEN" };
  return { source, target };
}

function camel(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toLowerCase());
}

function report(tests: { name: string; fail?: string }[], simulated: boolean): CodeArtifact["testReport"] {
  const rows = tests.map((t, i) => ({
    name: t.name,
    status: (t.fail ? "failed" : "passed") as "passed" | "failed",
    durationMs: 4 + ((i * 7) % 23),
    ...(t.fail ? { error: t.fail } : {}),
  }));
  return {
    runner: simulated ? "vitest (simulated run — mock mode; run `npm test` to verify)" : "vitest",
    simulated,
    passed: rows.filter((r) => r.status === "passed").length,
    failed: rows.filter((r) => r.status === "failed").length,
    tests: rows,
  };
}

function reportMarkdown(r: CodeArtifact["testReport"]): string {
  return [
    "# Test report",
    "",
    `Runner: ${r.runner}`,
    `Result: **NOT EXECUTED** — ${r.tests.length} tests written; no test runner executed them in GigPilot's environment. Status below is self-reported by the generator (unverified).`,
    "",
    "Run `npm install && npm test` to verify.",
    "",
    "| Test | Self-reported status |",
    "|---|---|",
    ...r.tests.map((t) => `| ${t.name} | ${t.status}${t.error ? ` — ${t.error}` : ""} (unverified) |`),
  ].join("\n");
}

export function generateAutomationArtifact(opts: { title: string; brief: string; defect: string | null; repairHint: string | null }): CodeArtifact {
  const { source, target } = detectSystems(`${opts.title} ${opts.brief}`);
  const pkg = slugify(`${source.name}-${target.name}-sync`);
  const n8n = /n8n/i.test(`${opts.title} ${opts.brief}`);
  const broken = opts.defect === "failing_test";
  const fn = camel(`map ${source.entity} to ${target.entity}`);

  const files: CodeArtifact["files"] = [
    {
      path: "README.md",
      content: [
        `# ${source.name} → ${target.name} sync`,
        "",
        `Built by GigPilot for: ${opts.title}`,
        "",
        "## What it does",
        `Listens for ${source.name} ${source.entity} events, maps them to ${target.name} ${target.entity}s, upserts idempotently (dedupe by normalised email / external id), retries rate limits with exponential backoff and dead-letters anything that still fails, with a Slack alert.`,
        "",
        "## Setup",
        "```bash",
        "cp .env.example .env   # fill in client-held credentials",
        "npm install",
        "npm test",
        "```",
        "",
        "## Environment",
        `- \`${source.env}\` — ${source.name} credential (client-owned)`,
        `- \`${target.env}\` — ${target.name} credential (client-owned)`,
        "- `SLACK_WEBHOOK_URL` — failure alerts",
        "- `MAX_RETRIES` — default 5",
        "",
        "## Operations",
        "- Dead-lettered events are written to `dead-letter/` with the payload and reason; replay with `npm run replay <id>`.",
        "- Every event is logged with its id for traceability.",
        n8n ? "- `n8n/workflow.json` contains the equivalent n8n workflow for the self-hosted instance." : "",
        "- `src/webhook.ts` receives the source webhooks (HMAC-verified) and feeds `processEvent`; failures alert Slack via `src/alerts.ts`.",
        "- See RUNBOOK.md for operations.",
      ].join("\n"),
    },
    {
      path: "RUNBOOK.md",
      content: [
        `# Runbook — ${source.name} → ${target.name} sync`,
        "",
        "## Deploy",
        "1. `cp .env.example .env` and fill in the client-held credentials (never commit `.env`).",
        "2. `npm install && npm test` (tests are delivered un-executed — run them before go-live).",
        `3. Register the webhook endpoint (\`POST /webhooks/${source.key.replace(/\s+/g, "-")}\`) in ${source.name} with the shared secret \`WEBHOOK_SECRET\`.`,
        "",
        "## Operate",
        "- Failures are retried with exponential backoff on 429/5xx, then dead-lettered to `dead-letter/` and alerted to Slack.",
        "- Replay a dead-lettered event: `npm run replay <id>`.",
        "",
        "## Handover checklist",
        "- [ ] Credentials rotated to client-owned keys",
        "- [ ] Slack alert channel confirmed",
        "- [ ] Tests executed in the client environment",
      ].join("\n"),
    },
    {
      path: "package.json",
      content: JSON.stringify(
        { name: pkg, version: "1.0.0", private: true, type: "module", scripts: { test: "vitest run", replay: "node dist/replay.js" }, devDependencies: { typescript: "^5.9.0", vitest: "^4.0.0" } },
        null,
        2,
      ),
    },
    { path: ".env.example", content: [`${source.env}=`, `${target.env}=`, "SLACK_WEBHOOK_URL=", "WEBHOOK_SECRET=", "MAX_RETRIES=5"].join("\n") },
    {
      path: "src/retry.ts",
      content: [
        "export interface RetryOptions { retries: number; baseMs: number; sleep?: (ms: number) => Promise<void> }",
        "",
        "export class HttpError extends Error {",
        "  constructor(public readonly status: number, message: string) { super(message); }",
        "}",
        "",
        "const retryable = (err: unknown) => err instanceof HttpError && (err.status === 429 || err.status >= 500);",
        "",
        "/** Exponential backoff with full jitter for rate limits and transient errors. */",
        "export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {",
        "  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));",
        broken ? "  const max = 0; // BUG: ignores opts.retries" : "  const max = Math.max(0, opts.retries);",
        "  for (let attempt = 0; ; attempt++) {",
        "    try {",
        "      return await fn();",
        "    } catch (err) {",
        "      if (!retryable(err) || attempt >= max) throw err;",
        "      await sleep(Math.random() * opts.baseMs * 2 ** attempt);",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      path: "src/mapping.ts",
      content: [
        `export interface ${camel(`source ${source.entity}`).replace(/^./, (c) => c.toUpperCase())} { id: string; email?: string | null; total?: string | number | null; created_at: string; test?: boolean }`,
        `export interface ${camel(`target ${target.entity}`).replace(/^./, (c) => c.toUpperCase())} { external_id: string; email: string | null; amount_cents: number; created_date: string }`,
        "",
        "export function dedupeKey(email: string | null | undefined, id: string): string {",
        "  const e = (email ?? '').trim().toLowerCase();",
        "  return e.length > 0 ? `email:${e}` : `id:${id}`;",
        "}",
        "",
        `export function ${fn}(src: ${camel(`source ${source.entity}`).replace(/^./, (c) => c.toUpperCase())}) {`,
        "  if (src.test) return null; // ignore test events",
        "  const amount = Number(src.total ?? 0);",
        "  return {",
        "    external_id: String(src.id),",
        "    email: src.email ? src.email.trim().toLowerCase() : null,",
        "    amount_cents: Math.round((Number.isFinite(amount) ? amount : 0) * 100),",
        "    created_date: new Date(src.created_at).toISOString(),",
        "  };",
        "}",
      ].join("\n"),
    },
    {
      path: "src/sync.ts",
      content: [
        `import { dedupeKey, ${fn} } from "./mapping";`,
        'import { withRetry } from "./retry";',
        "",
        "export interface SyncDeps {",
        "  upsert(key: string, payload: unknown): Promise<void>;",
        "  deadLetter(event: unknown, reason: string): Promise<void>;",
        "  alert(message: string): Promise<void>;",
        "  retries?: number;",
        "}",
        "",
        "export async function processEvent(event: Parameters<typeof " + fn + ">[0], deps: SyncDeps): Promise<'synced' | 'skipped' | 'dead-lettered'> {",
        `  const mapped = ${fn}(event);`,
        "  if (!mapped) return 'skipped';",
        "  try {",
        "    await withRetry(() => deps.upsert(dedupeKey(mapped.email, mapped.external_id), mapped), { retries: deps.retries ?? 5, baseMs: 250 });",
        "    return 'synced';",
        "  } catch (err) {",
        "    const reason = err instanceof Error ? err.message : String(err);",
        "    await deps.deadLetter(event, reason);",
        `    await deps.alert(\`${source.name} → ${target.name} sync failed for \${event.id}: \${reason}\`);`,
        "    return 'dead-lettered';",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      path: "src/webhook.ts",
      content: [
        'import { createHmac, timingSafeEqual } from "node:crypto";',
        'import { processEvent, type SyncDeps } from "./sync";',
        "",
        "/** Verify the HMAC-SHA256 signature the source sends with each webhook (hex, header value). */",
        "export function verifyWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {",
        '  if (!signature) return false;',
        '  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");',
        "  const a = Buffer.from(expected);",
        "  const b = Buffer.from(signature.replace(/^sha256=/, \"\"));",
        "  return a.length === b.length && timingSafeEqual(a, b);",
        "}",
        "",
        "/** Webhook handler: verify, parse, process (idempotent upsert + retry + dead-letter). */",
        "export async function handleWebhook(rawBody: string, signature: string | undefined, deps: SyncDeps & { secret: string }) {",
        "  if (!verifyWebhook(rawBody, signature, deps.secret)) return { status: 401 as const };",
        "  const event = JSON.parse(rawBody);",
        "  const result = await processEvent(event, deps);",
        "  return { status: 200 as const, result };",
        "}",
      ].join("\n"),
    },
    {
      path: "src/alerts.ts",
      content: [
        "/** Post a failure alert to the client's Slack incoming webhook (SLACK_WEBHOOK_URL). */",
        "export async function slackAlert(message: string, webhookUrl = process.env.SLACK_WEBHOOK_URL): Promise<void> {",
        "  if (!webhookUrl) return;",
        '  await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message }) });',
        "}",
      ].join("\n"),
    },
    {
      path: "test/sync.test.ts",
      content: [
        'import { describe, expect, it } from "vitest";',
        `import { dedupeKey, ${fn} } from "../src/mapping";`,
        'import { HttpError, withRetry } from "../src/retry";',
        'import { processEvent } from "../src/sync";',
        "",
        "const noSleep = async () => {};",
        "",
        `describe("${source.name} → ${target.name}", () => {`,
        `  it("maps a ${source.entity} to a ${target.entity}", () => {`,
        `    expect(${fn}({ id: "1", email: " A@B.com ", total: "12.5", created_at: "2026-01-01T00:00:00Z" })).toMatchObject({ email: "a@b.com", amount_cents: 1250 });`,
        "  });",
        '  it("dedupes by normalised email", () => { expect(dedupeKey(" X@Y.io ", "9")).toBe("email:x@y.io"); });',
        `  it("ignores test events", () => { expect(${fn}({ id: "2", created_at: "2026-01-01", test: true })).toBeNull(); });`,
        '  it("retries on 429 with backoff", async () => {',
        "    let calls = 0;",
        '    const out = await withRetry(async () => { calls++; if (calls < 3) throw new HttpError(429, "rate limited"); return "ok"; }, { retries: 5, baseMs: 1, sleep: noSleep });',
        '    expect(out).toBe("ok"); expect(calls).toBe(3);',
        "  });",
        '  it("dead-letters and alerts after the final failure", async () => {',
        "    const alerts: string[] = [];",
        '    const res = await processEvent({ id: "3", email: "c@d.com", created_at: "2026-01-01" }, { retries: 1, upsert: async () => { throw new HttpError(500, "down"); }, deadLetter: async () => {}, alert: async (m) => { alerts.push(m); } });',
        '    expect(res).toBe("dead-lettered"); expect(alerts).toHaveLength(1);',
        "  });",
        "});",
      ].join("\n"),
    },
  ];
  if (n8n) {
    files.push({
      path: "n8n/workflow.json",
      content: JSON.stringify(
        {
          name: `${source.name} → ${target.name} sync`,
          nodes: [
            { name: `${source.name} Trigger`, type: "n8n-nodes-base.webhook", parameters: { path: `${source.key.replace(/\s+/g, "-")}-events` } },
            { name: "Map fields", type: "n8n-nodes-base.code", parameters: { language: "javaScript" } },
            { name: `Upsert ${target.name}`, type: "n8n-nodes-base.httpRequest", parameters: { retryOnFail: true, maxTries: 5 } },
            { name: "Slack alert", type: "n8n-nodes-base.slack", parameters: {} },
          ],
          connections: {},
        },
        null,
        2,
      ),
    });
  }
  const testReport = report(
    [
      { name: `maps a ${source.entity} to a ${target.entity}` },
      { name: "dedupes by normalised email" },
      { name: "ignores test events" },
      { name: "retries on 429 with backoff", fail: broken ? "expected 3 calls, got 1 (withRetry ignores opts.retries)" : undefined },
      { name: "dead-letters and alerts after the final failure" },
    ],
    true,
  );
  files.push({ path: "TEST-REPORT.md", content: reportMarkdown(testReport) });
  return {
    summary: `${source.name} → ${target.name} sync: webhook intake, mapping, idempotent upsert, retry/backoff, dead-letter + Slack alerts; ${testReport.tests.length} tests written (not executed)${opts.repairHint ? " (repaired after QA)" : ""}`,
    files,
    testReport,
  };
}

export function generateWebArtifact(opts: { title: string; brief: string; clientName: string | null; defect: string | null; repairHint: string | null }): CodeArtifact {
  const broken = opts.defect === "failing_test";
  const brand = opts.clientName ?? "Client";
  const files: CodeArtifact["files"] = [
    {
      path: "README.md",
      content: [
        `# ${brand} — website`,
        "",
        `Built by GigPilot for: ${opts.title}`,
        "",
        "## Stack",
        "Next.js (App Router), TypeScript, Tailwind CSS. Blog content comes from the headless CMS (`lib/cms.ts`, set `CMS_API_URL` / `CMS_TOKEN`); `app/sitemap.ts` generates the sitemap.",
        "",
        "## Develop",
        "```bash",
        "npm install",
        "npm run dev",
        "npm test",
        "```",
        "",
        "## Deploy",
        "Any Node 22 host or Vercel. Set `CONTACT_WEBHOOK_URL` for form submissions.",
      ].join("\n"),
    },
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: slugify(`${brand}-site`),
          private: true,
          scripts: { dev: "next dev", build: "next build", test: "vitest run" },
          dependencies: { next: "^16.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
          devDependencies: { typescript: "^5.9.0", vitest: "^4.0.0", tailwindcss: "^4.0.0" },
        },
        null,
        2,
      ),
    },
    {
      path: "app/layout.tsx",
      content: [
        'import type { Metadata } from "next";',
        'import "./globals.css";',
        "",
        `export const metadata: Metadata = { title: "${brand}", description: "${brand} — official website" };`,
        "",
        "export default function RootLayout({ children }: { children: React.ReactNode }) {",
        '  return (<html lang="en"><body>{children}</body></html>);',
        "}",
      ].join("\n"),
    },
    {
      path: "app/page.tsx",
      content: [
        'import { Hero } from "@/components/Hero";',
        'import { Section } from "@/components/Section";',
        "",
        "export default function Home() {",
        "  return (",
        "    <main>",
        `      <Hero title="${brand}" subtitle="Work that moves the numbers you care about." cta="Book a call" />`,
        '      <Section title="What we do" items={["Strategy", "Delivery", "Support"]} />',
        '      <Section title="Proof" items={["Case study one", "Case study two", "Case study three"]} />',
        "    </main>",
        "  );",
        "}",
      ].join("\n"),
    },
    {
      path: "components/Hero.tsx",
      content: [
        "export function Hero({ title, subtitle, cta }: { title: string; subtitle: string; cta: string }) {",
        "  return (",
        '    <section className="mx-auto max-w-5xl px-6 py-24">',
        '      <h1 className="text-5xl font-bold tracking-tight">{title}</h1>',
        '      <p className="mt-4 text-lg text-neutral-600">{subtitle}</p>',
        '      <a href="/contact" className="mt-8 inline-block rounded-full bg-black px-6 py-3 text-white">{cta}</a>',
        "    </section>",
        "  );",
        "}",
      ].join("\n"),
    },
    {
      path: "lib/cms.ts",
      content: [
        "/** Minimal headless-CMS client (Sanity/Contentful-style REST). CMS_API_URL + CMS_TOKEN are client-held. */",
        "export interface Post { slug: string; title: string; excerpt: string; publishedAt: string }",
        "",
        "export async function listPosts(fetcher: typeof fetch = fetch): Promise<Post[]> {",
        "  const base = process.env.CMS_API_URL;",
        "  if (!base) return [];",
        '  const res = await fetcher(`${base.replace(/\\/+$/, "")}/posts`, { headers: { authorization: `Bearer ${process.env.CMS_TOKEN ?? ""}` }, next: { revalidate: 300 } } as RequestInit);',
        "  if (!res.ok) throw new Error(`CMS responded ${res.status}`);",
        "  return (await res.json()) as Post[];",
        "}",
      ].join("\n"),
    },
    {
      path: "app/blog/page.tsx",
      content: [
        'import { listPosts } from "@/lib/cms";',
        "",
        "export default async function Blog() {",
        "  const posts = await listPosts();",
        "  return (",
        '    <main className="mx-auto max-w-3xl px-6 py-16">',
        '      <h1 className="text-4xl font-bold">Blog</h1>',
        "      <ul>{posts.map((p) => (<li key={p.slug}><a href={`/blog/${p.slug}`}>{p.title}</a><p>{p.excerpt}</p></li>))}</ul>",
        "    </main>",
        "  );",
        "}",
      ].join("\n"),
    },
    {
      path: "app/sitemap.ts",
      content: [
        'import type { MetadataRoute } from "next";',
        'import { listPosts } from "@/lib/cms";',
        "",
        'const BASE = process.env.SITE_URL ?? "https://example.com";',
        'const PAGES = ["", "/about", "/services", "/blog", "/contact"];',
        "",
        "export default async function sitemap(): Promise<MetadataRoute.Sitemap> {",
        "  const posts = await listPosts().catch(() => []);",
        "  return [...PAGES.map((p) => ({ url: `${BASE}${p}` })), ...posts.map((p) => ({ url: `${BASE}/blog/${p.slug}`, lastModified: p.publishedAt }))];",
        "}",
      ].join("\n"),
    },
    {
      path: "components/Section.tsx",
      content: [
        "export function Section({ title, items }: { title: string; items: string[] }) {",
        '  return (<section className="mx-auto max-w-5xl px-6 py-16"><h2 className="text-3xl font-semibold">{title}</h2><ul className="mt-6 grid gap-4 sm:grid-cols-3">{items.map((i) => (<li key={i} className="rounded-xl border p-6">{i}</li>))}</ul></section>);',
        "}",
      ].join("\n"),
    },
    {
      path: "lib/contact.ts",
      content: [
        "export interface ContactInput { name: string; email: string; message: string; website?: string }",
        "",
        "/** Validates a contact submission; the hidden `website` field is a honeypot for bots. */",
        "export function validateContact(input: ContactInput): { ok: true } | { ok: false; reason: string } {",
        broken ? "  // BUG: honeypot check missing" : "  if (input.website && input.website.trim().length > 0) return { ok: false, reason: 'spam' };",
        "  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(input.email)) return { ok: false, reason: 'invalid email' };",
        "  if (input.message.trim().length < 10) return { ok: false, reason: 'message too short' };",
        "  return { ok: true };",
        "}",
      ].join("\n"),
    },
    {
      path: "test/contact.test.ts",
      content: [
        'import { describe, expect, it } from "vitest";',
        'import { validateContact } from "../lib/contact";',
        "",
        'describe("contact form", () => {',
        '  it("accepts a valid submission", () => { expect(validateContact({ name: "A", email: "a@b.co", message: "Hello there, let us talk" })).toEqual({ ok: true }); });',
        '  it("rejects invalid email", () => { expect(validateContact({ name: "A", email: "nope", message: "Hello there, let us talk" }).ok).toBe(false); });',
        '  it("blocks honeypot spam", () => { expect(validateContact({ name: "A", email: "a@b.co", message: "Hello there, let us talk", website: "http://spam" })).toEqual({ ok: false, reason: "spam" }); });',
        "});",
      ].join("\n"),
    },
  ];
  const testReport = report(
    [
      { name: "next build compiles" },
      { name: "accepts a valid submission" },
      { name: "rejects invalid email" },
      { name: "blocks honeypot spam", fail: broken ? "expected { ok: false, reason: 'spam' } but got { ok: true }" : undefined },
      { name: "Lighthouse performance ≥ 90 (home)" },
    ],
    true,
  );
  files.push({ path: "TEST-REPORT.md", content: reportMarkdown(testReport) });
  return {
    summary: `${brand} site: App Router pages, CMS-backed blog, sitemap, SEO metadata, contact validation with honeypot; ${testReport.tests.length} checks written (not executed)${opts.repairHint ? " (repaired after QA)" : ""}`,
    files,
    testReport,
  };
}
