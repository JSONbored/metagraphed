import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Schema capture query state", () => {
  test("keeps the hero, drift, and size instruments truthful while captures are pending", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });

    let release: (() => void) | undefined;
    const continueRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/schemas*", async (route) => {
      await continueRead;
      await route.continue();
    });

    await gotoThroughRestart(page, "/apis/schemas");
    await page.evaluate(() => document.fonts.ready);

    const hero = page.locator(".mg-hero").first();
    const drift = page.getByRole("group", {
      name: "Schemas that changed since the last capture",
    });
    const size = page.getByRole("group", { name: "Captured schemas by size" });
    const table = page.getByRole("table", { name: "Schemas that moved" });

    await expect(drift).toHaveAttribute("aria-busy", "true");
    await expect(size).toHaveAttribute("aria-busy", "true");
    await expect(drift.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(size.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(table.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(hero.locator(".mg-fact")).toHaveCount(5);
    await expect(hero.locator(".mg-fact dt")).toHaveText([
      "Tracked",
      "Captured",
      "Subnets",
      "Moved?",
      "Not captured?",
    ]);
    await expect(hero.locator(".mg-fact-loading")).toHaveCount(5);
    await expect(page.getByText("Loading schema captures · snapshot")).toBeVisible();
    await expect(page.getByText("Loading captured schemas · snapshot")).toBeVisible();
    await expect(page.getByText("Show all 0")).toHaveCount(0);
    const driftTopBefore = await page
      .locator("section#drift")
      .evaluate((element) => element.getBoundingClientRect().top + window.scrollY);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(hero.locator(".mg-fact-loading")).toHaveCount(0);
    await expect(drift).not.toHaveAttribute("aria-busy", "true");
    await expect(size).not.toHaveAttribute("aria-busy", "true");
    await expect(table.locator(".mg-dt-skeleton")).toHaveCount(0);
    const driftTopAfter = await page
      .locator("section#drift")
      .evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    expect(Math.abs(driftTopAfter - driftTopBefore)).toBeLessThanOrEqual(1);
  });
});
