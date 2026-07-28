/**
 * Capture the private-address-labels surfaces for #8484.
 *
 * Seeds one label ("Main coldkey" on a well-known account, "My validator" on
 * a validator hotkey) into localStorage before each page load, then captures:
 *  - the account-detail masthead (H1 shows the private label, editor pencil)
 *  - the validator masthead's Hotkey/Coldkey rows (labeled vs unlabeled)
 *  - the /settings portability panel
 *  - the open editor popover on the account page
 *
 * Same viewport/theme contract as capture-back-link-screenshots.ts.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8080 node tests/e2e/capture-address-labels-screenshots.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/address-labels-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

const LABELS_FILE = JSON.stringify({
  version: 1,
  labels: {
    [ACCOUNT]: { name: "Main coldkey", updated_at: "2026-07-28T00:00:00.000Z" },
    [HOTKEY]: { name: "My validator", updated_at: "2026-07-28T00:00:00.000Z" },
  },
});

async function prime(page, theme, withLabels) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate(
    ({ t, labels }) => {
      localStorage.setItem("mg-theme", t);
      if (labels) localStorage.setItem("metagraphed:address-labels", labels);
      else localStorage.removeItem("metagraphed:address-labels");
    },
    { t: theme, labels: withLabels ? LABELS_FILE : null },
  );
}

async function open(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2500);
  }
  // Suspense boundaries render skeletons first; anchor on the resolved
  // masthead H1 so a mid-load skeleton is never what gets captured.
  try {
    await page.waitForSelector("h1", { timeout: 20_000 });
  } catch {
    /* settings has its H1 immediately; entity pages that never resolve
       still capture whatever rendered, better than aborting the run */
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await ctx.newPage();

      for (const variant of ["before", "after"]) {
        const withLabels = variant === "after";
        const tag = `${viewport.name}-${theme}-${variant}`;

        await prime(page, theme, withLabels);
        await open(page, `/accounts/${ACCOUNT}`);
        await page.screenshot({ path: path.join(OUT_DIR, `account-${tag}.png`) });

        await prime(page, theme, withLabels);
        await open(page, `/validators/${HOTKEY}`);
        await page.screenshot({ path: path.join(OUT_DIR, `validator-${tag}.png`) });

        await prime(page, theme, withLabels);
        await open(page, "/settings");
        const panel = page.getByText("Private address labels", { exact: true }).first();
        if (await panel.count()) {
          await panel.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        }
        await page.screenshot({ path: path.join(OUT_DIR, `settings-${tag}.png`) });
      }

      // Editor popover open (after-state only, desktop only is fine but
      // capture per viewport for completeness).
      await prime(page, theme, true);
      await open(page, `/accounts/${ACCOUNT}`);
      const editBtn = page.locator('button[aria-label="Edit your private label"]').first();
      if (await editBtn.count()) {
        await editBtn.click();
        await page.waitForTimeout(400);
        await page.screenshot({
          path: path.join(OUT_DIR, `editor-open-${viewport.name}-${theme}.png`),
        });
      }

      await ctx.close();
    }
  }
  await browser.close();
  console.log(`Screenshots written to ${OUT_DIR}`);
}

await main();
