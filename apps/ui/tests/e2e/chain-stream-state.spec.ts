import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("block activity arrival motion", () => {
  test("cues a newer indexed head when it enters the window", async ({ page }) => {
    const response = await page.request.get(
      "http://127.0.0.1:8081/api/v1/blocks?limit=50&offset=0",
    );
    expect(response.ok()).toBe(true);
    const fixture = (await response.json()) as {
      data: { blocks: Array<Record<string, unknown> & { block_number: number }> };
    };
    const currentHead = fixture.data.blocks[0];
    if (!currentHead) throw new Error("Blocks fixture has no first-page head");
    const nextHead = currentHead.block_number + 1;
    const refreshed = structuredClone(fixture);
    refreshed.data.blocks = [
      {
        ...currentHead,
        block_number: nextHead,
        block_hash: `0x${"a".repeat(63)}1`,
        observed_at: "2026-08-27T17:00:00.000Z",
      },
      ...fixture.data.blocks.slice(0, -1),
    ];

    let sendRefreshedWindow = false;
    await page.route("**/api/v1/blocks?*", async (route) => {
      const url = new URL(route.request().url());
      if (sendRefreshedWindow && url.searchParams.get("limit") === "50") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(refreshed),
        });
        return;
      }
      if (url.searchParams.get("limit") === "50") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixture),
        });
        return;
      }
      await route.continue();
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoThroughRestart(page, "/chain/blocks");
    await expect(page.locator(".mg-block-activity-mark").first()).toBeVisible();
    // Do not turn hydration's optional background refresh into an arrival;
    // the next visible-interval fetch is the deliberately newer fixture.
    await page.waitForTimeout(1_800);
    sendRefreshedWindow = true;

    const arrived = page.locator('.mg-block-activity-mark[data-arrived="true"]');
    await expect(arrived).toHaveAttribute("href", `/blocks/${nextHead}`, { timeout: 20_000 });
    await expect(page.locator(".mg-block-activity [aria-live=polite]")).toContainText(
      `Block #${nextHead.toLocaleString("en-US")} arrived`,
    );
    expect(
      await arrived.evaluate(
        (element) =>
          getComputedStyle(element, "::after").animationName === "mg-block-activity-arrival",
      ),
    ).toBe(true);
  });
});

test.describe("chain event stream states", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("lets a phone reader inspect an activity mark before following its block link", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/chain/blocks");

    const mark = page.locator(".mg-block-activity-mark").nth(1);
    const href = await mark.getAttribute("href");
    expect(href).toMatch(/^\/blocks\/\d+$/);
    // The fixture window is intentionally static while the numeric block it
    // names changes between captures. Give intent preloading a real compact
    // block record so this interaction test never leaks a fixture miss.
    const blockFixture = await page.request.get("http://127.0.0.1:8081/api/v1/blocks/8713384");
    expect(blockFixture.ok()).toBe(true);
    const blockBody = await blockFixture.body();
    const extrinsicsFixture = await page.request.get(
      "http://127.0.0.1:8081/api/v1/blocks/8713384/extrinsics?limit=100",
    );
    expect(extrinsicsFixture.ok()).toBe(true);
    const extrinsicsBody = await extrinsicsFixture.body();
    await page.route("**/api/v1/blocks/*", async (route) => {
      if (new URL(route.request().url()).pathname !== `/api/v1${href}`) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: blockFixture.status(),
        contentType: blockFixture.headers()["content-type"] ?? "application/json",
        body: blockBody,
      });
    });
    await page.route("**/api/v1/blocks/*/extrinsics*", async (route) => {
      await route.fulfill({
        status: extrinsicsFixture.status(),
        contentType: extrinsicsFixture.headers()["content-type"] ?? "application/json",
        body: extrinsicsBody,
      });
    });

    // The activity marks are present in the streamed HTML before React owns
    // them. On a slower CI runner, tapping as soon as the SSR anchor is visible
    // can follow its native href before the first-tap pin handler hydrates.
    // The roving-tabindex layout effect promotes the first mark from the SSR
    // value (-1) to the hydrated value (0). Wait for that client-only signal
    // without focusing or otherwise mutating the entity state, then exercise
    // the actual touch contract on the second mark.
    await expect(page.locator(".mg-block-activity-mark").first()).toHaveAttribute("tabindex", "0");

    await mark.tap();
    await expect(page).toHaveURL(/\/chain\/blocks$/);
    await expect(mark).toHaveAttribute("data-active", "true");
    await expect(page.locator(".mg-block-activity-reading")).toContainText(
      `#${Number(href!.replace("/blocks/", "")).toLocaleString("en-US")}`,
    );

    await mark.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test("keeps the sampled event facts distinct from zero while the activity read is pending", async ({
    page,
  }) => {
    let releaseRead: (() => void) | undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route("**/api/v1/chain-events/stats*", async (route) => {
      await readReleased;
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/chain/events");

    const heroFacts = page.locator(".mg-hero--chain-stream .mg-facts");
    const events = page.getByRole("table", { name: /Chain events/ });
    await expect(heroFacts.locator("dd[aria-busy='true']")).toHaveCount(3);
    await expect(events).not.toHaveAttribute("aria-busy", "true");

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    releaseRead?.();
    await expect(heroFacts.locator("dd[aria-busy='true']")).toHaveCount(0);
  });

  test("does not mistake a failed initial event feed for an empty chain", async ({ page }) => {
    await page.route("**/api/v1/chain-events?*", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Fixture feed failed" },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/chain/events");

    await expect(page.getByRole("alert")).toContainText("Couldn't load chain events");
    await expect(page.getByText("No chain events indexed yet", { exact: true })).toHaveCount(0);
  });
});
