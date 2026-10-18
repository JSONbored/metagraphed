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

    const positions = page.getByRole("table", { name: "Recorded ties by subnet" });
    const flow = page.getByRole("group", { name: "Stake moved per subnet" });
    const counterparties = page.getByRole("group", {
      name: "Transfer counterparties by volume moved",
    });
    const activity = page.getByRole("table", { name: "Account events" });
    const keys = page.getByRole("group", { name: "Related keys" });

    await expect(positions.locator(".mg-dt-skeleton")).toHaveCount(8);
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
    await expect(positions.locator(".mg-dt-skeleton")).toHaveCount(0);
    await expect(counterparties).not.toHaveAttribute("aria-busy", "true");
    await expect(positions.getByRole("link", { name: "Apex", exact: true })).toBeVisible();
    await expect(positions.getByRole("link", { name: "Apex", exact: true })).toHaveAttribute(
      "href",
      "/subnets/1",
    );
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
    await expect(page.getByText("Couldn't load position snapshots")).toBeVisible();
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
    const positionsError = page.getByRole("alert").filter({ hasText: "position snapshots" });
    await positionsError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(positionsError).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Recorded ties by subnet" })).toBeVisible();
  });

  test("keeps relationships without accepting unqualified position amounts or shares", async ({
    page,
  }) => {
    await page.route(`**/api/v1/accounts/${SS58}/positions`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          ok: true,
          data: {
            ss58: SS58,
            captured_at: "2026-07-05T00:00:00Z",
            position_count: 4,
            total_stake_alpha: 100,
            positions: [
              { hotkey: "5A", netuid: 1, stake_tao: 10, share_fraction: 0.1 },
              { hotkey: "5B", netuid: 1, stake_tao: 30, share_fraction: 0.2 },
              { hotkey: "5A", netuid: 2, stake_tao: 60, share_fraction: 0.3 },
              { hotkey: "5C", netuid: 3, stake_tao: null, share_fraction: null },
            ],
          },
          meta: {},
        }),
      }),
    );
    await gotoThroughRestart(page, ROUTE);
    const positions = page.locator("#positions");
    const table = positions.getByRole("table", { name: "Recorded ties by subnet" });
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect(table.locator("tbody tr").first().getByRole("cell").last()).toHaveText("2");
    await expect(table).not.toContainText("α");
    await expect(table).not.toContainText("τ");
    await expect(table).not.toContainText("%");
    await expect(positions.getByText("Share of holdings", { exact: true })).toHaveCount(0);
    await expect(positions.locator("[data-mg-rails]")).toHaveCount(0);
    await expect(page.locator(".mg-fact").filter({ hasText: "Staked value" })).toContainText("—");
    await expect(page.locator(".mg-fact").filter({ hasText: "Staked value" })).not.toContainText(
      "τ",
    );
    await expect(page.getByText("Balance (free + reserved)", { exact: true })).toBeVisible();
    await expect(positions).toContainText("authoritative quantity basis");
    await expect(positions).toContainText("Root holdings are not covered");
    await expect(positions).toContainText("do not establish wallet holdings");
    await positions.getByRole("button", { name: "Show recorded relationships (4)" }).click();
    const relationships = positions.getByRole("table", { name: "Recorded position relationships" });
    await expect(relationships).toContainText("Hotkey");
    await expect(relationships).not.toContainText("Share");
    await expect(relationships).not.toContainText("α");
    await expect(relationships).not.toContainText("τ");
  });

  test("does not report empty holdings when a successful response declines coverage", async ({
    page,
  }) => {
    await page.route(`**/api/v1/accounts/${SS58}/positions`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          ok: true,
          data: {
            ss58: SS58,
            captured_at: null,
            position_count: 0,
            total_stake_alpha: 0,
            positions: [],
            degraded: {
              reason: "positions_unpriceable",
              snapshot_captured_at: "2026-07-01T00:00:00Z",
              latest_stake_event_at: null,
            },
          },
          meta: {},
        }),
      }),
    );
    await gotoThroughRestart(page, ROUTE);
    await expect(page.locator("#positions").getByRole("status")).toHaveText(
      "Position relationship coverage is unavailable.",
    );
    await expect(
      page.locator(".mg-fact").filter({ hasText: "Recorded ties / subnets" }),
    ).toContainText("—");
    await expect(
      page.getByText("No position relationships recorded in this response."),
    ).toHaveCount(0);
    await page.locator("#keys").scrollIntoViewIfNeeded();
    await expect(page.locator("#keys")).toContainText(
      "Incomplete position coverage · returned relationships only",
    );
  });
});
