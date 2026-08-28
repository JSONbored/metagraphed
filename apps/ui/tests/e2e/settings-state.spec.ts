import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

async function signInAsOwner(page: Page) {
  await page.addInitScript((address) => {
    const expiresAtMs = Date.now() + 60 * 60 * 1000;
    // useWallet rechecks stored accounts after hydration. Supply the smallest
    // compliant extension shape so that this fixture verifies the same
    // signed-in state a reader reaches, rather than bypassing the check.
    window.injectedWeb3 = {
      fixture: {
        enable: async () => ({
          accounts: {
            get: async () => [{ address, name: "Fixture account" }],
          },
        }),
      },
    };
    localStorage.setItem("metagraphed:wallet", JSON.stringify({ address, source: "fixture" }));
    localStorage.setItem(
      "metagraphed:watch-token",
      JSON.stringify({ token: "fixture-watch-token", ss58: address, expiresAtMs }),
    );
    sessionStorage.setItem(
      "metagraphed:api-session",
      JSON.stringify({ token: "fixture-api-token", ss58: address, tier: "pro", expiresAtMs }),
    );
  }, OWNER);
}

function envelope(data: unknown) {
  return JSON.stringify({ ok: true, data });
}

test.describe("Settings record states", () => {
  test("does not turn failed private records into empty lists or a default device cap", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsOwner(page);

    let unavailable = true;
    await page.route("**/api/v1/keys", async (route) => {
      if (unavailable) {
        await route.fulfill({ status: 503, body: "key fixture unavailable" });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: envelope({ keys: [] }) });
    });
    await page.route("**/api/v1/keys/status", async (route) => {
      await route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) });
    });
    await page.route("**/api/v1/watch/triggers", async (route) => {
      if (unavailable) {
        await route.fulfill({ status: 503, body: "alert fixture unavailable" });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: envelope({ triggers: [] }) });
    });
    await page.route("**/api/v1/watch/push-subscriptions", async (route) => {
      if (unavailable) {
        await route.fulfill({ status: 503, body: "push fixture unavailable" });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: envelope({ subscriptions: [], max_devices: 3 }),
      });
    });

    await gotoThroughRestart(page, "/settings");

    const keys = page.locator("#keys");
    const alerts = page.locator("#alerts");
    const keysError = keys.getByRole("alert").filter({ hasText: "Couldn't load active API keys" });
    const triggersError = alerts
      .getByRole("alert")
      .filter({ hasText: "Couldn't load alert triggers" });
    const devicesError = alerts
      .getByRole("alert")
      .filter({ hasText: "Couldn't load push devices" });
    await expect(keysError).toBeVisible();
    await expect(triggersError).toBeVisible();
    await expect(devicesError).toBeVisible();
    await expect(alerts.getByText("Push devices · —/—")).toBeVisible();
    await expect(keys.getByText("No active keys", { exact: true })).toHaveCount(0);
    await expect(alerts.getByText("No alerts yet", { exact: true })).toHaveCount(0);
    await expect(alerts.getByText("No devices yet.", { exact: false })).toHaveCount(0);

    unavailable = false;
    await keysError.getByRole("button", { name: "Retry" }).click();
    await triggersError.getByRole("button", { name: "Retry" }).click();
    await devicesError.getByRole("button", { name: "Retry" }).click();

    await expect(keys.getByText("No active keys", { exact: true })).toBeVisible();
    await expect(alerts.getByText("No alerts yet", { exact: true })).toBeVisible();
    await expect(alerts.getByText("Push devices · 0/3")).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("keeps API-key usage structured while it loads and gives it an independent retry", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsOwner(page);

    await page.route("**/api/v1/keys", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: envelope({
          keys: [
            {
              key_id: "fixture-key",
              tier: "pro",
              created_at: 1_784_000_000_000,
              revoked_at: null,
              last_used_at: null,
            },
          ],
        }),
      });
    });
    await page.route("**/api/v1/keys/status", async (route) => {
      await route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) });
    });
    await page.route("**/api/v1/watch/triggers", async (route) => {
      await route.fulfill({ contentType: "application/json", body: envelope({ triggers: [] }) });
    });
    await page.route("**/api/v1/watch/push-subscriptions", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: envelope({ subscriptions: [], max_devices: 3 }),
      });
    });

    let releaseUsage: (() => void) | undefined;
    const usageStarted = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    let usageAvailable = false;
    await page.route("**/api/v1/keys/usage", async (route) => {
      if (!usageAvailable) {
        await usageStarted;
        await route.fulfill({ status: 503, body: "usage fixture unavailable" });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: envelope({
          window_days: 7,
          tier: "pro",
          quota: null,
          days: [
            { day: "2026-08-25", count: 16, rejected: 0 },
            { day: "2026-08-26", count: 24, rejected: 0 },
          ],
          top_routes: [{ route: "/api/v1/subnets", count: 24, rejected: 0 }],
          rejected_total: 0,
        }),
      });
    });

    await gotoThroughRestart(page, "/settings");
    const keys = page.locator("#keys");
    await expect(keys.getByRole("group", { name: "Loading API-key usage" })).toBeVisible();
    await expect(keys.locator(".mg-line [aria-busy='true']")).toHaveCount(1);

    releaseUsage?.();
    const usageError = keys.getByRole("alert").filter({ hasText: "Couldn't load API-key usage" });
    await expect(usageError).toBeVisible();

    usageAvailable = true;
    await usageError.getByRole("button", { name: "Retry" }).click();
    await expect(keys.getByText("Usage, last 7d", { exact: true })).toBeVisible();
    await expect(
      keys.getByRole("table", { name: "Daily request count, last 7 days" }),
    ).toBeVisible();
  });

  test("keeps a selected alert's delivery history independently recoverable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsOwner(page);

    await page.route("**/api/v1/keys", async (route) => {
      await route.fulfill({ contentType: "application/json", body: envelope({ keys: [] }) });
    });
    await page.route("**/api/v1/keys/status", async (route) => {
      await route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) });
    });
    await page.route("**/api/v1/watch/push-subscriptions", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: envelope({ subscriptions: [], max_devices: 3 }),
      });
    });
    await page.route("**/api/v1/watch/triggers", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: envelope({
          triggers: [
            {
              id: "fixture-trigger",
              name: "Fixture rule",
              table_filter: null,
              netuid: 19,
              event_kind: null,
              account: null,
              min_amount_tao: null,
              condition: null,
              channel: "webhook",
              destination: "https://example.test/alerts",
              active: true,
              created_at: 1_784_000_000_000,
              updated_at: 1_784_000_000_000,
              last_matched_at: null,
              match_count: 0,
              owner_ss58: OWNER,
            },
          ],
        }),
      });
    });

    let deliveriesAvailable = false;
    await page.route("**/api/v1/watch/triggers/fixture-trigger/deliveries", async (route) => {
      if (!deliveriesAvailable) {
        await route.fulfill({ status: 503, body: "deliveries fixture unavailable" });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: envelope({ deliveries: [] }) });
    });

    await gotoThroughRestart(page, "/settings");
    const alerts = page.locator("#alerts");
    const triggerTable = alerts.getByRole("table", { name: "Alert triggers" });
    await triggerTable.getByRole("button", { name: "Expand row" }).click();

    const deliveriesError = alerts
      .getByRole("alert")
      .filter({ hasText: "Couldn't load alert deliveries" });
    await expect(deliveriesError).toBeVisible();
    await expect(alerts.getByText("No deliveries recorded yet", { exact: false })).toHaveCount(0);

    deliveriesAvailable = true;
    await deliveriesError.getByRole("button", { name: "Retry" }).click();
    await expect(alerts.getByText("No deliveries recorded yet", { exact: false })).toBeVisible();
  });
});
