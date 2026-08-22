import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// #11522: the validator profile had NO e2e coverage — there was not even a
// recorded detail fixture for it, which is why a six-card glass wall sat there
// unchallenged. These pin the flat summary band and the absence of the
// dashboard treatment the redesign removes.

const HOTKEY = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const ROUTE = `/validators/${HOTKEY}`;

async function openProfile(page: Page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await gotoThroughRestart(page, ROUTE);
  await page.waitForSelector(".mg-measure-band", { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

test.describe("#11522 validator profile summary", () => {
  test("leads with one flat band of decision-critical measures", async ({ page }) => {
    await openProfile(page);

    const labels = await page
      .locator(".mg-measure-label")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));

    expect(labels).toEqual([
      "Total stake",
      "Est. APY",
      "Take rate",
      "Active subnets",
      "Nominators",
      "Avg trust",
    ]);
    // Every measure carries a real value, not a placeholder band.
    const values = await page
      .locator(".mg-measure-value")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
    expect(values.filter((v) => v.length > 0)).toHaveLength(labels.length);
  });

  test("carries no card wall — no glass, glow, or pill radius", async ({ page }) => {
    await openProfile(page);
    // Scoped to the page's own content. Two app-chrome buttons that float on
    // every route (shortcuts, back-to-top) still carry glass; flattening those
    // is a global change, not this page's, and asserting over the whole
    // document would fail for something this PR never touched.
    const content = page.locator(".mg-page-canvas, main").first();
    // The exact treatment this page shipped with: six rounded, glass-backed,
    // glowing tiles. If any of it returns here, this fails.
    await expect(content.locator("[class*='mg-glass']")).toHaveCount(0);
    await expect(content.locator("[class*='mg-card-glow']")).toHaveCount(0);
    await expect(content.locator("[class*='rounded-2xl']")).toHaveCount(0);
  });

  test("keeps the APY window control with the number it changes", async ({ page }) => {
    await openProfile(page);
    // Controls belong next to the measure they affect, not in a page toolbar.
    const apy = page.locator(".mg-measure", { hasText: "Est. APY" });
    await expect(apy.getByRole("tablist", { name: "APY window" })).toBeVisible();

    // Selecting the same window twice is a no-op, so retrying the click rides
    // out a hydration race without weakening the assertion.
    await expect
      .poll(
        async () => {
          await apy.getByRole("tab", { name: "7d", exact: true }).click();
          return (await apy.locator(".mg-measure-hint").innerText()).includes("7d");
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test("keeps the band readable on a phone", async ({ page }) => {
    await openProfile(page, 375, 812);
    const band = page.locator(".mg-measure-band");
    const box = await band.boundingBox();
    expect(box, "the summary band should render at 375px").not.toBeNull();
    // Two per row, inside the viewport, never a horizontal scroller.
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await expect(page.locator(".mg-measure")).toHaveCount(6);
  });
});
