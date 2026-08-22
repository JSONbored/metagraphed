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

/** Emphasis tallies across every segment, the unit the #11547 contract is written in. */
async function emphasis(page: import("@playwright/test").Page) {
  return page.locator(".mg-composition-timeline-segment").evaluateAll((elements) => ({
    vivid: elements.filter((element) => element.dataset.emphasis === "vivid").length,
    graphite: elements.filter((element) => element.dataset.emphasis === "graphite").length,
  }));
}

test.describe("#11544 homepage landing quality contract", () => {
  for (const viewport of VIEWPORTS) {
    test(`keeps the loaded data field contained at ${viewport.name}`, async ({ page }) => {
      await openLanding(page, viewport);

      await expect(page.locator(".mg-composition-timeline")).toHaveAttribute(
        "aria-label",
        /\d+ daily snapshots of artifact-normalised moving price share/,
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

    const firstLane = page.locator(".mg-composition-timeline-lane").first();
    const firstLaneBounds = await firstLane.boundingBox();
    expect(
      firstLaneBounds,
      "the first live visual should enter the desktop viewport",
    ).not.toBeNull();
    expect(firstLaneBounds!.y).toBeLessThanOrEqual(VIEWPORTS[2].height);
  });

  test("runs the hero as one reading column rather than a title facing a boxed panel", async ({
    page,
  }) => {
    // The rejected composition put the title in a wide left column and boxed
    // the sentence AND the primary action into a narrow right one, which read
    // as a caption for the backdrop and buried the action in the quietest
    // corner. Copy now descends in a single column at every width.
    for (const viewport of [VIEWPORTS[2], VIEWPORTS[3]]) {
      await openLanding(page, viewport);

      const heading = page.locator(".mg-page-hero--landing h1");
      const description = page.locator(".mg-page-hero--landing .mg-page-hero-description");
      const action = page.locator(".mg-page-hero--landing .mg-page-hero-primary-actions");

      const headingBounds = await heading.boundingBox();
      const descriptionBounds = await description.boundingBox();
      const actionBounds = await action.boundingBox();
      expect(headingBounds).not.toBeNull();
      expect(descriptionBounds).not.toBeNull();
      expect(actionBounds).not.toBeNull();

      expect(
        descriptionBounds!.y,
        `${viewport.name}: the sentence should flow below the title, never beside it`,
      ).toBeGreaterThanOrEqual(headingBounds!.y + headingBounds!.height);
      expect(
        actionBounds!.y,
        `${viewport.name}: the action should follow the sentence, not sit in a facing column`,
      ).toBeGreaterThanOrEqual(descriptionBounds!.y + descriptionBounds!.height);

      // One shared left edge is what makes it read as a column rather than a
      // stack of separately-placed blocks.
      expect(
        Math.abs(descriptionBounds!.x - headingBounds!.x),
        `${viewport.name}: hero copy should share one left edge`,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(actionBounds!.x - headingBounds!.x),
        `${viewport.name}: the action should share the copy's left edge`,
      ).toBeLessThanOrEqual(2);
    }
  });

  test("keeps exactly one primary action above the fold", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);
    const heroActions = page.locator(
      ".mg-page-hero--landing .mg-page-hero-primary-actions a, " +
        ".mg-page-hero--landing .mg-page-hero-primary-actions button",
    );
    await expect(heroActions).toHaveCount(1);
  });

  test("keeps the landing a graphite document in a light system theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openLanding(page, VIEWPORTS[2]);

    const shellBackground = await page
      .locator(".mg-shell--landing")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(shellBackground).toBe("rgb(8, 11, 10)");

    // Targets the field itself rather than counting parents. The omnibox used
    // to borrow the grouping primitive for its surface, so this walked up two
    // levels to find it; a search input is its own kind of surface now and
    // `.mg-field` owns it. Asserted as a LUMINANCE, because the value is
    // derived from the landing's palette rather than written as a hex — which
    // is the point: it has to follow the scope, and a fixed :root value silently
    // did not (the field rendered near-white here).
    const searchLuminance = await page
      .locator(".mg-field")
      .first()
      .evaluate((element) => {
        const [r, g, b] = getComputedStyle(element)
          .backgroundColor.match(/[\d.]+/g)!
          .map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      });
    expect(searchLuminance).toBeLessThan(0.2);

    // The chart's own surfaces must follow the landing's graphite scope, not a
    // `.dark` class the landing never sets. Assert the RENDERED colour rather
    // than a token string, so a derived value still proves the visual outcome.
    await page.locator(".mg-composition-timeline-lane").nth(10).hover();
    const inspectorLuminance = await page
      .locator(".mg-composition-timeline-inspector")
      .evaluate((element) => {
        const [r, g, b] = getComputedStyle(element)
          .backgroundColor.match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      });
    expect(
      inspectorLuminance,
      "the chart inspector should be graphite on the landing, even in a light system theme",
    ).toBeLessThan(0.3);
  });

  test("reads as a temporal composition that is vivid before it is touched", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);

    const lanes = page.locator(".mg-composition-timeline-lane");
    const laneCount = await lanes.count();
    expect(laneCount, "the span should be a real multi-week series").toBeGreaterThan(30);

    const keys = page.locator(".mg-composition-timeline-key-item");
    const keyCount = await keys.count();
    expect(keyCount, "every drawn series needs a named key entry").toBeGreaterThanOrEqual(2);

    // At rest the whole field is legible. A chart that only becomes readable
    // on hover is the specific failure this contract exists to prevent.
    const atRest = await emphasis(page);
    expect(atRest.graphite, "no series may be dulled at rest").toBe(0);
    expect(atRest.vivid).toBe(laneCount * keyCount);

    // The residual is not a category and must not spend a categorical tone.
    const residualTones = await keys.evaluateAll((elements) =>
      elements
        .filter((element) => element.textContent?.includes("derived"))
        .map((element) => element.getAttribute("data-tone")),
    );
    expect(residualTones, "the derived residual should draw neutral").toEqual(["residual"]);
  });

  test("inspects one day without dimming that day's own series", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);
    const lanes = page.locator(".mg-composition-timeline-lane");
    const keyCount = await page.locator(".mg-composition-timeline-key-item").count();

    await lanes.nth(10).hover();
    await expect(lanes.nth(10)).toHaveAttribute("aria-pressed", "true");

    const inspected = await emphasis(page);
    expect(
      inspected.vivid,
      "the inspected day keeps its full palette while the others recede",
    ).toBe(keyCount);
    expect(inspected.graphite).toBeGreaterThan(0);

    const inspector = page.locator(".mg-composition-timeline-inspector");
    await expect(inspector).toBeVisible();
    // Metric-only content: the domain, one supporting fact, and exact values.
    await expect(inspector).toContainText(/priced subnets/);
    await expect(inspector).toContainText(/%/);

    await page.getByRole("banner").hover();
    const released = await emphasis(page);
    expect(released.graphite, "releasing a hover restores the full comparison").toBe(0);
  });

  test("follows one series across every day when its key entry is inspected", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);
    const laneCount = await page.locator(".mg-composition-timeline-lane").count();

    await page.locator(".mg-composition-timeline-key-item").nth(1).hover();

    const followed = await emphasis(page);
    expect(followed.vivid, "an inspected series stays vivid on every day, not just one").toBe(
      laneCount,
    );
    expect(followed.graphite).toBeGreaterThan(0);

    // The claim is about the whole span, so no single lane may be singled out.
    const activeLanes = await page
      .locator('.mg-composition-timeline-lane[data-emphasis="active"]')
      .count();
    expect(activeLanes, "following a series must not also select a day").toBe(0);
  });

  test("drives the field from the keyboard with a single roving tab stop", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);
    const lanes = page.locator(".mg-composition-timeline-lane");

    await lanes.first().focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");

    await expect(lanes.nth(2)).toBeFocused();
    await expect(lanes.nth(2)).toHaveAttribute("aria-pressed", "true");
    await expect(lanes.nth(2)).toHaveAttribute("aria-describedby", /.+/);

    const tabStops = await lanes.evaluateAll(
      (elements) => elements.filter((element) => element.getAttribute("tabindex") === "0").length,
    );
    expect(tabStops, "a dense field uses roving tab focus, not 56 tab stops").toBe(1);

    await page.keyboard.press("Escape");
    const cleared = await emphasis(page);
    expect(cleared.graphite, "Escape returns the field to rest").toBe(0);

    const bounds = await lanes.nth(2).boundingBox();
    expect(bounds, "each desktop lane needs a full-height hit slab").not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(176);
  });

  test("offers the same numbers without the chart", async ({ page }) => {
    await openLanding(page, VIEWPORTS[2]);

    // The reference implementation of this genre ships no table and no
    // sr-only region, leaving the values reachable by pointer only.
    const table = page.locator(".mg-composition-timeline table");
    await expect(table).toHaveCount(1);
    const rows = await table.locator("tbody tr").count();
    expect(rows).toBe(await page.locator(".mg-composition-timeline-lane").count());
    await expect(table.locator("caption")).toContainText("daily snapshots");
  });

  test("uses a scrollable full-height lane track and safe inspector on mobile", async ({
    page,
  }) => {
    await openLanding(page, VIEWPORTS[0]);

    const track = page.locator(".mg-composition-timeline-lanes");
    const trackBounds = await track.boundingBox();
    expect(trackBounds, "mobile should render a data track").not.toBeNull();
    expect(trackBounds!.width).toBeGreaterThan(VIEWPORTS[0].width * 1.5);
    const trackCanScroll = await page
      .locator(".mg-composition-timeline-scroll")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(trackCanScroll, "mobile should preserve every day in a horizontal track").toBe(true);

    const first = page.locator(".mg-composition-timeline-lane").first();
    const firstBounds = await first.boundingBox();
    expect(firstBounds, "mobile lane needs a full-height tap target").not.toBeNull();
    expect(firstBounds!.width).toBeGreaterThanOrEqual(20);
    expect(firstBounds!.height).toBeGreaterThanOrEqual(200);

    await first.click();
    const inspector = page.locator(".mg-composition-timeline-inspector");
    await expect(inspector).toBeVisible();
    const inspectorBounds = await inspector.boundingBox();
    expect(inspectorBounds, "mobile readout should exist outside the plot").not.toBeNull();
    expect(inspectorBounds!.y).toBeGreaterThanOrEqual(
      VIEWPORTS[0].height - inspectorBounds!.height - 20,
    );

    const dismiss = page.locator(".mg-composition-timeline-dismiss");
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

  test("freezes ambient and chart motion for visitors who request reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openLanding(page, VIEWPORTS[2]);

    const animationNames = await page
      .locator(".mg-page-hero-document-scan")
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).animationName),
      );
    expect(new Set(animationNames)).toEqual(new Set(["none"]));

    const segmentTransitions = await page
      .locator(".mg-composition-timeline-segment")
      .evaluateAll((elements) => [
        ...new Set(elements.map((element) => getComputedStyle(element).transitionDuration)),
      ]);
    expect(segmentTransitions, "chart state changes should not animate").toEqual(["0s"]);
  });
});
