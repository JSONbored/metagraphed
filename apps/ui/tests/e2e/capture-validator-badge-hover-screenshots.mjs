/**
 * Capture the account "validator" badge's hover + navigation evidence for #6428.
 *
 * The badge is intentionally byte-identical at rest (the issue asks to preserve
 * its styling and only add navigation), so the fixed-viewport at-rest matrix
 * from capture-pr-screenshots.mjs shows no delta by design. What actually
 * changes is only observable on interaction, which is what this captures --
 * the "animated evidence" case in SKILL.md Phase C2, following the same shape
 * as capture-mega-menu-touch-hover-screenshots.mjs:
 *
 *   - `<variant>-hover-<theme>.png`  the badge under the cursor. Before: a
 *     plain <span>, so hovering does nothing. After: a Link, so the pill
 *     brightens (bg-emerald-500/20) exactly like the SN pill beside it.
 *   - `after-navigated-<theme>.png`  the validator profile reached by clicking
 *     the badge -- the deliverable. There is no before counterpart: a <span>
 *     has nowhere to go, which is the bug.
 *   - a webm of the hover+click, recorded on the light pass.
 *
 * Fixed viewport only, never fullPage; theme forced via mg-theme (Phase C2).
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8081 VARIANT=before node tests/e2e/capture-validator-badge-hover-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8080 VARIANT=after  node tests/e2e/capture-validator-badge-hover-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/validator-badge-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
// A hotkey with validator_permit across many subnets, so the PERMIT column is
// populated -- an account without one renders no badge and proves nothing.
const SS58 = process.env.SS58 ?? "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const VIEWPORT = { width: 1280, height: 800 };
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function openFootprint(page) {
  await page.goto(`${BASE_URL}/accounts/${SS58}`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2000);
  }
  // Brand fonts swap in via font-display, so a cold server can still be on the
  // fallback face here -- capture then differs in typeface, not just state.
  await page.evaluate(() => document.fonts.ready);
  await page.locator("section#footprint").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: theme === "light" ? { dir: OUT_DIR, size: VIEWPORT } : undefined,
    });
    const page = await context.newPage();
    await setTheme(page, theme);
    await openFootprint(page);

    const badge = page.locator("section#footprint").getByText("validator", { exact: true }).first();
    await badge.waitFor({ state: "visible", timeout: 30_000 });
    await badge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await badge.hover();
    await page.waitForTimeout(600); // let transition-colors settle
    const hover = path.join(OUT_DIR, `${VARIANT}-hover-${theme}.png`);
    await page.screenshot({ path: hover, fullPage: false });
    console.log(`wrote ${hover}`);

    // Supplementary close-up: at a 1280-wide viewport the pill is ~60px, so a
    // bg-emerald-500/10 -> /20 shift is invisible in the frame above and
    // invisible again once GitHub renders it as a 260px thumbnail. Clip tight
    // around the hovered pill so the affordance is actually readable (the
    // zoomed-close-up remedy from #5446), alongside -- never instead of -- the
    // fixed-viewport matrix the contract requires.
    const box = await badge.boundingBox();
    if (box) {
      const pad = 14;
      const zoom = path.join(OUT_DIR, `${VARIANT}-hover-zoom-${theme}.png`);
      await page.screenshot({
        path: zoom,
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: box.width + pad * 2,
          height: box.height + pad * 2,
        },
      });
      console.log(`wrote ${zoom}`);
    }

    // Clicking is only meaningful once the badge is a Link; a <span> has no
    // destination, so `before` has no navigated counterpart -- that is the bug.
    // Click the badge in BOTH variants and shoot whatever the click produced.
    // This is the pair that actually reads: same action, opposite outcome.
    // Before, the badge is a <span>, so the click does nothing and the reader
    // is still staring at the account page -- that IS the bug, and it is a
    // screenshot, not an absence. After, the same click opens the validator
    // profile. Capturing only the "after" side (as if before had no
    // counterpart) is what made the earlier evidence unreadable.
    await badge.click();
    if (VARIANT === "after") {
      await page.waitForURL(/\/validators\//, { timeout: 30_000 });
      // The validator profile polls on an interval, so "networkidle" never
      // reports quiet and a fixed wait just screenshots the skeleton. Wait for
      // real content instead: the APY section is the page's own anchor, and
      // the hero name renders alongside it.
      await page
        .locator("section#apy")
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      // Give a navigation the same grace it would have had, so "nothing
      // happened" is a settled observation rather than an impatient one.
      await page.waitForTimeout(3000);
    }
    // Top of the page: the hero (after) or the unchanged account header
    // (before) is what identifies where the click actually landed.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    const dest = path.join(OUT_DIR, `${VARIANT}-after-click-${theme}.png`);
    await page.screenshot({ path: dest, fullPage: false });
    console.log(`wrote ${dest} (url now: ${page.url()})`);

    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
