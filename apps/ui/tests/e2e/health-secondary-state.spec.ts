import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Health secondary query states", () => {
  test("defers the bulk uptime trends while preserving a self-health loading instrument", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    let trendRequests = 0;
    for (const pattern of ["**/api/v1/health/trends*", "**/api/v1/self-health*"]) {
      await page.route(pattern, async (route) => {
        if (new URL(route.request().url()).pathname === "/api/v1/health/trends") trendRequests += 1;
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, "/health");

    const subnetUptime = page.getByRole("group", { name: "Subnet uptime, worst first" });
    const selfHealth = page.getByRole("group", { name: "metagraphed's own component uptime" });
    await expect(selfHealth).toHaveAttribute("aria-busy", "true");
    await expect(selfHealth.locator(".mg-rails-row--skeleton")).toHaveCount(4);
    await expect(page.getByText("Loading self-health · self-probed")).toBeVisible();
    await expect(page.getByText("Uptime evidence loads as this section approaches.")).toBeVisible();
    expect(trendRequests).toBe(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    await page.locator("section#by-subnet").scrollIntoViewIfNeeded();
    await expect.poll(() => trendRequests).toBe(1);
    // A resolved LineWithWindow names its interactive plot with the measured
    // value and delta, while the skeleton names the pending series. The plot
    // is the stable visual landmark across that truthful name transition.
    const trend = page.locator("#trend .mg-line-plot");
    await expect(subnetUptime).toHaveAttribute("aria-busy", "true");
    await expect(trend).toHaveAttribute("aria-busy", "true");
    await expect(subnetUptime.locator(".mg-rails-row--skeleton")).toHaveCount(8);
    await expect(page.getByText("Loading 7d uptime · probe-derived")).toBeVisible();
    await expect(page.getByText("Loading 7d trend · probe-derived")).toBeVisible();

    release?.();
    await expect(subnetUptime).not.toHaveAttribute("aria-busy", "true");
    await expect(trend).not.toHaveAttribute("aria-busy", "true");
    await expect(selfHealth).not.toHaveAttribute("aria-busy", "true");
  });

  test("keeps unavailable health instruments distinct from no incidents or no probes", async ({
    page,
  }) => {
    let shouldFail = true;
    for (const pattern of [
      "**/api/v1/incidents*",
      "**/api/v1/health/trends*",
      "**/api/v1/self-health*",
    ]) {
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
            error: { code: "fixture_failure", message: "Health fixture failed" },
          }),
        });
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/health");
    await page.locator("section#by-subnet").scrollIntoViewIfNeeded();

    await expect(page.getByRole("alert")).toHaveCount(3);
    await expect(page.getByText("Couldn't load recorded incidents")).toBeVisible();
    await expect(page.getByText("Couldn't load subnet uptime")).toBeVisible();
    await expect(page.getByText("Couldn't load self-health")).toBeVisible();
    await expect(
      page.getByText("No incident records are currently open in this window."),
    ).toHaveCount(0);
    await expect(
      page.getByText("Health trend unavailable. Retry the uptime reading above."),
    ).toBeVisible();
    await expect(
      page.getByText("Recorded incidents are temporarily unavailable · probe-derived"),
    ).toBeVisible();

    shouldFail = false;
    const incidentError = page.getByRole("alert").filter({ hasText: "recorded incidents" });
    await incidentError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(incidentError).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Recorded surface incidents" })).toBeVisible();
  });
});
