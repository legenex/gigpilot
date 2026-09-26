import { expect, test } from "@playwright/test";
import { APP_URL, WEB_URL, money, pollPage } from "./helpers";

/**
 * Required end-to-end demo (build brief §35), driven through the real UI and
 * the real worker pipeline in demo/mock mode.
 */
test("opportunity → proposal → job → QA fail → repair → approval → delivery", async ({ page }) => {
  // Production runs on local GX inference (one gx-code slot, ~40–60 s per heavy call);
  // web/automation jobs make ~10 heavy calls, so allow realistic wall-clock time.
  // Two-tier analysis also means a `pursue` only appears after the deep-analysis slot
  // refines the top triage candidate, so the pre-job waits are generous too.
  test.setTimeout(40 * 60_000);

  // 1–2. Logged-out website shows Log in / Sign up
  await page.goto(WEB_URL);
  await expect(page.getByTestId("nav-login").first()).toBeVisible();
  await expect(page.getByTestId("nav-signup").first()).toBeVisible();
  await expect(page.getByTestId("nav-dashboard")).toHaveCount(0);

  // 3–4. Sign up through the website CTA
  await page.getByTestId("nav-signup").first().click();
  await expect(page).toHaveURL(/\/signup/);
  await page.getByTestId("signup-name").fill("Demo Owner");
  await page.getByTestId("signup-email").fill(`demo+${Date.now()}@example.com`);
  await page.getByTestId("signup-password").fill("pilot-demo-password-42");
  await page.getByTestId("signup-submit").click();
  await page.waitForURL((u) => u.origin === new URL(APP_URL).origin && !/\/(signup|login)/.test(u.pathname));

  // 5–6. Website now shows Go to Dashboard, which opens the dashboard
  await page.goto(WEB_URL);
  await expect(page.getByTestId("nav-dashboard").first()).toBeVisible();
  await expect(page.getByTestId("nav-login")).toHaveCount(0);
  await page.getByTestId("nav-dashboard").first().click();
  await page.waitForURL((u) => u.origin === new URL(APP_URL).origin);

  // 7–8. Radar fills from the demo marketplace via the worker pipeline; find a pursue-worthy one
  const pursueRows = page.locator('[data-testid="radar-row"][data-recommendation="pursue"]:is([data-status="shortlisted"], [data-status="analysed"])');
  await pollPage(page, `${APP_URL}/radar`, async () => (await pursueRows.count()) > 0, 420_000);
  const oppId = await pursueRows.first().getAttribute("data-opportunity-id");
  await page.goto(`${APP_URL}/radar?view=all`);
  expect(await page.getByTestId("radar-row").count()).toBeGreaterThan(5);
  expect(oppId).toBeTruthy();

  // 9. Detailed analysis
  await page.goto(`${APP_URL}/radar/${oppId}`);
  await expect(page.getByTestId("opp-title")).toBeVisible();
  for (const gate of ["gate-budget", "gate-profit", "gate-margin"]) {
    await expect(page.getByTestId(gate)).toHaveAttribute("data-pass", "true");
  }
  expect(money(await page.getByTestId("opp-budget").textContent())).toBeGreaterThanOrEqual(300);
  expect(money(await page.getByTestId("opp-expected-profit").textContent())).toBeGreaterThanOrEqual(300);
  expect(money(await page.getByTestId("opp-margin").textContent())).toBeGreaterThanOrEqual(50);

  // 10–11. Owner approves pursuit → Proposal Agent drafts → owner approves proposal
  await page.getByTestId("opp-approve-pursuit").click();
  const panel = page.getByTestId("proposal-panel");
  await pollPage(page, `${APP_URL}/radar/${oppId}`, async () => (await panel.getAttribute("data-status").catch(() => null)) === "awaiting_approval", 120_000);
  expect(money(await page.getByTestId("proposal-price").textContent())).toBeGreaterThan(0);
  await page.getByTestId("proposal-approve").click();
  await page.getByTestId("proposal-approve-confirm").click();
  await expect(panel).toHaveAttribute("data-status", "approved", { timeout: 30_000 });

  // 12. Demo client accepts → job created
  const jobRow = page.locator('[data-testid="job-row"]').first();
  await pollPage(page, `${APP_URL}/jobs`, async () => (await jobRow.count()) > 0 && (await page.locator('[data-testid="job-row"][data-status]:not([data-status="delivered"]):not([data-status="closed"])').count()) > 0, 120_000);
  const liveJob = page.locator('[data-testid="job-row"]:not([data-status="delivered"]):not([data-status="closed"])').first();
  const jobId = await liveJob.getAttribute("data-job-id");
  expect(jobId).toBeTruthy();

  // 13–18. Planner builds the DAG, agents execute, QA fails once, Recovery repairs, QA passes
  const status = page.getByTestId("job-status");
  await pollPage(page, `${APP_URL}/jobs/${jobId}`, async () => (await status.getAttribute("data-status").catch(() => null)) === "awaiting_final_approval", 18 * 60_000, 5000);
  expect(await page.getByTestId("dag-node").count()).toBeGreaterThan(3);
  expect(await page.locator('[data-testid="qa-review"][data-verdict="fail"]').count()).toBeGreaterThanOrEqual(1);
  expect(await page.locator('[data-testid="qa-review"][data-verdict="pass"]').count()).toBeGreaterThanOrEqual(1);
  expect(await page.getByTestId("repair-item").count()).toBeGreaterThanOrEqual(1);

  // 19–20. Owner approves final delivery; package is downloadable
  await page.getByTestId("job-approve-delivery").click();
  await page.getByTestId("confirm-action").click();
  await expect(status).toHaveAttribute("data-status", "delivered", { timeout: 30_000 });
  const href = await page.getByTestId("job-delivery-download").getAttribute("href");
  expect(href).toBeTruthy();
  const pkg = await page.request.get(new URL(href!, APP_URL).toString());
  expect(pkg.status()).toBe(200);
  expect((await pkg.body()).subarray(0, 2).toString()).toBe("PK"); // zip

  // 21. Expected vs actual cost
  // Local GX inference is free, so a GX-produced job can legitimately cost $0 —
  // assert both figures are real numbers and the ledger holds estimate AND actual rows.
  expect(money(await page.getByTestId("job-estimated-cost").textContent())).toBeGreaterThanOrEqual(0);
  expect(money(await page.getByTestId("job-actual-cost").textContent())).toBeGreaterThanOrEqual(0);
  await page.goto(`${APP_URL}/costs`);
  expect(await page.locator('[data-testid="ledger-row"][data-kind="estimate"]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-testid="ledger-row"][data-kind="actual"]').count()).toBeGreaterThan(0);

  // 22–23. Dashboard + auditable agent history
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId("event-stream")).toBeVisible();
  await page.goto(`${APP_URL}/agents`);
  expect(await page.getByTestId("agent-run-row").count()).toBeGreaterThan(5);
  expect(await page.locator('[data-testid="agent-run-row"][data-agent="qa"]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-testid="agent-run-row"][data-agent="recovery"]').count()).toBeGreaterThan(0);
});
