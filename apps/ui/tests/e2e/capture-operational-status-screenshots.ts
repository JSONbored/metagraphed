/**
 * Capture Operational status header screenshots for #5112 PR table.
 *
 * Captures the fixed viewport (not fullPage, not element crops) after scrolling
 * the "Operational status" section into view so reviewers see what visitors see.
 *
 * Usage (dev server must already be running on BASE_URL):
 *   VARIANT=before node tests/e2e/capture-operational-status-screenshots.ts
 *   VARIANT=after node tests/e2e/capture-operational-status-screenshots.ts
 *
 * Writes to tmp/operational-status-screenshots/{VARIANT}-{viewport}-{theme}.png
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/operational-status-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "after" ? "after" : "before";
const SUBNET_PATH = "/subnets/1";
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

async function openOperationalStatus(page) {
  await page.goto(`${BASE_URL}${SUBNET_PATH}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.locator("#health-trends").waitFor({ state: "visible", timeout: 90_000 });

  // Clear whatever the sticky masthead's *actual* rendered height is at this
  // breakpoint (measured live, not guessed) plus a small margin.
  const scrollToSection = () =>
    page.evaluate(() => {
      const section = document.getElementById("health-trends");
      if (!section) return;
      const header = document.querySelector("header");
      const clearance = (header?.getBoundingClientRect().bottom ?? 0) + 12;
      const top = section.getBoundingClientRect().top + window.scrollY - clearance;
      window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    });

  // Scroll, then re-scroll after data-driven layout shifts (KPI tiles/queries
  // resolving) settle, so the section header stays put in frame.
  await scrollToSection();
  await page.waitForTimeout(500);
  await scrollToSection();
  await page.waitForTimeout(300);
}

/** Fixed-viewport capture — never fullPage or element crop. */
async function captureViewport(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: false });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await openOperationalStatus(page);
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
