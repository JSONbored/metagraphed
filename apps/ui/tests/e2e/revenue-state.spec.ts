import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const DETAIL_REVENUE = {
  schema_version: 1,
  netuid: 19,
  revenue: {
    netuid: 19,
    window_days: 1,
    emission: { basis: "tao_total", tao: 37.471356, usd: 1234.56, alternates: {} },
    revenue_usd: 2685.67,
    provenance: "chain-verified",
    searched_at: "2026-08-27T12:00:00.000Z",
    coverage_ratio: 0.51,
    subsidy_multiple: 1.9,
    sources: [
      {
        surface_id: "sn-19-revenue",
        provenance: "chain-verified",
        amount_usd: 2685.67,
        contributes: true,
        periods_observed: 1,
        periods_expected: 1,
      },
    ],
    verification: { verified: true, checks: [] },
  },
};

const DIRECTORY_REVENUE = {
  schema_version: 1,
  generated_at: "2026-08-27T12:00:00.000Z",
  window_days: 1,
  observed_count: 1,
  subnet_count: 129,
  subnets: [DETAIL_REVENUE.revenue],
};

test.describe("revenue evidence states", () => {
  test("keeps the subnet evidence ledger structured while its deferred read is pending", async ({
    page,
  }) => {
    let releaseRead: (() => void) | undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route("**/api/v1/subnets/19/revenue*", async (route) => {
      await readReleased;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(DETAIL_REVENUE),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets/19");
    const revenue = page.locator("#revenue");
    await revenue.scrollIntoViewIfNeeded();

    await expect(revenue.getByText("loading revenue evidence", { exact: true })).toBeVisible();
    await expect(revenue.locator('.mg-facts dd[aria-busy="true"]')).toHaveCount(5);
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);

    releaseRead?.();
    await expect(
      revenue.locator(".mg-facts").getByText("$2,685.67", { exact: true }),
    ).toBeVisible();
    await expect(revenue.locator('.mg-facts dd[aria-busy="true"]')).toHaveCount(0);
  });

  test("offers a retry instead of presenting a failed evidence read as missing revenue", async ({
    page,
  }) => {
    let shouldFail = true;
    await page.route("**/api/v1/subnets/19/revenue*", async (route) => {
      if (shouldFail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "temporarily_unavailable", message: "Revenue evidence is unavailable." },
            meta: {},
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(DETAIL_REVENUE),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets/19");
    const revenue = page.locator("#revenue");
    await revenue.scrollIntoViewIfNeeded();

    const error = revenue.getByRole("alert");
    await expect(error).toContainText("Couldn't load revenue evidence");
    shouldFail = false;
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      revenue.locator(".mg-facts").getByText("$2,685.67", { exact: true }),
    ).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test("keeps the network coverage denominator in a compact pending rail", async ({ page }) => {
    let releaseRead: (() => void) | undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route("**/api/v1/chain/revenue-coverage*", async (route) => {
      await readReleased;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(DIRECTORY_REVENUE),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets");
    const revenue = page.locator("#revenue");
    await revenue.scrollIntoViewIfNeeded();

    await expect(
      revenue.getByText("loading network revenue evidence", { exact: true }),
    ).toBeVisible();
    await expect(revenue.locator('.mg-facts dd[aria-busy="true"]')).toHaveCount(2);
    releaseRead?.();
    await expect(revenue.getByText("1 / 129", { exact: true })).toBeVisible();
  });
});
