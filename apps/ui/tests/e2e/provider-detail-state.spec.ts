import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Provider detail secondary query state", () => {
  test("defers a provider's large surface table until its evidence enters view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    let surfaceRequests = 0;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/providers/lium/endpoints*", async (route) => {
      await continueReads;
      await route.continue();
    });
    await page.route("**/api/v1/surfaces**", async (route) => {
      surfaceRequests += 1;
      await continueReads;
      await route.continue();
    });

    await gotoThroughRestart(page, "/providers/lium");

    const latency = page.getByRole("group", { name: "lium.io endpoint latency" });
    const surfaces = page.getByRole("table", { name: "lium.io surfaces" });

    await expect(latency).toHaveAttribute("aria-busy", "true");
    await expect(latency.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(page.getByText("Loading endpoint probe readings · probe-derived")).toBeVisible();
    await expect(
      page.getByText("Surface evidence loads as this section approaches."),
    ).toBeVisible();
    expect(surfaceRequests).toBe(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    await page.locator("section#surfaces").scrollIntoViewIfNeeded();
    await expect.poll(() => surfaceRequests).toBe(1);
    await expect(surfaces.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(
      page.getByText("Loading provider surfaces and probe records · registry"),
    ).toBeVisible();

    release?.();
    await expect(latency).not.toHaveAttribute("aria-busy", "true");
    await expect(surfaces.locator(".mg-dt-skeleton")).toHaveCount(0);
  });

  test("keeps a provider's registered surfaces visible when only its probe read fails", async ({
    page,
  }) => {
    let shouldFail = true;
    await page.route("**/api/v1/providers/lium/endpoints*", async (route) => {
      if (!shouldFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Endpoint probe fixture failed" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/providers/lium");

    const surfaces = page.getByRole("table", { name: "lium.io surfaces" });
    await expect(page.getByText("Couldn't load endpoint latency")).toBeVisible();
    await page.locator("section#surfaces").scrollIntoViewIfNeeded();
    const probeError = page.getByRole("alert").filter({ hasText: "provider endpoint probes" });
    await expect(probeError).toBeVisible();
    await expect(surfaces).toBeVisible();
    await expect(page.getByText("No surfaces are registered for this provider.")).toHaveCount(0);

    shouldFail = false;
    await probeError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(probeError).toHaveCount(0);
    await expect(page.getByRole("group", { name: "lium.io endpoint latency" })).toBeVisible();
  });
});
