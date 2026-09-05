import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gotoThroughRestart } from "./server-restart.ts";

test.use({ serviceWorkers: "block" });

const DISPLAY_MARK = fileURLToPath(
  new URL("../../public/logos/display/metagraphed.webp", import.meta.url),
);
const FIRST_PROVIDER_CANONICAL = "https://avatars.githubusercontent.com/u/154099142?s=200&v=4";

test.describe("Providers directory verification state", () => {
  test("keeps exhaustive rankings behind an explicit mobile disclosure", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/apis/providers");

    const leaders = page.locator("[data-mg-leaders]");
    const showAll = page.getByRole("button", { name: "Show all 18" });
    const directory = page.getByRole("table", { name: "Providers" });

    await expect(leaders.locator("li")).toHaveCount(3);
    await expect(showAll).toBeVisible();
    await expect(directory).toBeAttached();
    expect(
      await page
        .locator("section#directory,section#leaders")
        .evaluateAll((nodes) => nodes.map((node) => node.id)),
    ).toEqual(["directory", "leaders"]);
    expect((await showAll.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await showAll.click();
    await expect(leaders.locator("li")).toHaveCount(18);
    await expect(showAll).toHaveCount(0);
    await expect(page.getByText("endpoints served · registry")).toBeVisible();
  });

  test("uses display-sized marks without downloading canonical sources", async ({ page }) => {
    const displayMark = await readFile(DISPLAY_MARK);
    const canonicalRequests: string[] = [];
    await page.route("**/logos/display/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "image/webp", body: displayMark });
    });
    await page.route(FIRST_PROVIDER_CANONICAL, async (route) => {
      canonicalRequests.push(route.request().url());
      await route.continue();
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoThroughRestart(page, "/apis/providers");

    const mark = page.locator('img[src^="/logos/display/"]').first();
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("src", /\/logos\/display\/.+\.webp$/);
    await expect
      .poll(() => mark.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expect(canonicalRequests).toEqual([]);
  });

  test("falls back to the canonical source when a derivative fails", async ({ page }) => {
    let failedDerivatives = 0;
    await page.route("**/logos/display/**", async (route) => {
      failedDerivatives += 1;
      await route.abort("failed");
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoThroughRestart(page, "/apis/providers");

    await expect.poll(() => failedDerivatives).toBeGreaterThan(0);
    const fallback = page.locator(`img[src="${FIRST_PROVIDER_CANONICAL}"]`);
    await expect(fallback).toHaveAttribute("src", FIRST_PROVIDER_CANONICAL);
  });

  test("keeps the registry directory usable when the independent verification lane fails", async ({
    page,
  }) => {
    let shouldFail = true;
    await page.route("**/api/v1/source-health*", async (route) => {
      if (!shouldFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Source health fixture failed" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/apis/providers");

    const directory = page.getByRole("table", { name: "Providers" });
    const sourceError = page.getByRole("alert").filter({ hasText: "provider source verification" });
    await expect(sourceError).toBeVisible();
    await expect(directory).toBeVisible();
    await expect(directory.getByRole("link").first()).toBeVisible();
    await expect(page.getByText("source verification unavailable · registry")).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    shouldFail = false;
    await sourceError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(sourceError).toHaveCount(0);
    await expect(
      page.getByText("source health from the verification lane · registry"),
    ).toBeVisible();
  });
});

test("provider filters survive reload and browser history with accessible mobile controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoThroughRestart(page, "/apis/providers?q=404&kind=subnet-team");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
  const search = page.getByRole("searchbox", { name: "Search providers", exact: true });
  await expect(search).toHaveValue("404");
  for (const control of [
    search,
    page.getByRole("combobox", { name: "Kind", exact: true }),
    page.getByRole("combobox", { name: "Authority", exact: true }),
  ])
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator("#providers .mg-dt-row")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Authority", exact: true }).selectOption("official");
  await expect(page.getByText("No providers match these filters.", { exact: false })).toBeVisible();
  await page.reload();
  await expect(search).toHaveValue("404");
  await expect(page.getByRole("combobox", { name: "Authority", exact: true })).toHaveValue(
    "official",
  );
  await page.goBack();
  await expect(page.locator("#providers .mg-dt-row")).toHaveCount(1);
  await page.goForward();
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(page.locator("#providers .mg-dt-row")).toHaveCount(132);
});

test("registry freshness and cached identity survive an independent registry refresh failure", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-05T21:50:41.021Z"));
  await gotoThroughRestart(page, "/apis/providers");
  const clock = page.locator("[data-mg-live-meta] span");
  // Registry capture is July 8; the independent health capture is August 23.
  await expect(clock).toHaveText("59d ago");
  await page.route("**/api/v1/providers", (route) =>
    route.fulfill({ status: 503, json: { error: "registry refresh failure" } }),
  );
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  // The primary query keeps the shared 1s/2s/4s retry schedule.
  await expect(
    page.getByRole("alert").filter({ hasText: "provider registry refresh" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#providers .mg-dt-row")).toHaveCount(132);
  await expect(clock).toHaveText("59d ago");
});

test("saved mobile columns preserve provider navigation and a usable exact host copy", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() =>
    localStorage.setItem("mg-columns:mg-providers-columns", JSON.stringify(["kind"])),
  );
  await gotoThroughRestart(page, "/apis/providers?q=404");
  await page.waitForFunction(
    () => (window as unknown as { __MG_HYDRATED__: boolean }).__MG_HYDRATED__,
  );
  const row = page.locator("#providers .mg-dt-row").first();
  await expect(row.locator("td")).toHaveCount(1);
  await expect(row.locator("td")).toContainText("subnet-team");
  await expect(row.getByRole("link").first()).toHaveAttribute("href", "/providers/404-gen");
  await row.getByRole("button", { name: "Expand row", exact: true }).click();
  const copy = page.getByRole("button", { name: "Copy provider URL", exact: true });
  expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await copy.boundingBox())!.width).toBeGreaterThan(250);
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("https://www.404.xyz/");
  await page.reload();
  await expect(row.locator("td")).toHaveCount(1);
  await expect(row.locator("td")).toContainText("subnet-team");
});
