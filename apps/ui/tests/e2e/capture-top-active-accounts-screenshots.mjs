/**
 * Capture /accounts "Most active accounts" screenshots for #5315.
 *
 * Scrolls the ranking section into the fixed viewport (3 sizes × 2 themes).
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8101 VARIANT=before node tests/e2e/capture-top-active-accounts-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8102 VARIANT=after  node tests/e2e/capture-top-active-accounts-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/top-active-accounts-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8102";
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
const SCROLL_OFFSET_PX = 96;

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function openAccountsRanking(page) {
  await page.goto(`${BASE_URL}/accounts`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2000);
  }

  const heading = page.getByRole("heading", { name: "Most active accounts" });
  await heading.waitFor({ state: "visible", timeout: 90_000 });

  await page.evaluate((offset) => {
    const headings = [...document.querySelectorAll("h2")];
    const target = headings.find((h) => h.textContent?.trim() === "Most active accounts");
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }, SCROLL_OFFSET_PX);

  await page.waitForTimeout(300);
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
      await openAccountsRanking(page);
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
