import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const ROUTE = "/blocks/8713384";

test.describe("block detail progressive technical record", () => {
  test("keeps the entity and table geometry during a delayed mobile transition", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/chain/blocks");

    const fixture = await page.request.get("http://127.0.0.1:8081/api/v1/blocks/8713384");
    expect(fixture.ok()).toBe(true);
    const body = await fixture.body();
    const extrinsicsFixture = await page.request.get(
      "http://127.0.0.1:8081/api/v1/blocks/8713384/extrinsics?limit=100",
    );
    expect(extrinsicsFixture.ok()).toBe(true);
    const extrinsicsBody = await extrinsicsFixture.body();
    const target = page.locator("#blocks .mg-dt-rowlink").first();
    await expect(target).toBeVisible();
    const href = await target.getAttribute("href");
    expect(href).toMatch(/^\/blocks\/\d+$/);
    const blockNumber = href!.replace("/blocks/", "");
    await page.route(`**/api/v1/blocks/${blockNumber}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fulfill({
        status: fixture.status(),
        contentType: fixture.headers()["content-type"] ?? "application/json",
        body,
      });
    });
    await page.route(`**/api/v1/blocks/${blockNumber}/extrinsics*`, async (route) => {
      await route.fulfill({
        status: extrinsicsFixture.status(),
        contentType: extrinsicsFixture.headers()["content-type"] ?? "application/json",
        body: extrinsicsBody,
      });
    });

    await target.click();
    await expect(page.getByRole("status", { name: "Loading block detail" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Extrinsics in this block" })).toBeVisible();

    const layout = await page
      .locator(".mg-dt-skeleton")
      .first()
      .evaluate((row) => {
        const lead = row.querySelector<HTMLElement>('[data-mobile-lead="true"]');
        return {
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          leadDisplay: lead ? getComputedStyle(lead).display : null,
          leadColumn: lead ? getComputedStyle(lead).gridColumn : null,
        };
      });
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    expect(layout.leadDisplay).toBe("flex");
    expect(layout.leadColumn).toBe("1 / -1");

    await expect(page.getByRole("status", { name: "Loading block detail" })).toBeHidden();
  });

  test("loads the primary ledger first and starts forensic reads only when requested", async ({
    page,
  }) => {
    await gotoThroughRestart(page, ROUTE);
    await expect(page.getByRole("table", { name: /Extrinsics in this block/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Inspect decoded events", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("table", { name: /Events emitted/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Inspect decoded events", exact: true }).click();
    await expect(page.getByRole("table", { name: /Events emitted/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Hide technical record", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("preserves the event composition and cadence instruments while deferred reads resolve", async ({
    page,
  }) => {
    let releaseReads: (() => void) | undefined;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    await page.route("**/api/v1/blocks/8713384/chain-events", async (route) => {
      await readsReleased;
      await route.continue();
    });
    await page.route("**/api/v1/blocks?*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("block_start")) {
        await route.continue();
        return;
      }
      await readsReleased;
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, ROUTE);
    await page.getByRole("button", { name: "Inspect decoded events", exact: true }).click();

    const composition = page.locator('[data-mg-composition][data-loading="true"]');
    const cadence = page.locator('[data-mg-line][data-loading="true"]');
    await expect(composition).toBeVisible();
    await expect(
      composition.getByRole("group", { name: "Events by pallet", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    await expect(cadence).toBeVisible();
    await expect(cadence.getByRole("group", { name: /Block cadence around/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.getByRole("table", { name: /Events emitted/ })).toBeVisible();

    const dimensions = await page.locator("#block-technical-record").evaluate((record) => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      width: record.getBoundingClientRect().width,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.width).toBeGreaterThan(0);

    releaseReads?.();
    await expect(composition).toHaveCount(0);
    await expect(cadence).toHaveCount(0);
    await expect(page.locator('[data-mg-composition]:not([data-loading="true"])')).toBeVisible();
    await expect(page.locator('[data-mg-line]:not([data-loading="true"])')).toBeVisible();
  });
});
