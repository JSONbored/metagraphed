/**
 * Capture the command palette for #6414 (the added ⌘C copy footer hint).
 *
 * The palette is a ⌘K modal, so this opens it (with a query so a row is
 * selected and the footer renders) and shoots the FIXED VIEWPORT -- never a
 * crop, per SKILL.md Phase C2. The visible delta is the footer's new "⌘C copy"
 * hint. The local dev server hydrates flakily, so it retries whole loads until
 * the palette renders, with a long settle for React's post-mismatch client
 * regeneration.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8081 VARIANT=before node tests/e2e/capture-palette-copy-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-palette-copy-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/palette-copy-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

async function openPalette(page) {
  // Long settle: the dev server can hydrate-mismatch and regenerate client-side.
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.fonts.ready);
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.getAttribute("cmdk-input") != null, {
    timeout: 8000,
  });
  await page.keyboard.type("subnets");
  await page.waitForFunction(() => !!document.querySelector("[cmdk-item][aria-selected='true']"), {
    timeout: 8000,
  });
  await page.waitForTimeout(500);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      let done = false;
      for (let attempt = 1; attempt <= 12 && !done; attempt++) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage();
        try {
          await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
          await page.evaluate((t) => localStorage.setItem("mg-theme", t), theme);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
          await openPalette(page);
          const file = path.join(OUT_DIR, `${VARIANT}-${viewport.name}-${theme}.png`);
          await page.screenshot({ path: file, fullPage: false });
          console.log(`wrote ${file} (attempt ${attempt})`);
          done = true;
        } catch {
          console.log(`${viewport.name}/${theme} attempt ${attempt}: palette flake, retrying`);
        }
        await context.close();
      }
      if (!done) console.log(`${viewport.name}/${theme}: could not render palette in 12 attempts`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
