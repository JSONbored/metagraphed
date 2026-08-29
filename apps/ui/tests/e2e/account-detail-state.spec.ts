import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const SS58 = "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9";
const ROUTE = `/accounts/${SS58}`;

test.describe("account detail query states", () => {
  test("defers below-fold account evidence while preserving its real loading geometry", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const requested: string[] = [];
    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1/accounts/${SS58}/*`, async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await continueReads;
      await route.continue();
    });

    await gotoThroughRestart(page, ROUTE);

    const positions = page.getByRole("group", { name: "Stake by subnet" });
    const flow = page.getByRole("group", { name: "Stake moved per subnet" });
    const counterparties = page.getByRole("group", {
      name: "Transfer counterparties by volume moved",
    });
    const activity = page.getByRole("table", { name: "Account events" });
    const keys = page.getByRole("group", { name: "Related keys" });

    await expect(positions).toHaveAttribute("aria-busy", "true");
    await expect(flow).toHaveAttribute("aria-busy", "true");
    await expect(counterparties).toHaveAttribute("aria-busy", "true");
    await expect(activity.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(keys).toHaveAttribute("aria-busy", "true");
    await expect(counterparties.locator(".mg-rails-row--skeleton")).toHaveCount(6);
    await expect(keys.locator(".mg-rank-grid-row--skeleton")).toHaveCount(4);
    await expect(
      page.getByText("gross transfer volume by counterparty · chain-direct"),
    ).toBeVisible();
    await expect(page.getByText("No positions recorded for this account.")).toHaveCount(0);
    await expect(page.getByText("No transfers recorded for this account.")).toHaveCount(0);
    expect(requested).not.toContain(`/api/v1/accounts/${SS58}/counterparties`);
    expect(requested).not.toContain(`/api/v1/accounts/${SS58}/events`);
    expect(requested).not.toContain(`/api/v1/accounts/${SS58}/children`);
    expect(requested).not.toContain(`/api/v1/accounts/${SS58}/parents`);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    await page
      .locator("#counterparties")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(counterparties).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => requested).toContain(`/api/v1/accounts/${SS58}/counterparties`);

    const completedReads = [...new Set(requested)].map((path) =>
      page.waitForResponse((response) => new URL(response.url()).pathname === path),
    );
    release?.();
    await Promise.all(completedReads);
    await expect(positions).not.toHaveAttribute("aria-busy", "true");
    await expect(counterparties).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("link", { name: /Trishool/i })).toBeVisible();
  });

  test("keeps unavailable account records actionable rather than calling them empty", async ({
    page,
  }) => {
    let shouldFail = true;
    await page.route(`**/api/v1/accounts/${SS58}/*`, async (route) => {
      if (!shouldFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Account detail fixture failed" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, ROUTE);

    await expect(page.getByRole("alert")).toHaveCount(2);
    await expect(page.getByText("Couldn't load live positions")).toBeVisible();
    await expect(page.getByText("Couldn't load stake movement")).toBeVisible();
    await expect(page.getByText("Couldn't load transfer counterparties")).toHaveCount(0);
    await expect(page.getByText("Couldn't load account events")).toHaveCount(0);
    await expect(page.getByText("Couldn't load related key relationships")).toHaveCount(0);

    await page.locator("#counterparties").scrollIntoViewIfNeeded();
    await expect(page.getByText("Couldn't load transfer counterparties")).toBeVisible();

    await page.locator("#activity").scrollIntoViewIfNeeded();
    await expect(page.getByText("Couldn't load account events")).toBeVisible();

    await page.locator("#keys").scrollIntoViewIfNeeded();
    await expect(page.getByText("Couldn't load related key relationships")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(5);
    await expect(page.getByText("No positions recorded for this account.")).toHaveCount(0);
    await expect(page.getByText("No transfers recorded for this account.")).toHaveCount(0);
    await expect(page.getByText("No events match this filter.")).toHaveCount(0);

    shouldFail = false;
    const positionsError = page.getByRole("alert").filter({ hasText: "live positions" });
    await positionsError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(positionsError).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Stake by subnet" })).toBeVisible();
  });
});
