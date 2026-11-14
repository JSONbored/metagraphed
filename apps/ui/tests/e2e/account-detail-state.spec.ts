import { modernStakeFixture } from "./modern-explorer-fixture";
import { ss58AccountId } from "../../src/lib/metagraphed/accounts";
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
    await page.route("**/api/v2/**/accounts/*/{events,stake}*", async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await continueReads;
      await route.continue();
    });

    await gotoThroughRestart(page, ROUTE);

    const positions = page.getByRole("table", { name: "Account stake and entitlements" });
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
    expect(requested.some((path) => path.startsWith("/api/v2/") && path.endsWith("/events"))).toBe(
      false,
    );
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
    await positions.scrollIntoViewIfNeeded();
    await expect(positions).toContainText("Root TAO");
    await expect(positions).toContainText("18446744073709551615 rao");
    await expect(positions).not.toContainText("Apex");
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
    await page.route("**/api/v2/**/accounts/*/{events,stake}*", async (route) => {
      if (!shouldFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          api_version: "2",
          error: { code: "data_unavailable", message: "Controlled account activity unavailable" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, ROUTE);

    await page.locator("#positions").scrollIntoViewIfNeeded();
    await expect(page.locator("#positions").getByRole("alert")).toContainText(
      "Couldn't load account stake",
    );
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
    await expect(page.getByText(/No matching typed account appearances/)).toHaveCount(0);

    shouldFail = false;
    const positionsError = page.getByRole("alert").filter({ hasText: "account stake" });
    await positionsError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(positionsError).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Account stake and entitlements" })).toBeVisible();
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
    const table = positions.getByRole("table", { name: "Account stake and entitlements" });
    await positions.scrollIntoViewIfNeeded();
    await expect(table.locator(".mg-dt-row:not(.mg-dt-skeleton)")).toHaveCount(10);
    await expect(table).toContainText("18446744073709551615 rao");
    await expect(table).toContainText("Root entitlement");
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
    await expect(positions).toContainText(
      "Liquid balances and combined TAO valuation are not supplied",
    );
    await expect(positions).toContainText("must not be added together");
    await expect(positions).not.toContainText("Root holdings are not covered");
    await expect(table).not.toContainText("5A");
    await expect(table).toContainText("Hotkey");
  });

  for (const { width, height } of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    for (const theme of ["light", "dark"]) {
      test(`keeps Root-only activity distinct from absent position records at ${width}px in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await page.addInitScript((value) => localStorage.setItem("mg-theme", value), theme);
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
                position_count: 0,
                total_stake_alpha: 0,
                positions: [],
              },
              meta: {},
            }),
          }),
        );
        await page.route(`**/api/v1/accounts/${SS58}/stake-flow?*`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({
              ok: true,
              data: {
                ss58: SS58,
                window: "30d",
                total_staked_tao: 25,
                total_unstaked_tao: 0,
                net_flow_tao: 25,
                gross_flow_tao: 25,
                direction: "accumulating",
                subnet_count: 1,
                subnets: [{ netuid: 0, staked_tao: 25, unstaked_tao: 0 }],
              },
              meta: {},
            }),
          }),
        );

        await page.route("**/api/v2/**/accounts/*/stake*", (route) => {
          const value = modernStakeFixture(ss58AccountId(SS58)!);
          value.entries = value.entries.filter((entry) => entry.kind === "root_entitlement");
          for (const entry of value.entries)
            if (entry.kind === "root_entitlement") {
              entry.entitlement.principal = { status: "absent_in_complete_join" };
              if (entry.entitlement.outcome.status === "assessed")
                entry.entitlement.outcome.value.root_principal_rao = "0";
            }
          value.next_cursor = null;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(value),
          });
        });
        await gotoThroughRestart(page, ROUTE);
        const positions = page.locator("#positions");
        await positions.scrollIntoViewIfNeeded();
        await expect(positions).toContainText(
          "Loaded 0 position records and 1 root entitlement records",
        );
        await expect(positions).toContainText("No root principal entry in the complete census");
        await expect(positions).toContainText("49 rao deferred cash");
        await expect(positions).toContainText("Census at block");
        await expect(positions).not.toContainText("Share of holdings");
        const capital = page.locator(".mg-fact").filter({ hasText: "Staked value" });
        await expect(capital).toContainText("—");
        await expect(capital).not.toContainText("τ");
        await expect(page.locator('#flow a[href="/subnets/0"]')).toBeVisible();
        await expect(page.getByText("No positions recorded for this account.")).toHaveCount(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      });
    }
  }

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
    await page.route("**/api/v2/**/accounts/*/stake*", (route) => {
      const value = modernStakeFixture(ss58AccountId(SS58)!);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...value,
          stake: { ...value.stake, census_complete: false },
          entries: [],
          next_cursor: null,
        }),
      });
    });
    await gotoThroughRestart(page, ROUTE);
    await page.locator("#positions").scrollIntoViewIfNeeded();
    await expect(page.locator("#positions").getByRole("alert")).toContainText(
      "Published account stake is unavailable",
    );
    await expect(page.locator("#positions")).not.toContainText(
      "No stake positions or root entitlements",
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
