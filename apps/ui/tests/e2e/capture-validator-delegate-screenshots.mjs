/**
 * Capture validator delegate-selection UI screenshots for #5245 (Path C2).
 * Fixed viewport only — never fullPage or element crops.
 *
 * Usage (with dev servers running — pass base URL explicitly):
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after node tests/e2e/capture-validator-delegate-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8086 VARIANT=before node tests/e2e/capture-validator-delegate-screenshots.mjs
 *
 * PAGE=directory|detail (default: directory)
 * Writes to tmp/validator-delegate-screenshots/5245-{page}-{viewport}-{theme}-{variant}.png
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/validator-delegate-screenshots");
const VALIDATORS_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/global-validators-screenshot.json", import.meta.url), "utf8"),
);
const DETAIL_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/validator-detail-screenshot.json", import.meta.url), "utf8"),
);
const HISTORY_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/validator-history-screenshot.json", import.meta.url), "utf8"),
);
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const PAGE = process.env.PAGE === "detail" ? "detail" : "directory";
const HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
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

async function installAfterFixtures(page) {
  await page.route("**/api/v1/validators**", async (route) => {
    const url = route.request().url();
    if (/\/validators\/[^/?]+\/history/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HISTORY_FIXTURE),
      });
      return;
    }
    if (/\/validators\/[^/?]+/.test(url) && !url.endsWith("/validators")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(DETAIL_FIXTURE),
      });
      return;
    }
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
  await page.locator("table").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return;
    const top = table.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  });
  await page.waitForTimeout(300);
}

async function openDetailView(page) {
  await page.goto(`${BASE_URL}/validators/${HOTKEY}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  if (VARIANT === "after") {
    await page.getByText("Delegator yield (APY)").waitFor({ state: "visible", timeout: 30_000 });
  } else {
    await page.locator("header.mg-header").waitFor({ state: "visible", timeout: 30_000 });
  }
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

    if (VARIANT === "after") {
      await installAfterFixtures(page);
    }

    for (const theme of THEMES) {
      await setTheme(page, theme);
      if (PAGE === "detail") {
        await openDetailView(page);
      } else {
        await openDirectoryView(page);
      }
      const file = path.join(OUT_DIR, `5245-${PAGE}-${viewport.name}-${theme}-${VARIANT}.png`);
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
