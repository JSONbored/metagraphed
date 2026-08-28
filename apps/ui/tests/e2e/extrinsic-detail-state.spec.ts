import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

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
    await expect(
      page.getByText("Related extrinsics load as this section approaches."),
    ).toBeVisible();
    expect(peerRequests).toBe(0);

    await page.locator("[data-mg-extrinsic-peer]").scrollIntoViewIfNeeded();
    await expect.poll(() => peerRequests).toBe(1);
    await expect(
      page.getByRole("table", { name: /This signer's other recent calls/ }),
    ).toBeVisible();
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
