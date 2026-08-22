import { expect, test, type Page } from "@playwright/test";
import { DATED_ENDPOINT_PATTERNS, findHarFixture, harPathForRoute } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

const ROUTE = "/subnets";
const HAR_PATH = harPathForRoute(ROUTE);
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

async function openSubnets(page: Page, viewport: (typeof VIEWPORTS)[number], search = "") {
  await page.routeFromHAR(HAR_PATH, {
    url: "**/api.metagraph.sh/**",
    notFound: "fallback",
    update: false,
  });
  for (const pattern of DATED_ENDPOINT_PATTERNS) {
    const fixture = findHarFixture(HAR_PATH, pattern);
    if (fixture) await page.route(pattern, (route) => route.fulfill(fixture));
  }
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await gotoThroughRestart(page, `${ROUTE}${search}`);
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    await page.waitForTimeout(2000);
  }
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of VIEWPORTS) {
  test(`keeps subnet search usable at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await openSubnets(page, viewport);

    const search = page.getByRole("textbox", {
      name: "Search by netuid, name, or symbol",
    });
    await expect(search).toBeVisible();
    const searchBox = await search.boundingBox();
    expect(searchBox?.width, `search width at ${viewport.width}px`).toBeGreaterThanOrEqual(180);

    if (viewport.width < 1024) {
      expect(
        searchBox?.height,
        `mobile search target at ${viewport.width}px`,
      ).toBeGreaterThanOrEqual(44);

      const filters = page.getByRole("button", { name: "Filters", exact: true });
      const filterBox = await filters.boundingBox();
      expect(filterBox?.height, `filter target at ${viewport.width}px`).toBeGreaterThanOrEqual(44);

      await filters.click();
      const dialog = page.getByRole("dialog", { name: "Filters" });
      await expect(dialog).toBeVisible();
      // #11520: the sheet is mode-aware now. Browse is the default, and it
      // deliberately does NOT carry the display and export controls — that is
      // the whole point of a focused default. Sharing survives in both modes,
      // because a reader who just narrowed the list is the one who wants to
      // send it.
      await expect(dialog.getByText("Display", { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
      await expect(dialog.getByText("Share", { exact: true })).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Copy link with current filters, sort, and page" }),
      ).toBeVisible();
      await expect(dialog.getByText("Quick views", { exact: true })).toBeVisible();
      await expect(dialog.getByText("View options", { exact: true })).toBeVisible();

      const hasApi = dialog.getByRole("button", { name: "Has API", exact: true });
      await hasApi.click();
      await expect(hasApi).toHaveAttribute("aria-pressed", "true");
      await expect(dialog.getByRole("button", { name: "Clear all filters" })).toBeVisible();

      const close = dialog.getByRole("button", { name: "Close filters" });
      const closeBox = await close.boundingBox();
      expect(closeBox?.height, `filter close target at ${viewport.width}px`).toBeGreaterThanOrEqual(
        44,
      );
      await close.click();
      await expect(dialog).toBeHidden();
    }
  });
}

// #11520: the controls Browse withholds must genuinely exist one mode over,
// otherwise "focused default" is just "missing feature".
for (const viewport of VIEWPORTS.filter((v) => v.width < 1024)) {
  test(`restores display and export controls in Research at ${viewport.name} (${viewport.width}px)`, async ({
    page,
  }) => {
    await openSubnets(page, viewport, "?mode=research");

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Filters" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Display", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Export & share", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Download CSV" })).toBeVisible();
  });
}
