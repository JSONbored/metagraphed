import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Providers directory verification state", () => {
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
