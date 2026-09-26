import "./testing/setup";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asset, closeDb, dedupeHashFor, delivery, desc, eq, getDb, job, opportunity, proposal, qaReview, repair, workflowStep } from "./testing/db";
import { getStorage } from "@gigpilot/providers";
import { approveOpportunity, approveProposal } from "./commands";
import { handlers } from "./handlers";
import { captureCommandQueue, createTestTenant, drain, migrateTestDb, resetDb, testDeps, type TestTenant } from "./testing/harness";

interface Brief {
  family: string;
  title: string;
  description: string;
  budgetMinUsd: number;
  budgetMaxUsd: number;
  budgetType?: "fixed" | "hourly";
  expectDefect: string;
}

const BRIEFS: Brief[] = [
  {
    family: "ai-automation",
    title: "Shopify → HubSpot order & customer sync in n8n",
    description:
      "We need a reliable Shopify → HubSpot sync built in our self-hosted n8n. Sync orders, customers and line items to HubSpot contacts and deals in near real time. " +
      "Requirements: webhook triggers, dedupe contacts by email, retry with backoff on 429s, Slack alert on failures, README + runbook. Access to a staging store and HubSpot sandbox provided. Deliver in 10 days.",
    budgetMinUsd: 2400,
    budgetMaxUsd: 2400,
    expectDefect: "failing_tests",
  },
  {
    family: "web-app-builds",
    title: "Next.js marketing website for a climate-tech startup (8 pages + CMS)",
    description:
      "We need a fast, accessible Next.js website: 8 pages (home, about, services, 3 case studies, blog, contact) with a headless CMS for the blog. Figma designs are ready. " +
      "Must score 90+ on Lighthouse, include SEO metadata, sitemap and a contact form with spam protection. Launch in 18 days.",
    budgetMinUsd: 3500,
    budgetMaxUsd: 4500,
    expectDefect: "failing_tests",
  },
  {
    family: "image-design",
    title: "25 product images: white-background cleanup + lifestyle composites",
    description:
      "We sell ceramic homeware on Shopify and need 25 product images: white-background cleanup for 15 SKUs plus 10 lifestyle composites. " +
      "Output: 2048×2048 PNG/JPG, consistent soft shadows, colour-accurate. We supply the raw photos (RAW + JPG) and 5 mood references. Deadline 7 days.",
    budgetMinUsd: 800,
    budgetMaxUsd: 900,
    expectDefect: "aspect_ratio",
  },
  {
    family: "paid-social-ugc",
    title: "24 static ad creatives for our spring bundle offer (1:1 and 4:5)",
    description:
      "Need 24 static ad creatives for Meta (1:1 and 4:5) for our spring bundle campaign: 4 angles × 6 variants. We provide logo, brand fonts and 12 product photos. " +
      "Headline + primary text suggestions per variant. Figma source preferred. Deadline: 7 days.",
    budgetMinUsd: 900,
    budgetMaxUsd: 1200,
    expectDefect: "aspect_ratio",
  },
  {
    family: "localization-repurposing",
    title: "Localise 10 product tutorial videos into Spanish, German and French (subtitles)",
    description:
      "We have 10 product tutorial videos (avg 90s each) in English. Need SRT subtitles in Spanish, German and French plus burned-in MP4 versions. " +
      "We provide English transcripts, the Premiere projects and a glossary of 40 brand terms. Reading speed ≤ 17 cps. Deadline 10 days.",
    budgetMinUsd: 1200,
    budgetMaxUsd: 1500,
    expectDefect: "srt_timing",
  },
  {
    family: "research-content",
    title: "Market research: DTC pet food competitor landscape (15 brands)",
    description:
      "We need a competitor landscape of 15 DTC pet food brands: positioning, pricing tiers, channels, ad angles, review themes and estimated traffic. " +
      "Deliver a 10–15 page report with an executive summary, comparison table and 5 opportunity recommendations. Deadline 9 days.",
    budgetMinUsd: 1200,
    budgetMaxUsd: 1500,
    expectDefect: "missing_section",
  },
];

async function insertBrief(t: TestTenant, b: Brief, i: number): Promise<string> {
  const [row] = await getDb()
    .insert(opportunity)
    .values({
      tenantId: t.tenantId,
      sourceKey: "mock",
      externalId: `test-${i}-${Date.now()}`,
      title: b.title,
      description: b.description,
      clientName: "Harbor & Pine Outfitters",
      clientCountry: "United States",
      clientRating: 4.8,
      clientSpendUsd: 42000,
      budgetType: b.budgetType ?? "fixed",
      budgetMinUsd: b.budgetMinUsd,
      budgetMaxUsd: b.budgetMaxUsd,
      postedAt: new Date(),
      deadlineAt: new Date(Date.now() + 14 * 86_400_000),
      dedupeHash: dedupeHashFor(b.title, b.description),
      status: "new",
    })
    .returning({ id: opportunity.id });
  return row!.id;
}

describe("production workflows per service family (demo defects → repair → QA pass)", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  for (const [i, brief] of BRIEFS.entries()) {
    it(`${brief.family}: produces, catches ${brief.expectDefect}, repairs and packages`, async () => {
      const db = getDb();
      const t = await createTestTenant({ mode: "demo" });
      const deps = testDeps();
      captureCommandQueue(deps.queue);
      const oppId = await insertBrief(t, brief, i);
      await handlers["opportunity-analyse"]({ tenantId: t.tenantId, opportunityId: oppId }, deps);
      // Triage alone never recommends pursuit: it is a preliminary "consider" queued for deep analysis.
      const [triaged] = await db.select().from(opportunity).where(eq(opportunity.id, oppId));
      expect(triaged!.recommendation).toBe("consider");
      expect(triaged!.status).toBe("analysed");
      expect(deps.queue.jobs.map((x) => x.name)).toContain("opportunity-refine");
      await drain(deps); // deep analysis (deterministic stand-in for the model in demo mode) promotes it
      const [opp] = await db.select().from(opportunity).where(eq(opportunity.id, oppId));
      expect(opp!.marketKey).toBe(brief.family);
      expect(opp!.recommendation).toBe("pursue");
      expect(opp!.status).toBe("shortlisted");

      await approveOpportunity(t.ctx, oppId);
      await drain(deps);
      const [prop] = await db.select().from(proposal).where(and(eq(proposal.opportunityId, oppId), eq(proposal.status, "awaiting_approval")));
      expect(prop!.priceUsd).toBeGreaterThanOrEqual(brief.budgetMinUsd);
      expect(prop!.priceUsd).toBeLessThanOrEqual(brief.budgetMaxUsd);
      await approveProposal(t.ctx, prop!.id);
      await drain(deps);

      const [j] = await db.select().from(job).where(eq(job.opportunityId, oppId));
      expect(j!.serviceFamily).toBe(brief.family);
      expect(j!.status).toBe("awaiting_final_approval");

      const reviews = await db.select().from(qaReview).where(eq(qaReview.jobId, j!.id));
      const failed = reviews.filter((r) => r.verdict === "fail");
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed.flatMap((r) => r.findings.map((f) => f.code))).toContain(brief.expectDefect);
      const repairs = await db.select().from(repair).where(eq(repair.jobId, j!.id));
      expect(repairs.filter((r) => r.status === "succeeded").length).toBeGreaterThanOrEqual(1);

      const steps = await db.select().from(workflowStep).where(eq(workflowStep.jobId, j!.id));
      expect(steps.every((s) => s.status === "succeeded")).toBe(true);

      const [d] = await db.select().from(delivery).where(eq(delivery.jobId, j!.id)).orderBy(desc(delivery.createdAt)).limit(1);
      const [pkg] = await db.select().from(asset).where(eq(asset.id, d!.packageAssetId!));
      const zip = unzipSync(await getStorage().get(pkg!.storageKey));
      const names = Object.keys(zip);
      expect(names).toContain("MANIFEST.md");
      if (brief.family === "ai-automation" || brief.family === "web-app-builds") {
        const inner = names.find((n) => n.endsWith("-source.zip"));
        expect(inner).toBeTruthy();
        const project = unzipSync(zip[inner!]!);
        const report = JSON.parse(strFromU8(project["project/test-report.json"]!)) as { failed: number };
        expect(report.failed).toBe(0);
        expect(Object.keys(project)).toEqual(expect.arrayContaining(["project/README.md"]));
      }
      if (brief.family === "localization-repurposing") expect(names.some((n) => n.endsWith(".srt"))).toBe(true);
      if (brief.family === "image-design") expect(names.some((n) => n.endsWith(".svg"))).toBe(true);
    });
  }
});
