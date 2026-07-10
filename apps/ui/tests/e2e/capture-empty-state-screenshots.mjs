/**
 * Capture empty-state migration screenshots for #3962 (Path C2 contract).
 *
 * Usage (dev server must be running; pass its base URL explicitly):
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after node tests/e2e/capture-empty-state-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8086 VARIANT=before node tests/e2e/capture-empty-state-screenshots.mjs
 *
 * Writes to tmp/empty-state-screenshots/{VARIANT}-{scene}-{viewport}-{theme}.png
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/empty-state-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

const SCENES = [
  {
    id: "endpoints-rpc-pools-empty",
    path: "/endpoints",
    heading: "RPC pools",
    routes: [
      {
        pattern: "**/api/v1/rpc/pools",
        body: { ok: true, data: [], meta: { generated_at: new Date().toISOString() } },
      },
    ],
  },
  {
    id: "subnet-gaps-complete",
    path: "/subnets/1?tab=registry#gaps",
    heading: "Gaps",
    routes: [
      {
        pattern: "**/api/v1/subnets/1/gaps",
        body: {
          ok: true,
          data: { netuid: 1, missing_kinds: [], gap_notes: [] },
          meta: {},
        },
      },
    ],
  },
  {
    id: "schemas-filter-empty",
    path: "/schemas?q=__nomatch3962__",
    heading: "No schemas match",
    routes: [],
  },
];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function installRoutes(page, routes) {
  for (const route of routes) {
    await page.route(route.pattern, async (r) => {
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(route.body),
      });
    });
  }
}

async function captureScene(browser, scene, viewport, theme) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
  });
  await setTheme(page, theme);
  await installRoutes(page, scene.routes);
  await page.goto(`${BASE_URL}${scene.path}`, { waitUntil: "networkidle", timeout: 120_000 });

  if (scene.heading) {
    const locator =
      scene.id === "schemas-filter-empty"
        ? page.getByText(scene.heading, { exact: true }).first()
        : page.getByRole("heading", { name: scene.heading }).first();
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }

  const file = path.join(OUT_DIR, `${VARIANT}-${scene.id}-${viewport.name}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  console.log("wrote", file);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const scene of SCENES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        await captureScene(browser, scene, viewport, theme);
      }
    }
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
