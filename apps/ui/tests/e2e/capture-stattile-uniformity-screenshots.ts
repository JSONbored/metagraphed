/**
 * Capture the StatTile / masthead-action design-uniformity fix.
 *
 * StatTile has 27 consumers, so this deliberately spans several of them —
 * a page with truncate={false} tiles (validator), default-truncate tiles
 * (blocks index, endpoints), and the mixed case that surfaced the bug — to
 * show the eyebrow no longer ellipsizes and non-truncating hints no longer
 * wrap one word per line, without regressing tiles that already fit.
 *
 * Usage (run once per checkout, VARIANT distinguishes the output names):
 *   UI_BASE_URL=http://127.0.0.1:8081 VARIANT=before node tests/e2e/capture-stattile-uniformity-screenshots.ts
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-stattile-uniformity-screenshots.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/stattile-uniformity-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const HOTKEY = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const PAGES = [
  { key: "validator", route: `/validators/${HOTKEY}` },
  { key: "account", route: `/accounts/${SS58}` },
  { key: "blocks", route: "/blocks" },
  { key: "endpoints", route: "/endpoints" },
];

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
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
    /* capture whatever rendered rather than aborting the whole run */
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
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
      for (const p of PAGES) {
        await prime(page, theme);
        await open(page, p.route);
        await page.screenshot({
          path: path.join(OUT_DIR, `${p.key}-${viewport.name}-${theme}-${VARIANT}.png`),
        });
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`[${VARIANT}] screenshots written to ${OUT_DIR}`);
}

await main();
