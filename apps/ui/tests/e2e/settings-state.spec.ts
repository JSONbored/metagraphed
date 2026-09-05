import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

async function signInAsOwner(page: Page, connected = true) {
  await page.addInitScript(
    ({ address, connected }) => {
      // A supervised server restart can briefly navigate to an opaque error
      // document. Seed storage only once the app origin is available.
      if (window.location.origin === "null") return;
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
            signer: { signRaw: async () => ({ id: 1, signature: "0x00" }) },
          }),
        },
      };
      if (connected) {
        localStorage.setItem("metagraphed:wallet", JSON.stringify({ address, source: "fixture" }));
      } else {
        localStorage.removeItem("metagraphed:wallet");
      }
      localStorage.setItem(
        "metagraphed:watch-token",
        JSON.stringify({ token: "fixture-watch-token", ss58: address, expiresAtMs }),
      );
      sessionStorage.setItem(
        "metagraphed:api-session",
        JSON.stringify({ token: "fixture-api-token", ss58: address, tier: "pro", expiresAtMs }),
      );
    },
    { address: OWNER, connected },
  );
}

function envelope(data: unknown) {
  return JSON.stringify({ ok: true, data });
}

test.describe("Settings record states", () => {
  for (const connected of [false, true]) {
    test(`hydrates wallet panels without replacing their first interaction (${connected ? "saved wallet" : "installed extension"})`, async ({
      page,
    }) => {
      await signInAsOwner(page, connected);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: 12 });
      await gotoThroughRestart(page, connected ? "/settings#keys" : "/settings#alerts");
      if (connected) {
        await expect(
          page.locator("#keys").getByRole("group", { name: "API key management" }),
        ).toBeVisible();
      } else {
        const trigger = page
          .locator("#alerts")
          .getByRole("button", { name: "Connect wallet", exact: true });
        // A single real pointer interaction must survive nested hydration.
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const popoverId = await trigger.getAttribute("aria-controls");
        await expect(
          page
            .locator(`[id="${popoverId}"]`)
            .getByRole("button", { name: "Connect Wallet", exact: true }),
        ).toBeVisible();
      }
      expect(errors).toEqual([]);
    });
  }

  for (const section of ["keys", "alerts"]) {
    test(`connects a wallet from ${section} without requesting a signature`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.addInitScript((address) => {
        localStorage.removeItem("metagraphed:wallet");
        window.injectedWeb3 = {
          fixture: {
            enable: async () => ({
              accounts: { get: async () => [{ address, name: "Fixture account" }] },
              signer: {
                signRaw: async () => {
                  throw new Error("Connecting must not request a signature");
                },
              },
            }),
          },
        };
      }, OWNER);
      const authRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && /\/api\/v1\//.test(request.url())) {
          authRequests.push(request.url());
        }
      });

      await gotoThroughRestart(page, `/settings#${section}`);
      const panel = page.locator(`#${section}`);
      const trigger = panel.getByRole("button", { name: "Connect wallet", exact: true });
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(trigger).toHaveAttribute("aria-controls", /.+/);
      const popoverId = await trigger.getAttribute("aria-controls");
      expect(popoverId).toBeTruthy();
      await page
        .locator(`[id="${popoverId}"]`)
        .getByRole("button", { name: "Connect Wallet", exact: true })
        .click();
      await expect(panel.getByRole("button", { name: "Sign in with wallet" })).toBeFocused();
      await expect(trigger).toHaveCount(0);
      expect(authRequests).toEqual([]);
      await expect(
        page.getByText("Connect a wallet from the header above", { exact: false }),
      ).toHaveCount(0);
    });
  }

  for (const [section, group] of [
    ["keys", "API key management"],
    ["alerts", "Alert management"],
  ]) {
    test(`returns focus to ${section} when a stored session restores after connecting`, async ({
      page,
    }) => {
      await signInAsOwner(page, false);
      await gotoThroughRestart(page, `/settings#${section}`);
      const panel = page.locator(`#${section}`);
      const trigger = panel.getByRole("button", { name: "Connect wallet", exact: true });
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(trigger).toHaveAttribute("aria-controls", /.+/);
      const popoverId = await trigger.getAttribute("aria-controls");
      await page
        .locator(`[id="${popoverId}"]`)
        .getByRole("button", { name: "Connect Wallet", exact: true })
        .click();
      await expect(panel.getByRole("group", { name: group, exact: true })).toBeFocused();
    });
  }

  test("does not move focus when an already connected wallet opens settings", async ({ page }) => {
    await signInAsOwner(page);
    await gotoThroughRestart(page, "/settings");
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await expect(
      page.locator("#keys").getByRole("button", { name: "Connect wallet", exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  });

  test("offers wallet setup from the API-key panel when no extension is available", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/settings#keys");
    const trigger = page.locator("#keys").getByRole("button", { name: "Connect wallet" });
    await trigger.click();
    await expect(page.getByRole("link", { name: "Talisman", exact: true }).last()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const size = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(size.page).toBeLessThanOrEqual(size.viewport);
  });

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

    await gotoThroughRestart(page, "/settings#keys");

    const keys = page.locator("#keys");
    const alerts = page.locator("#alerts");
    const keysError = keys.getByRole("alert").filter({ hasText: "Couldn't load API keys" });
    const triggersError = alerts
      .getByRole("alert")
      .filter({ hasText: "Couldn't load alert triggers" });
    const devicesError = alerts
      .getByRole("alert")
      .filter({ hasText: "Couldn't load push devices" });
    await expect(keysError).toBeVisible();
    await page.getByRole("link", { name: "Watchlists & alerts", exact: true }).click();
    await expect(triggersError).toBeVisible();
    await expect(devicesError).toBeVisible();
    await expect(alerts.getByText("Push devices · —/—")).toBeVisible();
    await expect(keys.getByText("No active keys", { exact: true })).toHaveCount(0);
    await expect(alerts.getByText("No alerts yet", { exact: true })).toHaveCount(0);
    await expect(alerts.getByText("No devices yet.", { exact: false })).toHaveCount(0);

    unavailable = false;
    await page.getByRole("link", { name: "Developer access", exact: true }).click();
    await keysError.getByRole("button", { name: "Retry" }).click();
    await expect(keys.getByText("No active keys", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Watchlists & alerts", exact: true }).click();
    await triggersError.getByRole("button", { name: "Retry" }).click();
    await devicesError.getByRole("button", { name: "Retry" }).click();

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

    await gotoThroughRestart(page, "/settings#keys");
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

    await gotoThroughRestart(page, "/settings#alerts");
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

test.describe("API-key revocation states", () => {
  for (const width of [375, 1280]) {
    test(`refreshes pending revocation after failure and completes a retry (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 812 });
      await signInAsOwner(page);
      let state: "active" | "pending" | "revoked" = "active";
      let lists = 0;
      let deletes = 0;
      await page.route("**/api/v1/keys", async (route) => {
        lists++;
        await route.fulfill({
          contentType: "application/json",
          body: envelope({
            keys: [
              {
                key_id: "key_fixture_revocation",
                tier: "pro",
                created_at: 1_784_000_000_000,
                last_used_at: null,
                revoked_at: state === "revoked" ? 1_784_000_100_000 : null,
                // The first response deliberately has the older contract.
                ...(state === "active"
                  ? {}
                  : { revocation_state: state, revocation_requested_at: 1_784_000_050_000 }),
              },
            ],
          }),
        });
      });
      await page.route("**/api/v1/keys/status", (route) =>
        route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) }),
      );
      await page.route("**/api/v1/keys/usage", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: envelope({
            window_days: 7,
            tier: "pro",
            quota: null,
            days: [],
            top_routes: [],
            rejected_total: 0,
          }),
        }),
      );
      await page.route("**/api/v1/keys/key_fixture_revocation", async (route) => {
        expect(route.request().method()).toBe("DELETE");
        deletes++;
        state = deletes === 1 ? "pending" : "revoked";
        await route.fulfill({
          status: deletes === 1 ? 502 : 200,
          contentType: "application/json",
          body:
            deletes === 1
              ? JSON.stringify({
                  error: {
                    code: "KEY_REVOCATION_PENDING",
                    message: "Key access is disabled. Revocation confirmation is pending; retry.",
                  },
                  key_id: "key_fixture_revocation",
                  revoked: false,
                  revocation_state: "pending",
                  access_disabled: true,
                })
              : envelope({ key_id: "key_fixture_revocation", revoked: true }),
        });
      });
      await gotoThroughRestart(page, "/settings#keys");
      const keys = page.locator("#keys");
      await expect(
        keys.getByText("1 active · 0 pending revocation", { exact: true }),
      ).toBeVisible();
      await keys.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(
        keys.getByRole("alert").filter({ hasText: "Key access is disabled." }),
      ).toBeVisible();
      await expect(keys.getByText("Revocation pending", { exact: true })).toBeVisible();
      await expect(
        keys.getByText("0 active · 1 pending revocation", { exact: true }),
      ).toBeVisible();
      expect(lists).toBeGreaterThanOrEqual(2);
      const retry = keys.getByRole("button", { name: "Retry revocation", exact: true });
      await expect(retry).toBeEnabled();
      await retry.click();
      await expect(keys.getByText("No active keys", { exact: true })).toBeVisible();
      await expect(keys.getByText("Revocation pending", { exact: true })).toHaveCount(0);
      await expect(
        keys.getByRole("alert").filter({ hasText: "Key access is disabled." }),
      ).toHaveCount(0);
      expect(deletes).toBe(2);
      expect(lists).toBeGreaterThanOrEqual(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }

  for (const refresh of ["failed", "stale", "omitted"] as const) {
    test(`preserves pending and completed revocation across ${refresh} list refreshes`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await signInAsOwner(page);
      let deletes = 0;
      let lists = 0;
      await page.route("**/api/v1/keys", async (route) => {
        lists++;
        if (deletes > 0 && refresh === "failed")
          return route.fulfill({ status: 503, body: "fixture unavailable" });
        if (refresh === "omitted" && lists === 2) {
          return route.fulfill({ contentType: "application/json", body: envelope({ keys: [] }) });
        }
        // Even after DELETE this endpoint deliberately returns an old active record.
        await route.fulfill({
          contentType: "application/json",
          body: envelope({
            keys: [
              {
                key_id: "key_fixture_refresh",
                tier: "pro",
                created_at: 1_784_000_000_000,
                last_used_at: null,
                revoked_at: null,
              },
            ],
          }),
        });
      });
      await page.route("**/api/v1/keys/status", (route) =>
        route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) }),
      );
      await page.route("**/api/v1/keys/usage", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: envelope({
            window_days: 7,
            tier: "pro",
            quota: null,
            days: [],
            top_routes: [],
            rejected_total: 0,
          }),
        }),
      );
      await page.route("**/api/v1/keys/key_fixture_refresh", async (route) => {
        deletes++;
        await route.fulfill({
          status: deletes === 1 ? 502 : 200,
          contentType: "application/json",
          body:
            deletes === 1
              ? JSON.stringify({
                  error: {
                    code: "KEY_REVOCATION_PENDING",
                    message: "Key access is disabled. Revocation confirmation is pending; retry.",
                  },
                })
              : envelope({ key_id: "key_fixture_refresh", revoked: true }),
        });
      });
      await gotoThroughRestart(page, "/settings#keys");
      const keys = page.locator("#keys");
      await keys.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(
        keys.getByText("0 active · 1 pending revocation", { exact: true }),
      ).toBeVisible();
      const retry = keys.getByRole("button", { name: "Retry revocation", exact: true });
      await expect(retry).toBeEnabled();
      expect(lists).toBeGreaterThanOrEqual(2);
      const error = keys.getByRole("alert").filter({ hasText: "Couldn't load API keys" });
      if (refresh === "failed") await expect(error).toBeVisible();
      await retry.click();
      await expect(keys.getByText("No active keys", { exact: true })).toBeVisible();
      await expect(keys.getByText("Revocation pending", { exact: true })).toHaveCount(0);
      await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
      expect(lists).toBeGreaterThanOrEqual(3);
      if (refresh === "failed") {
        await expect(error).toBeVisible();
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(() => lists).toBeGreaterThanOrEqual(4);
        await expect(keys.getByText("No active keys", { exact: true })).toBeVisible();
      }
    });
  }

  test("does not claim disabled access after an unrelated revocation error", async ({ page }) => {
    await signInAsOwner(page);
    await page.route("**/api/v1/keys", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: envelope({
          keys: [
            {
              key_id: "key_fixture_generic",
              tier: "pro",
              created_at: 1_784_000_000_000,
              last_used_at: null,
              revoked_at: null,
            },
          ],
        }),
      }),
    );
    await page.route("**/api/v1/keys/status", (route) =>
      route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) }),
    );
    await page.route("**/api/v1/keys/usage", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: envelope({
          window_days: 7,
          tier: "pro",
          quota: null,
          days: [],
          top_routes: [],
          rejected_total: 0,
        }),
      }),
    );
    await page.route("**/api/v1/keys/key_fixture_generic", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "Revocation is unavailable. Try again." },
        }),
      }),
    );
    await gotoThroughRestart(page, "/settings#keys");
    const keys = page.locator("#keys");
    await keys.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(
      keys.getByRole("alert").filter({ hasText: "Revocation is unavailable." }),
    ).toBeVisible();
    await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
    await expect(keys.getByText("1 active · 0 pending revocation", { exact: true })).toBeVisible();
    await expect(keys.getByText("Access is disabled", { exact: false })).toHaveCount(0);
  });

  test("treats timestamp-only pending keys as disabled and hides confirmed rows without loading usage", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsOwner(page);
    let usageRequests = 0;
    const pending = {
      key_id: "key_fixture_pending",
      tier: "pro",
      created_at: 1_784_000_000_000,
      last_used_at: null,
      revoked_at: null,
      revocation_requested_at: 0,
    };
    await page.route("**/api/v1/keys", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: envelope({
          keys: [
            pending,
            {
              ...pending,
              key_id: "key_fixture_confirmed",
              revoked_at: 0,
              revocation_state: "pending",
            },
          ],
        }),
      }),
    );
    await page.route("**/api/v1/keys/status", (route) =>
      route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) }),
    );
    await page.route("**/api/v1/keys/usage", (route) => {
      usageRequests++;
      return route.fulfill({ status: 503 });
    });
    await gotoThroughRestart(page, "/settings#keys");
    const keys = page.locator("#keys");
    await expect(keys.getByText("0 active · 1 pending revocation", { exact: true })).toBeVisible();
    const retry = keys.getByRole("button", { name: "Retry revocation", exact: true });
    await expect(retry).toBeVisible();
    await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
    await expect(keys.getByText("key_fixture_confirmed", { exact: true })).toHaveCount(0);
    expect(usageRequests).toBe(0);
    const bounds = await retry.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
  test("does not carry a previous session's pending state or error into a new session", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const sessions: string[] = [];
    await page.route("**/api/v1/keys", (route) => {
      sessions.push(route.request().headers().authorization);
      return route.fulfill({
        contentType: "application/json",
        body: envelope({
          keys: [
            {
              key_id: "key_fixture_session",
              tier: "pro",
              created_at: 1_784_000_000_000,
              last_used_at: null,
              revoked_at: null,
            },
          ],
        }),
      });
    });
    await page.route("**/api/v1/keys/status", (route) =>
      route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) }),
    );
    await page.route("**/api/v1/keys/usage", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: envelope({
          window_days: 7,
          tier: "pro",
          quota: null,
          days: [],
          top_routes: [],
          rejected_total: 0,
        }),
      }),
    );
    await page.route("**/api/v1/keys/key_fixture_session", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "KEY_REVOCATION_PENDING",
            message: "Key access is disabled. Revocation confirmation is pending; retry.",
          },
        }),
      }),
    );
    await page.route("**/api/v1/auth/wallet/challenge", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: envelope({ message: "Fixture challenge", expires_in_seconds: 60 }),
      }),
    );
    await page.route("**/api/v1/auth/wallet/verify", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: envelope({
          session_token: "fixture-second-session",
          expires_in_seconds: 3600,
          account: { ss58: OWNER, tier: "pro" },
        }),
      }),
    );
    await gotoThroughRestart(page, "/settings#keys");
    const keys = page.locator("#keys");
    await keys.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(keys.getByRole("button", { name: "Retry revocation", exact: true })).toBeEnabled();
    await keys.getByRole("button", { name: "Sign out", exact: true }).click();
    await keys.getByRole("button", { name: "Sign in with wallet", exact: true }).click();
    await expect(keys.getByText("1 active · 0 pending revocation", { exact: true })).toBeVisible();
    await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
    await expect(
      keys.getByRole("alert").filter({ hasText: "Key access is disabled." }),
    ).toHaveCount(0);
    expect(sessions).toContain("Bearer fixture-api-token");
    expect(sessions).toContain("Bearer fixture-second-session");
  });
});
