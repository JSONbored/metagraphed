/**
 * Capture validators-table copy-button screenshots for #5339 (Path C2 contract).
 * Fixed viewport only — never fullPage or element crops.
 *
 * Usage (with a dev server running — pass its base URL explicitly):
 *   UI_BASE_URL=http://127.0.0.1:4001 VARIANT=before node tests/e2e/capture-validator-copy-button-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:4002 VARIANT=after node tests/e2e/capture-validator-copy-button-screenshots.mjs
 *
 * Writes to tmp/validator-copy-button-screenshots/5339-{viewport}-{theme}-{variant}.png
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/validator-copy-button-screenshots");
const VALIDATORS_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/global-validators-screenshot.json", import.meta.url), "utf8"),
);
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:4001";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function installFixtures(page) {
  await page.route("**/api/v1/validators**", async (route) => {
    const url = route.request().url();
    if (url.includes("/validators")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(VALIDATORS_FIXTURE),
      });
      return;
    }
    await route.continue();
  });
}

async function openDirectoryView(page) {
  await page.goto(`${BASE_URL}/validators`, { waitUntil: "networkidle", timeout: 90_000 });
  await page
    .locator("table, [class*='rounded-lg'][class*='border']")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => {
    const isVisible = (el) => !!el && el.getClientRects().length > 0;
    const table = document.querySelector("table");
    const card = document.querySelector("dl")?.closest("div");
    const target = isVisible(table) ? table : isVisible(card) ? card : null;
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  });
  await page.waitForTimeout(300);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    await installFixtures(page);

    for (const theme of THEMES) {
      await setTheme(page, theme);
      await openDirectoryView(page);
      const file = path.join(OUT_DIR, `5339-${viewport.name}-${theme}-${VARIANT}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`wrote ${file}`);
    }

    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
