import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a running stack. Defaults target the persistent
 * gx10-01 deployment over Tailscale; override for local dev:
 *   E2E_WEB_URL=http://localhost:4720 E2E_APP_URL=http://localhost:4721 pnpm e2e
 */
const WEB_URL = process.env.E2E_WEB_URL ?? "http://100.105.214.61:4710";
const APP_URL = process.env.E2E_APP_URL ?? "http://100.105.214.61:4711";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  metadata: { WEB_URL, APP_URL },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
});
