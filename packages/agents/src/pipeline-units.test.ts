import "./testing/setup";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, application, closeDb, eq, getDb, idempotencyKey, notification, opportunity, sourceIntegration } from "@gigpilot/db";
import { handlers } from "./handlers";
import { AUTOMATION_BRIEF, approvedApplication, createTestTenant, insertOpportunity, migrateTestDb, resetDb, testDeps } from "./testing/harness";

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeDb();
});

describe("application submission", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is idempotent: a double-enqueued submit results in exactly one submission", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const oppId = await insertOpportunity(t, AUTOMATION_BRIEF);
    const applicationId = await approvedApplication(t, deps, oppId);

    const payload = { tenantId: t.tenantId, applicationId };
    const results = await Promise.all([handlers["application-submit"](payload, deps), handlers["application-submit"](payload, deps)]);
    const statuses = results.map((r) => (r as { status: string }).status).sort();
    expect(statuses.filter((s) => s === "submitted")).toHaveLength(1);
    expect(await handlers["application-submit"](payload, deps)).toMatchObject({ status: "skipped" });

    const [app] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(app!.status).toBe("submitted");
    expect(app!.submissionMode).toBe("mock");
    expect(app!.externalRef).toMatch(/^mock-/);
    const keys = await db.select().from(idempotencyKey).where(eq(idempotencyKey.scope, "application.submit"));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.result).toMatchObject({ status: "submitted" });
    expect(deps.queue.jobs.filter((j) => j.name === "application-award")).toHaveLength(1);
    const [opp] = await db.select().from(opportunity).where(eq(opportunity.id, oppId));
    expect(opp!.status).toBe("applied");
  });

  it("never auto-submits where the marketplace does not permit it — the owner gets a manual task", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const oppId = await insertOpportunity(t, { ...AUTOMATION_BRIEF, sourceKey: "upwork" });
    const applicationId = await approvedApplication(t, deps, oppId);
    const res = await handlers["application-submit"]({ tenantId: t.tenantId, applicationId }, deps);
    expect(res).toMatchObject({ status: "manual_required" });
    const [app] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(app!.status).toBe("approved");
    const tasks = await db.select().from(notification).where(and(eq(notification.tenantId, t.tenantId), eq(notification.dedupeKey, `manual-submit:${applicationId}`)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toMatch(/Submit this proposal on Upwork/);
    expect(deps.queue.jobs.filter((j) => j.name === "application-award")).toHaveLength(0);
  });
});

describe("opportunity scout", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("dedupes repeat refreshes and cross-posts, enforces poll interval and capabilities", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const first = (await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "mock" }, deps)) as { inserted: number; duplicates: number; fetched: number; expired: number };
    expect(first.inserted).toBeGreaterThan(10);
    expect(first.inserted + first.duplicates + first.expired).toBe(first.fetched);

    const rows = await db.select().from(opportunity).where(eq(opportunity.tenantId, t.tenantId));
    const archived = rows.filter((r) => r.status === "archived");
    expect(archived.length).toBe(first.duplicates);
    for (const a of archived) expect(rows.some((r) => r.id === a.duplicateOfId)).toBe(true);
    const live = rows.filter((r) => r.status === "new");
    expect(live.every((r) => r.marketKey !== null)).toBe(true);
    expect(live.some((r) => (r.raw as { triageBudget?: string }).triageBudget === "low_budget")).toBe(true);
    expect(deps.queue.jobs.filter((j) => j.name === "opportunity-analyse")).toHaveLength(first.inserted);

    // Immediate re-run: blocked by the source's minimum poll interval.
    expect(await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "mock" }, deps)).toMatchObject({ status: "skipped" });

    // After the interval: everything already known (same feed bucket) → nothing re-inserted.
    await db.update(sourceIntegration).set({ lastSyncAt: new Date(Date.now() - 20 * 60_000) }).where(and(eq(sourceIntegration.tenantId, t.tenantId), eq(sourceIntegration.sourceKey, "mock")));
    const second = (await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "mock" }, deps)) as { inserted: number; known: number };
    expect(second.inserted).toBe(0);
    expect(second.known).toBe(first.inserted + first.duplicates);
    expect((await db.select().from(opportunity).where(eq(opportunity.tenantId, t.tenantId))).length).toBe(rows.length);

    // Scheduled runs never poll sources that forbid background polling (Upwork), even when enabled.
    await db.update(sourceIntegration).set({ enabled: true }).where(and(eq(sourceIntegration.tenantId, t.tenantId), eq(sourceIntegration.sourceKey, "upwork")));
    const up = await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "upwork", trigger: "schedule" } as never, deps);
    expect(up).toMatchObject({ status: "skipped" });
    expect((up as { reason: string }).reason).toMatch(/background polling/);
    const fanout = (await handlers["source-refresh-all"]({}, deps)) as { queued: number };
    expect(deps.queue.jobs.filter((j) => j.name === "source-refresh" && (j.payload as { sourceKey: string }).sourceKey === "upwork")).toHaveLength(0);
    expect(fanout.queued).toBe(0); // mock was refreshed < 30 min ago
  });
});
