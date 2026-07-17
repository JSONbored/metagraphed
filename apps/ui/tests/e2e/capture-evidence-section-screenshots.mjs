/**
 * Capture /subnets/:netuid Evidence section headers for #6434.
 *
 * The change is the SectionAnchor header copy (title / subtitle / info) on two
 * instances of the same panel, so the evidence that matters is a tight crop of
 * each header -- a full-page shot buries a two-line diff. Both tabs are shot:
 * the Overview embed (whose title changes) and the dedicated Evidence tab
 * (whose subtitle + info change).
 *
 * The Overview selector matches either id on purpose: before the fix that embed
 * is `#evidence`, after it is `#evidence-preview`, and the same script has to
 * shoot both variants.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=before node tests/e2e/capture-evidence-section-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-evidence-section-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/evidence-section-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const NETUID = process.env.NETUID ?? "1";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
];
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function open(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(800);
}

/** The SectionAnchor header (title + info + subtitle) -- the changed region. */
function header(section) {
  return section.locator("xpath=./div[1]");
}

async function shotHeader(page, selector, file) {
  const section = page.locator(selector).first();
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await header(section).screenshot({ path: file });
  console.log(`wrote ${file}`);
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

      // Overview tab: the embedded preview (#evidence before, #evidence-preview after).
      await open(page, `/subnets/${NETUID}`);
      await shotHeader(
        page,
        "section#evidence-preview, section#evidence",
        path.join(OUT_DIR, `${VARIANT}-overview-${viewport.name}-${theme}.png`),
      );

      // Dedicated Evidence tab: keeps #evidence in both variants.
      await open(page, `/subnets/${NETUID}?tab=evidence`);
      await shotHeader(
        page,
        "section#evidence",
        path.join(OUT_DIR, `${VARIANT}-evidence-tab-${viewport.name}-${theme}.png`),
      );

      await context.close();
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
