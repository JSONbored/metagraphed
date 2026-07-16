/**
 * Capture /subnets screenshots for the root inclusion toggle (#6270).
 *
 * The change is a single control inside the sticky filter bar, so a
 * full-viewport shot buries it. The primary evidence is a tight crop of the
 * bar itself (before: no toggle, after: "Hide root"); the full-page shots are
 * context only.
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

/** The sticky filter bar, located via the search input's nearest sticky ancestor. */
function filterBar(page) {
  return page
    .locator('input[placeholder*="Search by netuid"]')
    .locator('xpath=ancestor::div[contains(@class,"sticky")][1]');
}

async function shotBar(page, file) {
  const bar = filterBar(page);
  await bar.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await bar.screenshot({ path: file });
  console.log(`wrote ${file}`);
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
      await shotBar(page, path.join(OUT_DIR, `${VARIANT}-bar-${viewport.name}-${theme}.png`));
      const full = path.join(OUT_DIR, `${VARIANT}-subnets-${viewport.name}-${theme}.png`);
      await page.screenshot({ path: full, fullPage: false });
      console.log(`wrote ${full}`);
      await context.close();
    }
  }

  // Engaged state: only meaningful once the toggle exists, so it is an
  // after-only shot. Desktop + both themes -- the grid above already covers
  // responsive layout of the bar itself.
  if (VARIANT === "after") {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await setTheme(page, theme);
      await open(page, "/subnets?includeRoot=false");
      await shotBar(page, path.join(OUT_DIR, `after-bar-root-hidden-desktop-${theme}.png`));
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
