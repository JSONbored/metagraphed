/**
 * Capture the account History tab (holdings over time) for #8370.
 *
 * Two accounts per the issue's own requirement: a long-lived one with many
 * positions (the stacked area + small multiples + "+N more" expander) and a
 * new/cold one (the empty state). `before` navigates to the same ?tab= URL,
 * which on main resolves to no such tab — that IS the before state.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8080 node tests/e2e/capture-holdings-history-screenshots.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/holdings-history-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
// A validator hotkey with 100+ positions, and a cold account with none.
const RICH = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const COLD = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
];
const THEMES = ["light", "dark"];

async function prime(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => localStorage.setItem("mg-theme", t), theme);
}

async function open(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    await page.waitForTimeout(2500);
  }
  try {
    await page.waitForSelector("h1", { timeout: 20_000 });
  } catch {
    /* capture whatever rendered rather than aborting the run */
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
}

async function shoot(page, name) {
  const anchor = page.locator("#holdings-history").first();
  if (await anchor.count()) {
    await anchor.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -90));
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await ctx.newPage();
      const tag = `${viewport.name}-${theme}`;

      await prime(page, theme);
      await open(page, `/accounts/${RICH}?tab=holdings`);
      await shoot(page, `rich-${tag}`);

      await prime(page, theme);
      await open(page, `/accounts/${COLD}?tab=holdings`);
      await shoot(page, `cold-${tag}`);

      await ctx.close();
    }
  }
  await browser.close();
  console.log(`Screenshots written to ${OUT_DIR}`);
}

await main();
