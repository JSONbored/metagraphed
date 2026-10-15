import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";
import { EVIDENCE_HASH, FAILED_PROXY_HASH, UNINDEXED_HASH } from "./extrinsic-evidence-fixture.ts";

const HASH = "0x986f1f7da3d93882e8c19bbe3b303ef8ba5454062272446598d17aa599ca4428";
const ROUTE = `/extrinsics/${HASH}`;

test.describe("extrinsic detail raw-event continuation", () => {
  test("starts related-call evidence only when the reader reaches it", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let peerRequests = 0;
    await page.route("**/api/v1/extrinsics?*", async (route) => {
      peerRequests += 1;
      await route.continue();
    });

    await gotoThroughRestart(page, ROUTE);
    const peers = page.getByRole("table", { name: /This signer's other recent calls/ });
    await expect(peers.locator(".mg-dt-skeleton")).toHaveCount(8);
    expect(peerRequests).toBe(0);

    await page.locator("[data-mg-extrinsic-peer]").scrollIntoViewIfNeeded();
    await expect.poll(() => peerRequests).toBe(1);
    await expect(peers).toBeVisible();
  });

  test("offers and completes the deferred event-record continuation without mobile overflow", async ({
    page,
  }) => {
    const allEvents = await page.request.get(
      "http://127.0.0.1:8081/api/v1/blocks/8713384/chain-events",
    );
    expect(allEvents.ok()).toBe(true);
    const allEventsBody = (await allEvents.json()) as {
      data: { events: Array<Record<string, unknown>> };
    };
    const nextEvent = allEventsBody.data.events.find((event) => event.event_index === 241);
    expect(nextEvent).toBeTruthy();

    const initialEvents = allEventsBody.data.events
      .filter((event) => event.event_index !== 241)
      .slice(0, 10);
    expect(initialEvents).toHaveLength(10);

    await page.route("**/api/v1/chain-events?*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("cursor")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            schema_version: 1,
            data: {
              count: initialEvents.length,
              next_cursor: "fixture-next-page",
              next_before: null,
              events: initialEvents,
            },
            meta: { source: "fixture" },
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          schema_version: 1,
          data: { count: 1, next_cursor: null, next_before: null, events: [nextEvent] },
          meta: { source: "fixture" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, ROUTE);
    const eventTable = page.getByRole("table", { name: /What it produced/ });
    await expect(eventTable).toBeVisible();
    const loadMore = page.getByRole("button", { name: "Load more", exact: true });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(loadMore).toHaveCount(0);
    await expect(eventTable).toContainText("241");
    const width = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport);
  });

  test("keeps failed decoded events and signer context actionable without a false continuation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    let eventsFail = true;
    let peersFail = true;
    await page.route("**/api/v1/chain-events?*", async (route) => {
      if (!eventsFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Event record fixture failed" },
        }),
      });
    });
    await page.route("**/api/v1/extrinsics?*", async (route) => {
      if (!peersFail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Signer record fixture failed" },
        }),
      });
    });

    await gotoThroughRestart(page, ROUTE);
    await page.locator("[data-mg-extrinsic-peer]").scrollIntoViewIfNeeded();

    const eventsError = page.locator("#events").getByRole("alert");
    const peersError = page.locator("#signer").getByRole("alert");
    await expect(eventsError).toContainText("Couldn't load decoded events");
    await expect(peersError).toContainText("Couldn't load this signer's other recent calls");
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);

    peersFail = false;
    await peersError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(peersError).toHaveCount(0);
    await expect(
      page.getByRole("table", { name: /This signer's other recent calls/ }),
    ).toBeVisible();

    eventsFail = false;
    await eventsError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(eventsError).toHaveCount(0);

    const width = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport);
  });
});

test.describe("account attribution and pallet-level evidence", () => {
  test.use({ serviceWorkers: "block" });

  for (const width of [375, 768, 1280]) {
    for (const theme of ["light", "dark"] as const) {
      test(`preserves consensus and stake events at ${width} in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((choice) => localStorage.setItem("mg-theme", choice), theme);
        await page.route("**/api/v1/chain-events?*", (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ok: true, data: { events: [], next_cursor: null } }),
          }),
        );
        await gotoThroughRestart(page, `/extrinsics/${EVIDENCE_HASH}#economic-effects`);
        const table = page.getByRole("table", { name: "Account-attributed events" });
        await expect(table).toContainText("TimelockedWeightsCommitted");
        await expect(table).toContainText("StakeAdded");
        await expect(page.getByText("Decoded economic effects", { exact: true })).toHaveCount(0);
        await expect(
          page.getByText(/No pallet-level event records are available from this tier/),
        ).toBeVisible();
        await expect(table.locator("tbody tr")).toHaveCount(2);
        await expect(page.locator("#signer .mg-dt-skeleton")).toHaveCount(0);
        await page.evaluate(() => {
          document.documentElement.style.scrollBehavior = "auto";
          window.scrollTo(0, 0);
        });
        await page.screenshot({
          path: test.info().outputPath(`explorer-evidence-${width}-${theme}.png`),
          fullPage: true,
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      });
    }
  }

  test("retains failed proxy/batch arguments and unknown runtime events without inventing account effects", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.route("**/api/v1/chain-events?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            events: [
              {
                block_number: 8713384,
                event_index: 9,
                pallet: "FutureRuntime",
                method: "Unrecognized",
                args: { raw: "retained" },
              },
            ],
            next_cursor: null,
          },
        }),
      }),
    );
    await gotoThroughRestart(page, `/extrinsics/${FAILED_PROXY_HASH}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("proxy");
    await expect(page.getByText("result failed", { exact: true })).toBeVisible();
    const argumentsTable = page.locator("#arguments");
    await argumentsTable.getByRole("button", { name: "Expand row", exact: true }).focus();
    await page.keyboard.press("Enter");
    const decodedValue = argumentsTable.getByLabel("call decoded value", { exact: true });
    await expect(decodedValue).toBeVisible();
    await expect(decodedValue).toContainText('"batch"');
    await expect(decodedValue).toContainText('"add_stake"');
    await expect(
      argumentsTable.getByRole("button", { name: "Copy call decoded value", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/No account-attributed events were decoded/)).toBeVisible();
    await expect(page.getByRole("table", { name: /What it produced/ })).toContainText(
      "FutureRuntime.Unrecognized",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("keeps unavailable decode coordinates and signer context distinct from empty or pending data", async ({
    page,
  }) => {
    let rawReads = 0,
      peerReads = 0;
    await page.route("**/api/v1/chain-events?*", async (route) => {
      rawReads++;
      await route.continue();
    });
    await page.route("**/api/v1/extrinsics?*", async (route) => {
      peerReads++;
      await route.continue();
    });
    await gotoThroughRestart(page, `/extrinsics/${UNINDEXED_HASH}`);
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await expect(
      page.getByText("Call arguments are unavailable in this indexed record.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No signer or related call hash is available in this indexed record.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#events .mg-dt-skeleton, #signer .mg-dt-skeleton")).toHaveCount(0);
    expect(rawReads).toBe(0);
    expect(peerReads).toBe(0);
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    await expect(page.getByText("This call takes no arguments.", { exact: true })).toHaveCount(0);
  });

  for (const outcome of ["repeated-cursor", "failure-recovery"] as const) {
    test(`preserves more than ten raw events through ${outcome}`, async ({ page }) => {
      const rows = Array.from({ length: 12 }, (_, index) => ({
        block_number: 8713384,
        event_index: index,
        pallet: "System",
        method: "Remarked",
        args: {},
      }));
      let fail = outcome === "failure-recovery";
      await page.route("**/api/v1/chain-events?*", async (route) => {
        const continuation = new URL(route.request().url()).searchParams.has("cursor");
        if (continuation && fail) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "fixture_failure", message: "Continuation unavailable" },
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              events: continuation ? [rows[9], rows[10], rows[11]] : rows.slice(0, 10),
              next_cursor: continuation && outcome !== "repeated-cursor" ? null : "next-page",
            },
          }),
        });
      });
      await gotoThroughRestart(page, `/extrinsics/${EVIDENCE_HASH}`);
      const table = page.getByRole("table", { name: /What it produced/ });
      await expect(table.locator("tbody tr")).toHaveCount(10);
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      if (outcome === "failure-recovery") {
        await expect(page.getByText(/Couldn’t load more/)).toBeVisible();
        await expect(table.locator("tbody tr")).toHaveCount(10);
        fail = false;
        await page.getByRole("button", { name: "Retry", exact: true }).last().click();
      }
      await expect(table.locator("tbody tr")).toHaveCount(12);
      await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
      if (outcome === "repeated-cursor")
        await expect(page.getByText(/Pagination stopped/)).toBeVisible();
    });
  }
});
