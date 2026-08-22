import { test, expect, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// The page-wide data-active contract (#11606), exercised on the specimen at
// /design/primitives#interaction: twelve bar marks in one [data-marks] group
// and a twelve-row list that carries the same keys. No API data is involved.

const ROUTE = "/design/primitives";
const MARK = (key: string) => `[data-entity="${key}"]`;

async function open(page: Page) {
  await gotoThroughRestart(page, ROUTE);
  await page.locator("#interaction").waitFor();
  await page.locator('[data-testid="entity-demo"]').scrollIntoViewIfNeeded();
}

async function activeKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-active="true"]')).map(
      (el) => `${el.tagName.toLowerCase()}:${el.getAttribute("data-entity")}`,
    ),
  );
}

test.describe("active entity", () => {
  test("hovering one mark lights every mark with that key and nothing else", async ({ page }) => {
    await open(page);
    const demo = page.locator('[data-testid="entity-demo"]');
    await demo.locator(`[data-marks] ${MARK("m-3")}`).hover();
    await expect.poll(() => activeKeys(page)).toEqual(["button:m-3", "li:m-3"]);
    await demo.locator(`[data-marks] ${MARK("m-7")}`).hover();
    await expect.poll(() => activeKeys(page)).toEqual(["button:m-7", "li:m-7"]);
    await page.mouse.move(0, 0);
    await expect.poll(() => activeKeys(page)).toEqual([]);
  });

  test("the chart tooltip follows the hovered mark and names it", async ({ page }) => {
    await open(page);
    const demo = page.locator('[data-testid="entity-demo"]');
    await expect(demo.locator(".mg-chart-tooltip")).toHaveCount(0);
    await demo.locator(`[data-marks] ${MARK("m-5")}`).hover();
    const tip = demo.locator(".mg-chart-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip.locator("strong")).toHaveText("Mark 5");
    await expect(tip.locator('.mg-chart-tooltip-row[data-current="true"]')).toHaveCount(1);
  });

  test("Tab enters the group once, arrows move inside it, Escape clears", async ({ page }) => {
    await open(page);
    await page.locator('[data-testid="entity-demo-before"]').focus();
    await page.keyboard.press("Tab");
    const focusedKey = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-entity") ?? null);
    await expect.poll(focusedKey).toBe("m-1");
    await expect.poll(() => activeKeys(page)).toEqual(["button:m-1", "li:m-1"]);
    await page.keyboard.press("ArrowRight");
    await expect.poll(focusedKey).toBe("m-2");
    await page.keyboard.press("End");
    await expect.poll(focusedKey).toBe("m-12");
    await page.keyboard.press("ArrowRight");
    await expect.poll(focusedKey).toBe("m-1");
    await page.keyboard.press("Escape");
    await expect.poll(() => activeKeys(page)).toEqual([]);
    // One Tab stop: the next Tab leaves the group entirely.
    await page.keyboard.press("Tab");
    await expect.poll(focusedKey).toBeNull();
  });

  test("exactly one mark per group is tabbable at rest", async ({ page }) => {
    await open(page);
    const tabbable = await page
      .locator('[data-testid="entity-demo"] [data-marks] [data-entity][tabindex="0"]')
      .count();
    expect(tabbable).toBe(1);
  });

  test("Enter on a focused mark activates it", async ({ page }) => {
    await open(page);
    await page.locator(`[data-testid="entity-demo"] [data-marks] ${MARK("m-2")}`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="entity-demo-activated"]')).toHaveText("m-2");
  });
});

test.describe("active entity on touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

  test("a tap pins, a second tap on the pinned mark activates, a tap outside releases", async ({
    page,
  }) => {
    await open(page);
    const demo = page.locator('[data-testid="entity-demo"]');
    await demo.locator(`[data-marks] ${MARK("m-4")}`).tap();
    await expect.poll(() => activeKeys(page)).toEqual(["button:m-4", "li:m-4"]);
    // Pinned: the tooltip is the static, above-the-visual variant on mobile.
    await expect(demo.locator('.mg-chart-tooltip[data-placement="static"]')).toBeVisible();
    await demo.locator(`[data-marks] ${MARK("m-4")}`).tap();
    await expect(page.locator('[data-testid="entity-demo-activated"]')).toHaveText("m-4");
    await page.locator('[data-testid="entity-demo-before"]').tap();
    await expect.poll(() => activeKeys(page)).toEqual([]);
  });
});

test.describe("definition", () => {
  test("opens on hover and focus, closes on Escape and outside tap", async ({ page }) => {
    await open(page);
    const demo = page.locator('[data-testid="definition-demo"]');
    const button = demo.locator(".mg-definition-button").first();
    await button.hover();
    await expect(demo.locator('[role="tooltip"]')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(demo.locator('[role="tooltip"]')).toHaveCount(0);
    await button.focus();
    await expect(demo.locator('[role="tooltip"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(demo.locator('[role="tooltip"]')).toHaveCount(0);
  });
});
