import { expect, type Page } from "@playwright/test";

export const WEB_URL = process.env.E2E_WEB_URL ?? "http://100.105.214.61:4710";
export const APP_URL = process.env.E2E_APP_URL ?? "http://100.105.214.61:4711";

export function uniqueEmail(tag = "e2e"): string {
  return `${tag}+${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

export async function signUp(page: Page, opts: { name?: string; email?: string; password?: string } = {}) {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? "pilot-e2e-password-42";
  await page.goto(`${APP_URL}/signup`);
  await page.getByTestId("signup-name").fill(opts.name ?? "Avery Pilot");
  await page.getByTestId("signup-email").fill(email);
  await page.getByTestId("signup-password").fill(password);
  await page.getByTestId("signup-submit").click();
  await page.waitForURL((u) => u.origin === new URL(APP_URL).origin && !/\/(signup|login)/.test(u.pathname), { timeout: 30_000 });
  return { email, password };
}

/** Reload `url` until `check` passes or the timeout elapses (the worker runs asynchronously). */
export async function pollPage(page: Page, url: string, check: () => Promise<boolean>, timeoutMs: number, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.goto(url);
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting on ${url}`);
    await page.waitForTimeout(intervalMs);
  }
}

export function money(text: string | null): number {
  if (!text) return NaN;
  const neg = /[−-]/.test(text);
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return neg ? -n : n;
}

export async function expectVisible(page: Page, testId: string) {
  await expect(page.getByTestId(testId).first()).toBeVisible();
}
