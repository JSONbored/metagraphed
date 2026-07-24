/**
 * Capture explorer leaderboard overflow screenshots for #3932 (Path C2 contract).
 *
 * Replays the recorded `/explorer` HAR so captures are deterministic, scrolls
 * the "Top fee payers" section into the fixed viewport, and writes 12 images
 * (3 viewports × 2 themes × before/after).
 *
 * Usage (with dev server running — pass its base URL explicitly):
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after node tests/e2e/capture-explorer-leaderboard-screenshots.ts
 *   UI_BASE_URL=http://127.0.0.1:8086 VARIANT=before node tests/e2e/capture-explorer-leaderboard-screenshots.ts
 *
 * Writes to tmp/explorer-leaderboard-screenshots/{VARIANT}-{viewport}-{theme}.png
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DATED_ENDPOINT_PATTERNS, findHarFixture, harPathForRoute } from "./har-path.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/explorer-leaderboard-screenshots");
const HAR_PATH = harPathForRoute("/explorer");
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

/** Pixels above the fee-payers section to keep app chrome visible. */
const SCROLL_OFFSET_PX = 120;

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function installHarReplay(page) {
  await page.routeFromHAR(HAR_PATH, {
    url: "**/api.metagraph.sh/**",
    notFound: "fallback",
    update: false,
  });
  for (const pattern of DATED_ENDPOINT_PATTERNS) {
    const fixture = findHarFixture(HAR_PATH, pattern);
    if (fixture) {
      await page.route(pattern, (route) => route.fulfill(fixture));
    }
  }
}

async function openFeePayersSection(page) {
  await page.goto(`${BASE_URL}/explorer`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    await page.waitForTimeout(2000);
  }

  const heading = page.getByRole("heading", { name: "Top fee payers" });
  await heading.waitFor({ state: "visible", timeout: 90_000 });

  await page.evaluate((offset) => {
    const headings = [...document.querySelectorAll("h2")];
    const target = headings.find((h) => h.textContent?.trim() === "Top fee payers");
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }, SCROLL_OFFSET_PX);

  await page.waitForTimeout(250);
}

/** Fixed-viewport capture per SKILL.md Path C2 — never fullPage or element crop. */
async function captureViewport(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: false });
}

async function recordTableScroll(page) {
  const scroller = page.locator('[data-explorer-leaderboard="fee-payers"]').first();
  const count = await scroller.count();
  if (count === 0) return;

  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
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
      await installHarReplay(page);
      await setTheme(page, theme);
      await openFeePayersSection(page);

      if (VARIANT === "after" && viewport.name === "mobile" && theme === "light") {
        await recordTableScroll(page);
      }

      const file = path.join(OUT_DIR, `${VARIANT}-${viewport.name}-${theme}.png`);
      await captureViewport(page, file);
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
