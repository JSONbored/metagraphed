/**
 * Capture SubnetsCompareDrawer screenshots + horizontal-scroll demo for #3933.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after node tests/e2e/capture-compare-drawer-screenshots.mjs
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/compare-drawer-screenshots");
const COMPARE_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/compare-drawer-screenshot.json", import.meta.url), "utf8"),
);
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const COMPARE_NETUIDS = [1, 8, 19, 64];
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
];
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function installCompareFixture(page) {
  await page.route("**/api/v1/compare**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(COMPARE_FIXTURE),
    });
  });
}

async function openExpandedCompare(page) {
  await page.evaluate((netuids) => {
    localStorage.setItem("metagraphed:compare", JSON.stringify(netuids));
  }, COMPARE_NETUIDS);
  await page.goto(`${BASE_URL}/subnets`, { waitUntil: "networkidle", timeout: 90_000 });
  const compareBtn = page.getByRole("button", { name: /^Compare$/i }).last();
  await compareBtn.click();
  await page.getByRole("columnheader", { name: "SN64" }).waitFor({ timeout: 60_000 });
}

async function captureViewport(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: false });
}

async function getCompareScroller(page) {
  return page
    .locator("div.max-h-\\[55vh\\]")
    .filter({ has: page.getByRole("columnheader", { name: "SN64" }) })
    .locator(".overflow-x-auto, .overflow-auto")
    .first();
}

async function recordHorizontalScroll(page) {
  const scroller = await getCompareScroller(page);
  await scroller.waitFor({ state: "visible" });
  const box = await scroller.boundingBox();
  if (!box) throw new Error("compare scroller not found");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(box.x + box.width / 2 - i * 28, box.y + box.height / 2, { steps: 4 });
    await page.waitForTimeout(120);
  }
  await page.mouse.up();

  await page.evaluate(
    (el) => {
      el.scrollLeft = el.scrollWidth;
    },
    await scroller.elementHandle(),
  );
  await page.waitForTimeout(400);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        recordVideo: { dir: OUT_DIR, size: { width: viewport.width, height: viewport.height } },
      });
      const page = await context.newPage();
      await installCompareFixture(page);
      await setTheme(page, theme);
      await openExpandedCompare(page);

      const file = path.join(OUT_DIR, `${VARIANT}-${viewport.name}-${theme}.png`);
      await captureViewport(page, file);
      console.log(`wrote ${file}`);

      if (VARIANT === "after" && viewport.name === "mobile" && theme === "light") {
        await recordHorizontalScroll(page);
      }

      const video = page.video();
      await context.close();
      if (video) {
        const videoPath = path.join(OUT_DIR, `${VARIANT}-${viewport.name}-${theme}.webm`);
        await video.saveAs(videoPath);
        console.log(`wrote ${videoPath}`);
      }
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
