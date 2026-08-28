import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gotoThroughRestart } from "./server-restart.ts";

const DISPLAY_MARK = fileURLToPath(
  new URL("../../public/logos/display/metagraphed.webp", import.meta.url),
);
const FIRST_PROVIDER_CANONICAL = "https://avatars.githubusercontent.com/u/154099142?s=200&v=4";

test.describe("Providers directory verification state", () => {
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
