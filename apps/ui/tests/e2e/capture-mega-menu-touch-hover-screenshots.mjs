/**
 * Capture mega-menu live-preview screenshots + hover video for #5337.
 *
 * NavMegaMenu is `hidden lg:flex` — only Desktop (1280) shows the hover path.
 * Captures open the Subnets mega panel, hover the first live row, and write
 * fixed-viewport PNGs plus a short webm of the hover interaction.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8094 VARIANT=before node tests/e2e/capture-mega-menu-touch-hover-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8095 VARIANT=after  node tests/e2e/capture-mega-menu-touch-hover-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/mega-menu-touch-hover-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8095";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const THEMES = ["light", "dark"];
const VIEWPORT = { name: "desktop", width: 1280, height: 800 };

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function openSubnetsMega(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2000);
  }

  const trigger = page.getByRole("link", { name: /^Subnets$/i }).first();
  await trigger.waitFor({ state: "visible", timeout: 60_000 });
  await trigger.hover();
  await page.waitForTimeout(500);

  // Live preview rows only render when the panel filter is non-empty.
  const filter = page.getByPlaceholder(/filter|search/i).first();
  await filter.waitFor({ state: "visible", timeout: 30_000 });
  await filter.fill("root");
  await page.waitForTimeout(1000);

  // Prefer after-hook marker; fall back to subnet match links.
  const liveRow = page.locator("[data-mega-live-preview='subnet']").first();
  const fallbackRow = page
    .locator("a[href*='/subnets/']")
    .filter({ hasText: /SN|Root|subnet/i })
    .first();
  return { trigger, liveRow, fallbackRow };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      recordVideo:
        theme === "light"
          ? { dir: OUT_DIR, size: { width: VIEWPORT.width, height: VIEWPORT.height } }
          : undefined,
    });
    const page = await context.newPage();
    await setTheme(page, theme);
    const { liveRow, fallbackRow } = await openSubnetsMega(page);

    // At-rest with mega panel open.
    const rest = path.join(OUT_DIR, `${VARIANT}-${VIEWPORT.name}-${theme}.png`);
    await page.screenshot({ path: rest, fullPage: false });
    console.log(`wrote ${rest}`);

    // Hover interaction — wait for preview card if fine-pointer.
    const row = (await liveRow.count()) > 0 ? liveRow : fallbackRow;
    await row.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(700);
    const hover = path.join(OUT_DIR, `${VARIANT}-${VIEWPORT.name}-${theme}-hover.png`);
    await page.screenshot({ path: hover, fullPage: false });
    console.log(`wrote ${hover}`);

    // Touch-primary simulation: force matchMedia so hover card should not open (after only).
    if (VARIANT === "after" && theme === "light") {
      await page.evaluate(() => {
        const orig = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          if (query.includes("hover: none") || query.includes("pointer: coarse")) {
            return {
              matches: true,
              media: query,
              onchange: null,
              addListener() {},
              removeListener() {},
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent() {
                return false;
              },
            };
          }
          return orig(query);
        };
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const trigger = page.getByRole("link", { name: /^Subnets$/i }).first();
      await trigger.hover();
      await page.waitForTimeout(500);
      const filter = page.getByPlaceholder(/filter subnets/i).first();
      await filter.fill("root");
      await page.waitForTimeout(1000);
      const coarseRow = page.locator("[data-mega-live-preview='subnet']").first();
      await coarseRow.hover({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
      // Ensure no entity hover card is in the DOM under coarse pointer.
      const cardCount = await page.locator('[data-testid="entity-hover-card"]').count();
      console.log(`coarse entity-hover-card count=${cardCount}`);
      const coarse = path.join(OUT_DIR, `${VARIANT}-desktop-light-coarse.png`);
      await page.screenshot({ path: coarse, fullPage: false });
      console.log(`wrote ${coarse}`);
    }

    const video = page.video();
    await context.close();
    if (video) {
      const videoPath = path.join(OUT_DIR, `${VARIANT}-desktop-${theme}-hover.webm`);
      await video.saveAs(videoPath);
      console.log(`wrote ${videoPath}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
