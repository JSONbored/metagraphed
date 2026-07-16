/**
 * Capture /subnets screenshots for the root inclusion toggle (#6270).
 *
 * Before captures show the filter toolbar without the toggle; after captures
 * show it in its default (all-inclusive, unlit) state, plus one engaged shot
 * proving the filter drops the root netuid.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=before node tests/e2e/capture-subnets-filters-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-subnets-filters-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/subnets-filters-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const ALL_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
];
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function open(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(800);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of ALL_VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await setTheme(page, theme);
      await open(page, "/subnets");
      const file = path.join(OUT_DIR, `${VARIANT}-subnets-${viewport.name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`wrote ${file}`);
      await context.close();
    }
  }

  // Engaged state: only meaningful once the toggle exists, so it is an
  // after-only shot. Desktop + both themes -- the grid above already covers
  // responsive layout of the toolbar itself.
  if (VARIANT === "after") {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await setTheme(page, theme);
      await open(page, "/subnets?includeRoot=false");
      const file = path.join(OUT_DIR, `after-subnets-root-hidden-desktop-${theme}.png`);
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
