import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("comparison ledger loading", () => {
  test("keeps the selected columns and metric rows visible on a delayed mobile response", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route("**/api/v1/compare**", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.fulfill({ response });
    });

    await gotoThroughRestart(page, "/compare?subnets=1,19");

    const loadingLedger = page.getByRole("table", {
      name: "Loading comparison of Subnet 1, Subnet 19",
    });
    await expect(loadingLedger).toBeVisible();
    await expect(loadingLedger).toHaveAttribute("aria-busy", "true");
    await expect(loadingLedger.getByText("Economics", { exact: true })).toBeVisible();
    await expect(loadingLedger.getByText("Emission share", { exact: true })).toBeVisible();
    await expect(loadingLedger.locator(".animate-pulse")).toHaveCount(24);

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    await expect(loadingLedger).toHaveCount(0);
    const loadedLedger = page.getByRole("table", {
      name: /^Comparison of /,
    });
    await expect(loadedLedger).toBeVisible();
    await expect(loadedLedger).not.toHaveAttribute("aria-busy", "true");
  });
});
