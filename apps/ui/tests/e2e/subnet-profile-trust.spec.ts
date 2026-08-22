import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// #11521: the profile's first viewport has to say what the subnet is, whether
// it can be trusted, and what to do next — with mixed-freshness values never
// presented as one simultaneous snapshot.

const ROUTE = "/subnets/1";

async function openProfile(page: Page, width = 1280, height = 1000) {
  await page.setViewportSize({ width, height });
  await gotoThroughRestart(page, ROUTE);
  await page.waitForSelector(".mg-page-signal-rail", { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

test.describe("#11521 subnet profile trust signals", () => {
  test("dates each trust signal separately, not as one snapshot", async ({ page }) => {
    await openProfile(page);

    const freshness = await page
      .locator(".mg-page-signal")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.querySelector(".mg-page-signal-freshness")?.textContent?.trim() ?? ""),
      );
    expect(freshness.length).toBeGreaterThanOrEqual(3);
    // Every signal carries its own record line. A page-level "as of" would let
    // a 9-day probe and an 8-day profile read as one simultaneous reading.
    for (const line of freshness) {
      expect(line).toMatch(/record|unavailable|window/i);
    }
  });

  test("uses the trust rails to encode magnitude, not three different meanings", async ({
    page,
  }) => {
    await openProfile(page);
    // They previously carried three different colour rules — a reliability
    // threshold, always-brand, and always-neutral — so a perfect 4/4 source
    // coverage rendered grey beside a 96/100 in mint and read as the weakest
    // of the three. One encoding, or the colour is noise.
    const tones = await page
      .locator(".mg-page-signal")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-tone")));
    expect(new Set(tones).size).toBe(1);
  });

  test("answers 'is there anything here I can call?' with a real composition", async ({ page }) => {
    await openProfile(page);
    const mix = page.locator("#surface-mix");
    await expect(mix).toBeVisible();

    const slices = mix.locator(".mg-composition-breakdown-slice");
    expect(await slices.count()).toBeGreaterThan(1);

    // The grid is the legend, so it must name every slice the bar draws.
    const legend = mix.locator(".mg-composition-breakdown-grid > li");
    expect(await legend.count()).toBe(await slices.count());

    // Registry vocabulary is translated: a visitor should not need to know
    // that "subnet-api" is an enum member to read the chart.
    const labels = await mix
      .locator(".mg-composition-breakdown-label")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
    expect(labels.some((l) => /^Subnet API$/.test(l))).toBe(true);
    expect(labels.every((l) => !l.includes("-"))).toBe(true);

    await expect(mix.locator(".mg-composition-breakdown-note")).toContainText(
      /verified public surface/,
    );
  });

  test("keeps the shares agreeing with the widths they sit beside", async ({ page }) => {
    await openProfile(page);
    const mix = page.locator("#surface-mix");
    const widths = await mix
      .locator(".mg-composition-breakdown-slice")
      .evaluateAll((nodes) =>
        nodes.map((n) => Number.parseFloat((n as HTMLElement).style.width) || 0),
      );
    const shares = await mix
      .locator(".mg-composition-breakdown-share")
      .evaluateAll((nodes) => nodes.map((n) => Number.parseFloat(n.textContent ?? "") || 0));
    expect(widths).toHaveLength(shares.length);
    // Shares are derived from the same values that size the bar, so they can
    // never disagree — this proves that rather than assuming it.
    widths.forEach((width, index) => {
      expect(Math.abs(width - shares[index]!)).toBeLessThan(0.15);
    });
  });

  test("stays inside the viewport on a phone", async ({ page }) => {
    await openProfile(page, 375, 812);
    const mix = page.locator("#surface-mix");
    await expect(mix).toBeVisible();
    const box = await mix.locator(".mg-composition-breakdown-bar").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  });
});
