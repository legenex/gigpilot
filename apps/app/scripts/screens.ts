/**
 * DEV-ONLY visual verification: logs in through the real form and captures
 * every dashboard page at desktop and mobile widths.
 *
 *   BASE=http://localhost:4721 EMAIL=… PASSWORD=… OUT=/tmp/shots \
 *     apps/app/node_modules/.bin/tsx apps/app/scripts/screens.ts [/path …]
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:4721";
const EMAIL = process.env.EMAIL ?? "";
const PASSWORD = process.env.PASSWORD ?? "";
const OUT = process.env.OUT ?? "./screens";
const FULL = process.env.FULL !== "0";
const VIEWPORTS = (process.env.VIEWPORTS ?? "1440x900,390x844").split(",").map((v) => {
  const [w, h] = v.split("x").map(Number);
  return { width: w!, height: h! };
});
const DEFAULT_PAGES = ["/", "/radar", "/markets", "/applications", "/jobs", "/production", "/agents", "/costs", "/integrations", "/settings"];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES;

function slug(p: string): string {
  return p === "/" ? "command-center" : p.replace(/^\//, "").replace(/[/?=&]+/g, "_");
}

async function signup(page: Page) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("signup-name").fill(process.env.NAME ?? "Dana Okafor");
  await page.getByTestId("signup-email").fill(EMAIL);
  await page.getByTestId("signup-password").fill(PASSWORD);
  await page.getByTestId("signup-submit").click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-email").fill(EMAIL);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vp.width < 600 ? 2 : 1, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${page.url()}: console ${m.text().slice(0, 300)}`);
    });
    if (process.env.SIGNUP === "1" && vp === VIEWPORTS[0]) await signup(page);
    else if (pages.some((p) => !p.startsWith("/login") && !p.startsWith("/signup"))) await login(page);
    for (const p of pages) {
      await page.goto(`${BASE}${p}`, { waitUntil: "load" });
      await page.waitForTimeout(Number(process.env.WAIT ?? 1200));
      const file = path.join(OUT, `${slug(p)}-${vp.width}.png`);
      await page.screenshot({ path: file, fullPage: FULL });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${file}${overflow > 0 ? `  ⚠ horizontal overflow ${overflow}px` : ""}`);
    }
    if (errors.length) console.log(`errors @${vp.width}:\n  ${errors.join("\n  ")}`);
    await ctx.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
