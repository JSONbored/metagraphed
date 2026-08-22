import { test, expect, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// The two temporal charts (#11608) on their /design/primitives specimens:
// a 56-column StackedColumns with 8 series + Other, and a LineWithWindow.
// No API data is involved.

const ROUTE = "/design/primitives";

async function open(page: Page) {
  await gotoThroughRestart(page, ROUTE);
  await page.locator("#charts").waitFor();
  await page.locator("#charts").scrollIntoViewIfNeeded();
}

test.describe("StackedColumns", () => {
  test("hovering a segment makes its series the active entity and recolours the rest", async ({
    page,
  }) => {
    await open(page);
    const chart = page.locator("[data-mg-stack]").first();
    const segment = chart.locator('.mg-stack-stack i[data-entity="Targon"]').nth(10);
    await segment.hover();
    await expect(chart).toHaveAttribute("data-series-active", "true");
    // Every Targon segment keeps its colour; every other segment is idle.
    // Scoped to the stacks: the tooltip lives in the same root and its swatches
    // are <i> too.
    const counts = await chart.evaluate((el) => {
      const seg = (s: string) => el.querySelectorAll(`.mg-stack-stack ${s}`).length;
      return {
        targonDim: seg('i[data-entity="Targon"][data-dim="true"]'),
        targonActive: seg('i[data-entity="Targon"][data-active="true"]'),
        otherDim: seg('i:not([data-entity="Targon"])[data-dim="true"]'),
        otherLit: seg('i:not([data-entity="Targon"]):not([data-dim="true"])'),
      };
    });
    expect(counts.targonDim).toBe(0);
    expect(counts.targonActive).toBe(56);
    expect(counts.otherLit).toBe(0);
    expect(counts.otherDim).toBeGreaterThan(0);
    const idle = await segment.evaluate(
      (el) =>
        getComputedStyle(el.parentElement!.querySelector('i[data-entity="Apex"]')!).backgroundColor,
    );
    const lit = await segment.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(idle).not.toBe(lit);
    // The tooltip names the column and marks the hovered series' row.
    const tip = chart.locator(".mg-chart-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip.locator('.mg-chart-tooltip-row[data-current="true"]')).toHaveText(/Targon/);
    await expect(tip.locator('.mg-chart-tooltip-row[data-muted="true"]')).toHaveCount(8);
    await page.mouse.move(0, 0);
    await expect(chart).not.toHaveAttribute("data-series-active", "true");
  });

  test("Tab reaches the columns once; ArrowUp walks the focused column's segments", async ({
    page,
  }) => {
    await open(page);
    const chart = page.locator("[data-mg-stack]").first();
    await chart.locator(".mg-stack-col").first().focus();
    const focused = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-entity") ?? null);
    await expect.poll(focused).toBe("d0");
    await page.keyboard.press("ArrowRight");
    await expect.poll(focused).toBe("d1");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => chart.getAttribute("data-series-active")).toBe("true");
    await page.keyboard.press("Escape");
    await expect.poll(() => chart.getAttribute("data-series-active")).toBeNull();
  });
});

test.describe("StackedColumns at 375", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("at 375 the plot scrolls and no bar is thinner than 15px", async ({ page }) => {
    await open(page);
    const chart = page.locator("[data-mg-stack]").first();
    const scroll = chart.locator(".mg-stack-scroll");
    const geometry = await scroll.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
      stacks: Array.from(el.querySelectorAll(".mg-stack-stack")).map(
        (s) => s.getBoundingClientRect().width,
      ),
    }));
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    // Scrolled to the latest column on mount.
    expect(geometry.scrollLeft).toBeGreaterThan(0);
    expect(geometry.stacks.length).toBe(56);
    for (const w of geometry.stacks) expect(w).toBeGreaterThanOrEqual(15);
    // The page itself never scrolls sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    // A tap pins the column and the tooltip renders as the static panel.
    await chart.locator(".mg-stack-col").last().tap();
    const tip = chart.locator(".mg-chart-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute("data-placement", "static");
  });
});

test.describe("LineWithWindow", () => {
  test("hovering a point draws the cursor and names the date; arrows step points", async ({
    page,
  }) => {
    await open(page);
    const line = page.locator("[data-mg-line]").first();
    await expect(line.locator(".mg-line-muted")).toHaveCount(1);
    await expect(line.locator(".mg-line-active")).toHaveCount(1);
    await expect(line.locator(".mg-line-marker")).toHaveCount(3);
    await expect(line.locator(".mg-line-end")).toHaveText(/^[+−]\d+%$|^0%$/);
    const hits = line.locator(".mg-line-hit");
    await hits.nth(40).hover();
    await expect(line.locator(".mg-line-cursor")).toHaveCount(1);
    const tip = line.locator(".mg-chart-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip.locator("strong")).toHaveText(/^[A-Z]{3} \d{1,2}$/);
    await hits.nth(40).focus();
    const focused = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-entity") ?? null);
    const before = await focused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(focused).not.toBe(before);
    await page.keyboard.press("Escape");
    await expect(line.locator(".mg-line-cursor")).toHaveCount(0);
  });
});
