import { expect, test } from "@playwright/test";
import { findOverflowViolations } from "./find-overflow-violations.ts";
import { gotoThroughRestart } from "./server-restart.ts";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812, minimumInset: 20 },
  { name: "tablet", width: 768, height: 1024, minimumInset: 24 },
  { name: "desktop", width: 1280, height: 800, minimumInset: 48 },
  { name: "compact-tablet", width: 700, height: 1024, minimumInset: 24 },
] as const;

async function openLanding(
  page: import("@playwright/test").Page,
  viewport: (typeof VIEWPORTS)[number],
) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await gotoThroughRestart(page, "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("home-network-signal-chart")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
}

test.describe("#11544 homepage landing quality contract", () => {
  for (const viewport of VIEWPORTS) {
    test(`keeps the loaded data field contained at ${viewport.name}`, async ({ page }) => {
      await openLanding(page, viewport);

      await expect(page.getByTestId("home-network-signal-chart")).toHaveAttribute(
        "aria-label",
        /Top \d+ of \d+ subnets ranked by stage-one alpha-price share\./,
      );

      const headerBounds = await page.locator(".mg-home-signal-header").boundingBox();
      expect(headerBounds, "the data field header should be visible").not.toBeNull();
      expect(headerBounds!.x).toBeGreaterThanOrEqual(viewport.minimumInset);
      expect(headerBounds!.x + headerBounds!.width).toBeLessThanOrEqual(
        viewport.width - viewport.minimumInset,
      );

      const violations = await page.evaluate(findOverflowViolations, viewport.width);
      expect(
        violations,
        `${viewport.name} landing page has element(s) escaping its viewport`,
      ).toEqual([]);
    });
  }

  test("keeps the rankings destination touch-sized on mobile", async ({ page }) => {
    await openLanding(page, VIEWPORTS[0]);

    const rankings = page.getByRole("link", { name: "Open subnet rankings", exact: true });
    const bounds = await rankings.boundingBox();
    expect(bounds, "the rankings link should be visible").not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  });

  test("keeps the editorial frontispiece finite so live data follows in the desktop reading session", async ({
    page,
  }) => {
    await openLanding(page, VIEWPORTS[2]);

    const hero = page.locator(
      '.mg-page-hero--landing[data-ambient="document"][data-height="content"]',
    );
    await expect(hero).toBeVisible();
    await expect(hero.locator(".mg-page-hero-document")).toHaveAttribute("aria-hidden", "true");
    await expect(hero.getByRole("link", { name: "Explore subnets" })).toHaveCount(1);
    await expect(hero.getByRole("button", { name: "Search the registry" })).toHaveCount(0);
    await expect(page.getByPlaceholder("Search blocks, accounts, and subnets…")).toHaveCount(1);

    const heroText = await hero.innerText();
    expect(heroText.match(/Bittensor/g) ?? [], "the hero has one network-name moment").toHaveLength(
      1,
    );

    const heroBounds = await hero.boundingBox();
    expect(heroBounds, "the landing hero should have a real layout box").not.toBeNull();
    expect(
      heroBounds!.y + heroBounds!.height,
      "the first live data field should not be hidden below a poster-sized hero",
    ).toBeLessThanOrEqual(VIEWPORTS[2].height + 80);

    const firstBar = page
      .locator(".mg-interactive-data-field-bar")
      .first()
      .locator(".mg-interactive-data-field-bar-fill");
    const firstBarBounds = await firstBar.boundingBox();
    expect(
      firstBarBounds,
      "the first live visual should enter the desktop viewport",
    ).not.toBeNull();
    expect(firstBarBounds!.y).toBeLessThanOrEqual(VIEWPORTS[2].height);
  });

  test("collapses the hero before its two reading columns can collide", async ({ page }) => {
    const compactTablet = VIEWPORTS[3];
    await openLanding(page, compactTablet);

    const heading = page.locator(".mg-page-hero--landing h1");
    const description = page.locator(".mg-page-hero--landing .mg-page-hero-description");
    const headingBounds = await heading.boundingBox();
    const descriptionBounds = await description.boundingBox();
    expect(headingBounds).not.toBeNull();
    expect(descriptionBounds).not.toBeNull();
    expect(
      descriptionBounds!.y,
      "compact-tablet copy should flow below the title rather than compete beside it",
    ).toBeGreaterThanOrEqual(headingBounds!.y + headingBounds!.height);
  });

  test("keeps the landing a graphite document in a light system theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openLanding(page, VIEWPORTS[2]);

    const shellBackground = await page
      .locator(".mg-shell--landing")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(shellBackground).toBe("rgb(8, 11, 10)");

    const searchSurface = await page
      .getByPlaceholder("Search blocks, accounts, and subnets…")
      .evaluate(
        (input) => getComputedStyle(input.parentElement?.parentElement ?? input).backgroundColor,
      );
    expect(searchSurface).toBe("rgb(16, 22, 20)");

    const inspectorSurface = await page
      .locator(".mg-interactive-data-field")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--mg-data-field-tooltip").trim(),
      );
    expect(inspectorSurface).toBe("#242424");
  });

  test("uses an inspectable prism field rather than a static chart", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);

    const bars = page.locator(".mg-interactive-data-field-bar");
    await expect(bars).toHaveCount(24);
    await expect(page.getByText("Price share · registry family color")).toBeVisible();
    const tones = await bars.evaluateAll((elements) =>
      [...new Set(elements.map((element) => element.getAttribute("data-tone")))].filter(Boolean),
    );
    expect(
      tones.length,
      "categories should produce several visible prism series",
    ).toBeGreaterThanOrEqual(4);
    const legendTones = await page
      .locator(".mg-home-signal-legend li")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-tone")));
    for (const tone of tones) {
      expect(legendTones, `chart color ${tone} needs a visible category key`).toContain(tone);
    }
    expect(
      new Set(legendTones).size,
      "each visible registry family needs its own categorical color",
    ).toBe(legendTones.length);

    const third = bars.nth(2);
    await third.hover();
    await expect(third).toHaveAttribute("aria-pressed", "true");
    const inspector = page.locator(".mg-interactive-data-field-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("Price share");
    await expect(inspector).toContainText("Registry tags");
    await expect(inspector).toContainText("Probe");

    await expect(
      bars.nth(0).locator(".mg-interactive-data-field-bar-fill"),
      "inspecting one mark should dim, not erase, the other category colors",
    ).toHaveCSS("opacity", "0.48");
    const focusRailColor = await third.evaluate(
      (element) => getComputedStyle(element, "::before").backgroundColor,
    );
    expect(focusRailColor, "the inspected datum should get a mint focus rail").toBe(
      "rgb(48, 255, 192)",
    );

    await page.getByRole("banner").hover();
    await expect(inspector).toHaveCount(0);
    await expect(
      bars.nth(0).locator(".mg-interactive-data-field-bar-fill"),
      "leaving a hover inspection should restore the full categorical comparison",
    ).toHaveCSS("opacity", "1");

    await third.focus();
    await expect(third).toHaveAttribute("aria-describedby", /.+/);
    await expect(third).toHaveAttribute("tabindex", "0");

    const focusableBars = await bars.evaluateAll(
      (elements) => elements.filter((element) => element.getAttribute("tabindex") === "0").length,
    );
    expect(focusableBars, "the dense field should use roving tab focus").toBe(1);

    const bounds = await third.boundingBox();
    expect(bounds, "each desktop data point needs a full-height hit slab").not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(176);
  });

  test("uses a scrollable full-height point track and safe inspector on mobile", async ({
    page,
  }) => {
    await openLanding(page, VIEWPORTS[0]);

    const track = page.locator(".mg-interactive-data-field-bars");
    const trackBounds = await track.boundingBox();
    expect(trackBounds, "mobile should render a data track").not.toBeNull();
    expect(trackBounds!.width).toBeGreaterThan(VIEWPORTS[0].width * 1.5);
    const trackCanScroll = await page
      .locator(".mg-interactive-data-field-scroll")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(trackCanScroll, "mobile should preserve every data point in a horizontal track").toBe(
      true,
    );

    const first = page.locator(".mg-interactive-data-field-bar").first();
    const firstBounds = await first.boundingBox();
    expect(firstBounds, "mobile point needs a full-height tap target").not.toBeNull();
    expect(firstBounds!.width).toBeGreaterThanOrEqual(24);
    expect(firstBounds!.height).toBeGreaterThanOrEqual(200);

    await first.click();
    const inspector = page.locator(".mg-interactive-data-field-inspector");
    await expect(inspector).toBeVisible();
    const inspectorBounds = await inspector.boundingBox();
    expect(inspectorBounds, "mobile readout should exist outside the plot").not.toBeNull();
    expect(inspectorBounds!.y).toBeGreaterThanOrEqual(
      VIEWPORTS[0].height - inspectorBounds!.height - 20,
    );

    const dismiss = page.getByRole("button", { name: "Dismiss chart readout" });
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(inspector).toHaveCount(0);
  });

  test("keeps landing chrome and footer deliberately compact on tablet and mobile", async ({
    page,
  }) => {
    await openLanding(page, VIEWPORTS[1]);
    await expect(page.getByRole("button", { name: "Open search" })).toBeVisible();
    await expect(page.getByPlaceholder("Search blocks, accounts, and subnets…")).toBeHidden();
    await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toHaveCount(0);

    await openLanding(page, VIEWPORTS[0]);
    const footerGroups = page.locator("footer details");
    await expect(footerGroups).toHaveCount(2);
    const firstFooterSummary = footerGroups.first().locator("summary");
    const bounds = await firstFooterSummary.boundingBox();
    expect(bounds, "landing footer summary should be touch-sized").not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(48);
    await expect(footerGroups.first()).not.toHaveAttribute("open", "");
  });

  test("defers secondary live content until its disclosure is opened", async ({ page }) => {
    await openLanding(page, VIEWPORTS[0]);

    const activity = page.locator("details", {
      has: page.getByText("Recent registry activity", { exact: true }),
    });
    await expect(activity.locator(".mg-page-disclosure-content")).toHaveCount(0);
    await activity.locator("summary").click();
    await expect(activity).toHaveAttribute("open", "");
    await expect(activity.locator(".mg-page-disclosure-content")).toHaveCount(1);
  });

  test("freezes ambient motion for visitors who request reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openLanding(page, VIEWPORTS[2]);

    const animationNames = await page
      .locator(".mg-page-hero-document-scan")
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).animationName),
      );
    expect(new Set(animationNames)).toEqual(new Set(["none"]));
  });
});
