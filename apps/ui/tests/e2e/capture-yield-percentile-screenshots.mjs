/**
 * Capture Yield tab page screenshots for #3934 PR table (Path C2 contract).
 *
 * Captures the fixed viewport (not fullPage, not element crops) after scrolling
 * the Metagraph → Yield section into view so reviewers see what visitors see.
 *
 * Usage (with dev server running — pass its base URL explicitly):
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after node tests/e2e/capture-yield-percentile-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8086 VARIANT=before node tests/e2e/capture-yield-percentile-screenshots.mjs
 *
 * Writes to tmp/yield-percentile-screenshots/{VARIANT}-{viewport}-{theme}.png
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/yield-percentile-screenshots");
const YIELD_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/yield-percentile-screenshot.json", import.meta.url), "utf8"),
);
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
/** SN64 has dense validator yields — good fixture for percentile collision case. */
const SUBNET_PATH = process.env.SCREENSHOT_SUBNET_PATH ?? "/subnets/64";
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

/** Pixels above #yield to keep in frame (app header + sticky profile tabs). */
const SCROLL_OFFSET_PX = 148;

async function openYieldSection(page) {
  await page.goto(`${BASE_URL}${SUBNET_PATH}?tab=metagraph#yield`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.locator("#yield").waitFor({ state: "visible", timeout: 90_000 });

  const strip = page.getByLabel("Yield percentile distribution");
  const legacyGrid = page.locator("#yield").getByText("p25", { exact: true }).first();
  try {
    await strip.waitFor({ state: "visible", timeout: 90_000 });
  } catch {
    await legacyGrid.waitFor({ state: "visible", timeout: 30_000 });
  }

  // Scroll so the Yield section header + percentile row sit in the viewport with
  // page chrome (masthead tabs) visible — what a visitor sees after deep-linking.
  await page.evaluate((offset) => {
    const section = document.getElementById("yield");
    if (!section) return;
    const top = section.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }, SCROLL_OFFSET_PX);

  // Let sticky tab paint settle after programmatic scroll.
  await page.waitForTimeout(250);
}

/** Fixed-viewport capture per SKILL.md Path C2 — never fullPage or element crop. */
async function captureViewport(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: false });
}

async function installYieldFixture(page) {
  await page.route("**/api/v1/subnets/*/yield", async (route) => {
    if (route.request().url().includes("/yield/history")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(YIELD_FIXTURE),
    });
  });
  await page.route("**/api/v1/subnets/*/yield/history**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { netuid: 64, window: "30d", point_count: 0, points: [] },
        meta: {},
      }),
    });
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await installYieldFixture(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await openYieldSection(page);
      const file = path.join(OUT_DIR, `${VARIANT}-${viewport.name}-${theme}.png`);
      await captureViewport(page, file);
      console.log(`wrote ${file}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
