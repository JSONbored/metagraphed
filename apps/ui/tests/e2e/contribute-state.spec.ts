import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Contribute coverage query state", () => {
  test("keeps coverage's instrument geometry while the registry read is pending", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/coverage*", async (route) => {
      await continueRead;
      await route.continue();
    });

    await gotoThroughRestart(page, "/contribute");

    const coverage = page.getByRole("group", {
      name: "Subnets publishing each kind of surface",
    });
    await expect(coverage).toHaveAttribute("aria-busy", "true");
    await expect(coverage.locator(".mg-rails-row--skeleton")).toHaveCount(6);
    await expect(page.getByText("of 0 subnets · registry")).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(coverage).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByText(/of \d+ subnets · registry/)).toBeVisible();
  });

  test("offers a retry when registry coverage cannot be read", async ({ page }) => {
    let shouldFail = true;
    await page.route("**/api/v1/coverage*", async (route) => {
      if (!shouldFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Coverage fixture failed" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/contribute");

    const coverageError = page.getByRole("alert").filter({ hasText: "registry coverage" });
    await expect(coverageError).toBeVisible();
    await expect(page.getByText("No registry coverage dimensions are published")).toHaveCount(0);

    shouldFail = false;
    await coverageError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("group", { name: "Subnets publishing each kind of surface" }),
    ).toBeVisible();
    await expect(coverageError).toHaveCount(0);
  });
});
