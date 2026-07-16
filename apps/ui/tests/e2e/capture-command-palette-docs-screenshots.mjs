/**
 * Capture command palette "Jump to" screenshots for the docs-nav-drift fix
 * (fix/docs-nav-drift).
 *
 * before = ROUTE_INDEX hardcoded docs entries (stale hand-written hints).
 * after  = docs entries sourced live from docsSource via getDocsNav().
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=before node tests/e2e/capture-command-palette-docs-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after  node tests/e2e/capture-command-palette-docs-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/command-palette-docs-screenshots");
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

async function openPaletteFilteredToReference(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2000);
  }
  await page.keyboard.press("Meta+k");
  const input = page.getByPlaceholder("Search subnets, surfaces, endpoints, providers, docs…");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill("reference");
  await page.waitForTimeout(400);
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
      await openPaletteFilteredToReference(page);
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
