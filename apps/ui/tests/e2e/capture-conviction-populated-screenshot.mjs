/**
 * Supplementary screenshot capture for #6883 (conviction leaderboard urgency
 * framing). As of writing, a live sweep of all 128 registered subnets found
 * ZERO with an active conviction contest (every leaderboard is genuinely
 * empty right now) -- so a real before/after pair against production data
 * is honestly byte-identical and does not demonstrate the new gap%/badge
 * UI at all. This script follows the same `page.route()` fixture-
 * interception pattern already established in
 * capture-validator-delegate-screenshots.mjs / capture-yield-percentile-
 * screenshots.mjs to render the new UI against a realistic, schema-accurate
 * mocked API response instead.
 *
 * Usage (with the "after" dev server already running):
 *   UI_BASE_URL=http://localhost:8080 node tests/e2e/capture-conviction-populated-screenshot.mjs
 *
 * Writes 6 PNGs (3 viewports x 2 themes) to tmp/pr-screenshots/
 * 6883-conviction-populated-<viewport>-<theme>.png.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/pr-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:8080";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

// Real API envelope shape (verified live against api.metagraph.sh), with a
// synthetic 3-entry leaderboard: a king, a close challenger (~3% gap, so the
// badge reads "Takeover imminent"), and a distant third entry.
const CONVICTION_FIXTURE = {
  ok: true,
  schema_version: 1,
  data: {
    schema_version: 1,
    netuid: 1,
    queried_at_block: 8_656_366,
    unlock_rate: 934_866,
    maturity_rate: 311_622,
    king: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    count: 3,
    leaderboard: [
      {
        hotkey: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        is_owner: true,
        locked_mass: 1_000_000_000_000,
        conviction: 980_000_000_000,
      },
      {
        hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
        is_owner: false,
        locked_mass: 1_100_000_000_000,
        conviction: 950_000_000_000,
      },
      {
        hotkey: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
        is_owner: false,
        locked_mass: 900_000_000_000,
        conviction: 400_000_000_000,
      },
    ],
  },
  meta: { artifact_path: "/api/v1/subnets/1/conviction", cache: "short", source: "fixture" },
};

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function installFixture(page) {
  await page.route("**/api/v1/subnets/*/conviction**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONVICTION_FIXTURE),
    });
  });
}

async function openConvictionSection(page) {
  await page.goto(`${BASE_URL}/subnets/1`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.getByText("Takeover imminent").waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => {
    const el = document.getElementById("conviction");
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 72;
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
    await installFixture(page);

    for (const theme of THEMES) {
      await setTheme(page, theme);
      await openConvictionSection(page);
      const file = path.join(OUT_DIR, `6883-conviction-populated-${viewport.name}-${theme}.png`);
      await page.screenshot({ path: file });
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
