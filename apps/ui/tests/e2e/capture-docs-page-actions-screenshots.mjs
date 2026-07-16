/**
 * Capture /docs/api-reference/accounts/account-axon-removals screenshots
 * verifying: description sizing, non-duplicated sidebar, kebab-case
 * breadcrumb, and Fumadocs' native ViewOptionsPopover (open + closed).
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8085 node tests/e2e/capture-docs-page-actions-screenshots.mjs
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/docs-page-actions-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const PAGE_PATH = "/docs/api-reference/accounts/account-axon-removals";

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await setTheme(page, theme);
    await page.goto(`${BASE_URL}${PAGE_PATH}`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(600);

    const closedFile = path.join(OUT_DIR, `after-operation-${theme}.png`);
    await page.screenshot({ path: closedFile, fullPage: false });
    console.log(`wrote ${closedFile}`);

    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForTimeout(300);
    const openFile = path.join(OUT_DIR, `after-operation-popover-${theme}.png`);
    await page.screenshot({ path: openFile, fullPage: false });
    console.log(`wrote ${openFile}`);

    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
