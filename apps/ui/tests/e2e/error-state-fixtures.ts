import type { Page } from "@playwright/test";

export const ERROR_MESSAGE = `The upstream response could not be verified. ${"detail_".repeat(60)}`;
export const ERROR_API_ORIGIN = "http://127.0.0.1:8081";
const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const envelope = (data: unknown) => JSON.stringify({ ok: true, data });

/** Synthetic private records, with every request served by local fixtures. */
export async function prepareErrorStateFixture(
  page: Page,
  options: { retained?: boolean; status?: number; code?: string; network?: string } = {},
) {
  let unavailable = !options.retained;
  let requests = 0;
  await page.addInitScript(
    ({ address, network }) => {
      if (location.origin === "null") return;
      const expiresAtMs = Date.now() + 3_600_000;
      if (network) localStorage.setItem("metagraphed:network", network);
      window.injectedWeb3 = {
        fixture: {
          enable: async () => ({
            accounts: { get: async () => [{ address, name: "Fixture account" }] },
          }),
        },
      };
      localStorage.setItem("metagraphed:wallet", JSON.stringify({ address, source: "fixture" }));
      sessionStorage.setItem(
        "metagraphed:api-session",
        JSON.stringify({ token: "fixture-api-token", ss58: address, tier: "pro", expiresAtMs }),
      );
    },
    { address: OWNER, network: options.network },
  );

  await page.route(`${ERROR_API_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (/\/keys\/status$/.test(url.pathname)) {
      await route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) });
    } else if (/\/keys\/usage$/.test(url.pathname)) {
      await route.fulfill({
        contentType: "application/json",
        body: envelope({
          window_days: 7,
          tier: "pro",
          quota: null,
          days: [],
          top_routes: [],
          rejected_total: 0,
        }),
      });
    } else if (/\/keys$/.test(url.pathname)) {
      if (route.request().method() === "POST") {
        unavailable = true;
        await route.fulfill({
          contentType: "application/json",
          body: envelope({
            key: "fixture-one-time-key",
            key_id: "key_fixture_new",
            tier: "pro",
            created_at: 1_784_000_000_000,
          }),
        });
      } else {
        requests++;
        if (!unavailable) {
          await route.fulfill({
            contentType: "application/json",
            body: envelope({
              keys: options.retained
                ? [
                    {
                      key_id: "key_fixture_retained",
                      tier: "pro",
                      created_at: 1_784_000_000_000,
                      last_used_at: null,
                      revoked_at: null,
                    },
                  ]
                : [],
            }),
          });
        } else if (options.status === 0) {
          await route.abort("internetdisconnected");
        } else {
          await route.fulfill({
            status: options.status ?? 503,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: options.code ?? "upstream_unavailable", message: ERROR_MESSAGE },
              ...(options.network ? { meta: { network: options.network } } : {}),
            }),
          });
        }
      }
    } else {
      // All other reads use the same local fixture API as SSR.
      const response = await route.fetch({
        url: `http://127.0.0.1:8081${url.pathname}${url.search}`,
      });
      await route.fulfill({ response });
    }
  });
  return {
    recover: () => {
      unavailable = false;
    },
    requests: () => requests,
  };
}
