/**
 * Capture /docs/feeds screenshots for #8703.
 *
 * The visual change is the docs page: a new "Runtime upgrades" section, a new
 * "Autodiscovery" section, and a sixth row in the feed table. The
 * `<link rel="alternate">` tags this PR also adds are invisible by nature —
 * they are verified in src/routes/feed-autodiscovery.render.test.tsx and by
 * parsing the served HTML, not here.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=before node tests/e2e/capture-feed-discoverability-screenshots.ts
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-feed-discoverability-screenshots.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/feed-discoverability-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const VIEWPORT_FILTER = process.env.VIEWPORT_FILTER;
const ALL_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1280, height: 900 },
];
const VIEWPORTS = VIEWPORT_FILTER
  ? ALL_VIEWPORTS.filter((v) => v.name === VIEWPORT_FILTER)
  : ALL_VIEWPORTS;
const THEMES = ["light", "dark"];

async function setTheme(page: Page, theme: string) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function openFeedsDocs(page: Page) {
  await page.goto(`${BASE_URL}/docs/feeds`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    await page.waitForTimeout(2000);
  }
  await page
    .getByRole("heading", { name: /^Feeds$/i })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => {});
  await page.waitForTimeout(400);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme as "light" | "dark",
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await setTheme(page, theme);
      await openFeedsDocs(page);
      await page.screenshot({
        path: path.join(OUT_DIR, `feeds-docs-${viewport.name}-${theme}-${VARIANT}.png`),
        fullPage: true,
      });
      await context.close();
      // eslint-disable-next-line no-console
      console.log(`captured feeds-docs-${viewport.name}-${theme}-${VARIANT}.png`);
    }
  }

  await browser.close();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
