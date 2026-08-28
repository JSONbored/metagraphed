import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Deferred footer freshness", () => {
  test("keeps source provenance unknown until its lazy reading settles", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/freshness*", async (route) => {
      await continueRead;
      await route.continue();
    });

    await gotoThroughRestart(page, "/subnets/19");

    const footer = page.getByRole("contentinfo");
    await footer.scrollIntoViewIfNeeded();
    const freshness = footer.locator('[aria-live="polite"]');
    await expect(freshness).toHaveAttribute("aria-busy", "true");
    await expect(freshness).toContainText("sources —");
    await expect(freshness).toContainText("stale —");
    await expect(freshness).not.toContainText("sources 0");
    await expect(freshness).not.toContainText("stale 0");

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(freshness).not.toHaveAttribute("aria-busy", "true");
    await expect(freshness).toContainText(/sources \d+/);
    await expect(freshness).toContainText(/stale \d+/);
  });
});
