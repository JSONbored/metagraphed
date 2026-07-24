/**
 * Capture /feeds docs page screenshots for #3512 (Path C2).
 *
 * New page — before captures are the 404/fallback when the route is missing;
 * after captures show the live docs page.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=before node tests/e2e/capture-feeds-docs-screenshots.ts
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after  node tests/e2e/capture-feeds-docs-screenshots.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/feeds-docs-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const VIEWPORT_FILTER = process.env.VIEWPORT_FILTER;
const ALL_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const VIEWPORTS = VIEWPORT_FILTER
  ? ALL_VIEWPORTS.filter((v) => v.name === VIEWPORT_FILTER)
  : ALL_VIEWPORTS;
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function openFeedsDocs(page) {
  await page.goto(`${BASE_URL}/feeds`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2000);
  }
  const docs = page.locator('[data-testid="feeds-docs"]');
  const hero = page.getByRole("heading", { name: /^Feeds$/i }).first();
  try {
    await docs.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    await hero.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  }
  await page.waitForTimeout(250);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await setTheme(page, theme);
      await openFeedsDocs(page);
      const file = path.join(OUT_DIR, `${VARIANT}-${viewport.name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`wrote ${file}`);
      await context.close();
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
