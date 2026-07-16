/**
 * Capture /docs/api-reference screenshots (fumadocs-openapi integration).
 *
 * New page — before captures are the 404/fallback when the route is
 * missing, after captures show the live index + one operation page.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=before node tests/e2e/capture-api-reference-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after  node tests/e2e/capture-api-reference-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/api-reference-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
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

async function open(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(600);
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
      await open(page, "/docs/api-reference");
      const indexFile = path.join(OUT_DIR, `${VARIANT}-index-${viewport.name}-${theme}.png`);
      await page.screenshot({ path: indexFile, fullPage: false });
      console.log(`wrote ${indexFile}`);
      await context.close();
    }
  }

  // Operation page: one representative sample, desktop only, both themes --
  // the index-page grid above already covers responsive layout.
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await setTheme(page, theme);
    await open(page, "/docs/api-reference/accounts/account-axon-removals");
    const opFile = path.join(OUT_DIR, `${VARIANT}-operation-desktop-${theme}.png`);
    await page.screenshot({ path: opFile, fullPage: false });
    console.log(`wrote ${opFile}`);
    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
