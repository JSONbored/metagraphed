import { test, expect, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// The ranking/composition primitives (#11609) on their /design/primitives
// specimens. The composition's segments share keys with the rails and the
// rank grid, so one hover lights all three.

const ROUTE = "/design/primitives";

async function open(page: Page) {
  await gotoThroughRestart(page, ROUTE);
  await page.locator("#charts").waitFor();
  await page.locator("[data-mg-composition]").scrollIntoViewIfNeeded();
}

test.describe("composition cross-highlight", () => {
  test("hovering a segment lights its legend row and the rail with the same key", async ({
    page,
  }) => {
    await open(page);
    await page.locator('[data-mg-composition] .mg-composition-bar i[data-entity="Chutes"]').hover();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-active="true"][data-entity="Chutes"]')).map(
            (e) => e.tagName.toLowerCase() + "." + e.className.toString().split(" ")[0],
          ),
        ),
      )
      .toEqual(expect.arrayContaining(["i.", "button.mg-rank-grid-row", "button.mg-rails-row"]));
    // Every other segment recolours.
    const dims = await page
      .locator('[data-mg-composition] .mg-composition-bar i[data-dim="true"]')
      .count();
    expect(dims).toBe(2);
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-active="true"][data-entity="Chutes"]')).toHaveCount(0);
  });

  test("hovering a rail row fills it accent and shows its detail tooltip", async ({ page }) => {
    await open(page);
    const rails = page.locator("[data-mg-rails]").first();
    await rails.locator('.mg-rails-row[data-entity="Affine"]').hover();
    const tip = rails.locator(".mg-chart-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip.locator("strong")).toHaveText("Affine");
    await expect(tip.locator(".mg-chart-tooltip-row")).toHaveCount(3);
    const fill = await rails
      .locator('.mg-rails-row[data-entity="Affine"] .mg-rails-track > b')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const idle = await rails
      .locator('.mg-rails-row[data-entity="Score"] .mg-rails-track > b')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).not.toBe(idle);
  });

  test("Show all expands the rail in place", async ({ page }) => {
    await open(page);
    const rails = page.locator("[data-mg-rails]").first();
    await expect(rails.locator(".mg-rails-row")).toHaveCount(10);
    await rails.getByRole("button", { name: "Show all 12" }).click();
    await expect(rails.locator(".mg-rails-row")).toHaveCount(12);
  });
});
