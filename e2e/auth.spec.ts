import { expect, test } from "@playwright/test";
import { APP_URL, WEB_URL, signUp } from "./helpers";

test.describe("authentication & protected routes", () => {
  test("unauthenticated dashboard routes redirect to login", async ({ page }) => {
    for (const path of ["/", "/radar", "/jobs", "/settings", "/integrations"]) {
      await page.goto(`${APP_URL}${path}`);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("unauthenticated API access is refused", async ({ request }) => {
    const stream = await request.get(`${APP_URL}/api/events/stream`, { maxRedirects: 0 });
    expect([401, 403]).toContain(stream.status());
    const asset = await request.get(`${APP_URL}/api/assets/00000000-0000-0000-0000-000000000000`, { maxRedirects: 0 });
    expect([401, 403, 404]).toContain(asset.status());
    const session = await request.get(`${APP_URL}/api/auth/get-session`);
    expect(await session.text()).toMatch(/null|^$/);
  });

  test("sign up, persistent session, logout, login", async ({ page, context }) => {
    const { email, password } = await signUp(page);
    // session persists across navigations and new pages
    const second = await context.newPage();
    await second.goto(`${APP_URL}/radar`);
    await expect(second).not.toHaveURL(/\/login/);
    await second.close();

    await page.getByTestId("user-menu").click();
    await page.getByTestId("logout").click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`${APP_URL}/jobs`);
    await expect(page).toHaveURL(/\/login/);

    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("wrong password is rejected", async ({ page }) => {
    const { email } = await signUp(page);
    await page.getByTestId("user-menu").click();
    await page.getByTestId("logout").click();
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill("definitely-not-the-password");
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("marketing site CTA reflects auth state in server-rendered HTML", async ({ page, request }) => {
    // Logged out: raw HTML (no JS) already shows Log in / Sign up.
    const html = await (await request.get(WEB_URL)).text();
    expect(html).toContain('data-testid="nav-login"');
    expect(html).toContain('data-testid="nav-signup"');
    expect(html).not.toContain('data-testid="nav-dashboard"');

    await signUp(page);
    const cookies = await page.context().cookies(APP_URL);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const authedHtml = await (await request.get(WEB_URL, { headers: { cookie: cookieHeader } })).text();
    expect(authedHtml).toContain('data-testid="nav-dashboard"');
    expect(authedHtml).not.toContain('data-testid="nav-login"');
  });
});
