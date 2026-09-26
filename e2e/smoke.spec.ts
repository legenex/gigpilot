import { expect, test } from "@playwright/test";
import { APP_URL, WEB_URL, signUp } from "./helpers";

const PAGES = ["/", "/radar", "/markets", "/applications", "/jobs", "/production", "/agents", "/costs", "/integrations", "/settings"];

test("health endpoints", async ({ request }) => {
  expect((await request.get(`${WEB_URL}/api/health`)).ok()).toBe(true);
  expect((await request.get(`${APP_URL}/api/health`)).ok()).toBe(true);
});

test("marketing site renders without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(WEB_URL);
  await expect(page.locator("h1").first()).toContainText(/profitable work/i);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(800);
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test("every dashboard page renders for a new workspace", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signUp(page);
  for (const path of PAGES) {
    const res = await page.goto(`${APP_URL}${path}`);
    expect(res?.status(), path).toBeLessThan(400);
    await expect(page.locator("main").first(), path).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("mobile layout has no horizontal page scroll", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const url of [WEB_URL, `${APP_URL}/login`]) {
    await page.goto(url);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
  await ctx.close();
});
