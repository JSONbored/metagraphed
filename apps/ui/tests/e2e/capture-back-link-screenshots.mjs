/**
 * Capture the bottom-of-page "back to index" link for #6432.
 *
 * capture-pr-screenshots.mjs can't drive this one: `--section` pins a section's
 * top just under the sticky header, but the back-link sits *above* the section
 * it precedes, so it lands off-frame -- and in the `before` variant the link
 * doesn't exist at all, so there is no id to anchor on either. Same contract as
 * Phase C2 (fixed viewports only, never fullPage; theme forced via mg-theme;
 * 3 viewports x 2 themes x {before, after}), just a different scroll strategy:
 * anchor on a landmark that exists in BOTH variants and align its BOTTOM with
 * the viewport bottom, so the space the link occupies is what fills the frame.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8081 VARIANT=before node tests/e2e/capture-back-link-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-back-link-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/back-link-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const HOTKEY = process.env.HOTKEY ?? "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

/**
 * `anchor` exists in both variants; the link renders directly above it (or, on
 * /subnets/:netuid, at the very page bottom -- `anchor: null` scrolls there).
 */
const PAGES = [
  { key: "validators", route: `/validators/${HOTKEY}`, anchor: "call" },
  { key: "subnets", route: "/subnets/1", anchor: null },
];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function open(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2500);
  }
  // Brand faces swap in via font-display; a mid-swap capture differs in
  // typeface from a warm one and every glyph shifts (#4876).
  await page.evaluate(() => document.fonts.ready);
}

/** Bring the region the link occupies into frame, clear of the sticky masthead.
 *
 * With an `anchor`, align that section's BOTTOM with the viewport bottom -- the
 * link renders directly above it, so it lands mid-frame.
 *
 * Without one (/subnets/:netuid, where the link is the page's last body
 * element), anchor off the AppShell footer instead: park its top at 75% of the
 * viewport so the ~180px above it -- which is exactly where the link sits -- is
 * in the lower-middle of the frame. Scrolling to `document.body.scrollHeight`
 * looks right but isn't: the footer is ~590px tall, so the link lands ~34px
 * from the viewport top, underneath the ~130px sticky header, and the shot
 * comes back showing only the footer.
 *
 * Re-scrolls after a settle so late-resolving queries can't push it away.
 */
async function scrollToBackLink(page, anchor) {
  const doScroll = () =>
    page.evaluate((id) => {
      if (id) {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ block: "end", behavior: "instant" });
          return;
        }
      }
      const footer = document.querySelector("footer");
      if (footer) {
        const footerTop = footer.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({
          top: Math.max(0, footerTop - window.innerHeight * 0.75),
          behavior: "instant",
        });
        return;
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    }, anchor);
  await doScroll();
  await page.waitForTimeout(600);
  await doScroll();
  await page.waitForTimeout(300);
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

      for (const p of PAGES) {
        await open(page, p.route);
        await scrollToBackLink(page, p.anchor);
        const file = path.join(OUT_DIR, `${p.key}-${VARIANT}-${viewport.name}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(`wrote ${file}`);
      }

      await context.close();
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
