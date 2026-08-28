import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Methodology fact states", () => {
  test("keeps its live facts structured while the methodology sources settle", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const pattern of ["**/api/v1/coverage*", "**/api/v1/health*", "**/api/v1/freshness*"]) {
      await page.route(pattern, async (route) => {
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, "/about");

    const facts = page.locator(".mg-hero .mg-facts");
    await expect(facts.locator("dd[aria-busy='true']")).toHaveCount(4);
    await expect(facts.getByText("Unavailable", { exact: true })).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(facts.locator("dd[aria-busy='true']")).toHaveCount(0);
  });

  test("names a failed methodology reading and refreshes its underlying sources", async ({
    page,
  }) => {
    let shouldFail = true;
    for (const pattern of ["**/api/v1/coverage*", "**/api/v1/health*", "**/api/v1/freshness*"]) {
      await page.route(pattern, async (route) => {
        if (!shouldFail) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Methodology fixture failed" },
          }),
        });
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/about");

    const facts = page.locator(".mg-hero .mg-facts");
    await expect(facts.getByText("Unavailable", { exact: true })).toHaveCount(4);
    await expect(facts.getByText("—", { exact: true })).toHaveCount(0);

    shouldFail = false;
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await expect(facts.getByText("Unavailable", { exact: true })).toHaveCount(0);
  });
});
