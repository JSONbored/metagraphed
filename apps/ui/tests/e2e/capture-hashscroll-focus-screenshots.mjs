/**
 * Capture the hash-nav focus indicator for #6421.
 *
 * capture-pr-screenshots.mjs can't drive this: the change is what happens when
 * useHashScroll resolves a deep link, so the shot has to land on the hash URL
 * and let the hook scroll + focus. Same Phase C2 contract otherwise -- fixed
 * viewports only, never fullPage, theme forced via mg-theme.
 *
 * The evidence is the focus ring: `after` focuses the target section's heading
 * (a visible outline on "ECONOMICS"), `before` only scrolls it into view with
 * no focus indicator. The section's own scroll-mt-32 clears the sticky header,
 * so the heading lands in-frame.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8081 VARIANT=before node tests/e2e/capture-hashscroll-focus-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-hashscroll-focus-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/hashscroll-focus-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
// A subnet section that renders on the default overview tab.
const ROUTE = "/subnets/1#economics";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
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

      // Land on the hash URL so useHashScroll fires on mount.
      await page.goto(`${BASE_URL}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      try {
        await page.waitForLoadState("networkidle", { timeout: 8000 });
      } catch {
        await page.waitForTimeout(2500);
      }
      // Brand faces swap in via font-display; wait so before/after share one.
      await page.evaluate(() => document.fonts.ready);
      // The hook defers its scroll+focus (80ms); give it and the smooth scroll room.
      await page.waitForTimeout(1200);

      // The hook's smooth scroll lands at a slightly different offset run to
      // run, which would drift the heading in/out of frame. Park the target
      // heading at a fixed spot in BOTH variants so the pair is directly
      // comparable -- scrolling doesn't blur, so the `after` focus ring stays.
      await page.evaluate(() => {
        const h = document.querySelector("#economics h2");
        if (h) {
          const y = h.getBoundingClientRect().top + window.scrollY - 180;
          window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
        }
      });
      await page.waitForTimeout(300);

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
