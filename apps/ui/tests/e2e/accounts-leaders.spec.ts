import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// #11523: /accounts opened with 1,094px of chrome — a hero carrying no data, a
// lookup form duplicating the header search, and an empty wallet card — before
// a single account appeared. These pin the data-first order and the two
// silent-failure bugs the rewrite exposed in the shared ranked rail.

const ROUTE = "/accounts";

async function openAccounts(page: Page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await gotoThroughRestart(page, ROUTE);
  await page.waitForSelector(".mg-ranked-rail-row", { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

test.describe("#11523 accounts leaders", () => {
  test("puts accounts above the form that looks them up", async ({ page }) => {
    await openAccounts(page);

    const firstRow = await page.locator(".mg-ranked-rail-row").first().boundingBox();
    const lookup = await page.getByRole("heading", { name: /find an account/i }).boundingBox();

    expect(firstRow).not.toBeNull();
    expect(lookup).not.toBeNull();
    // The page is an account explorer; the accounts come first.
    expect(firstRow!.y).toBeLessThan(lookup!.y);
    // And they are actually in the opening screenful, not merely earlier.
    expect(firstRow!.y).toBeLessThan(900);
  });

  test("draws a rail in every board, including the half-width ones", async ({ page }) => {
    await openAccounts(page);

    // The bug this pins: with two boards side by side the body column took its
    // full content width and the `1fr` track resolved to 0px. Every row still
    // rendered, the ranking still read correctly, and the one thing the
    // component exists for was invisible — a failure with no error.
    const tracks = await page
      .locator(".mg-ranked-rail-track")
      .evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().width)));
    expect(tracks.length).toBeGreaterThan(20);
    for (const width of tracks) expect(width).toBeGreaterThanOrEqual(60);
  });

  test("shows each row's supporting fact in full", async ({ page }) => {
    await openAccounts(page);

    // "119 subn…" is not a fact. The account boards carry no logos and no
    // disclosures, so the media and caret columns are dropped for those lists
    // and the reclaimed width goes to the text.
    const clipped = await page
      .locator(".mg-ranked-rail-meta")
      .evaluateAll((nodes) => nodes.filter((n) => n.scrollWidth > n.clientWidth + 1).length);
    expect(clipped).toBe(0);
  });

  test("keeps a list's columns identical across its own rows", async ({ page }) => {
    await openAccounts(page);

    // Column presence is a per-LIST decision. Deciding it per row is what
    // broke the shared left edge before: a rail whose bars start at different
    // x cannot be compared by length, which is the only thing it is for.
    const perList = await page.locator(".mg-ranked-rail").evaluateAll((lists) =>
      lists.map((list) => {
        const rows = [...list.querySelectorAll(".mg-ranked-rail-row")];
        return new Set(rows.map((row) => getComputedStyle(row).gridTemplateColumns)).size;
      }),
    );
    expect(perList.length).toBeGreaterThan(0);
    for (const distinct of perList) expect(distinct).toBe(1);
  });

  test("keeps the phone composition on a phone", async ({ page }) => {
    await openAccounts(page, 375, 812);
    const row = await page.locator(".mg-ranked-rail-row").first().boundingBox();
    expect(row).not.toBeNull();
    expect(row!.x).toBeGreaterThanOrEqual(0);
    expect(row!.x + row!.width).toBeLessThanOrEqual(375);

    // The per-list column rules outrank the phone override on specificity
    // rather than source order, so left unbounded they silently reimposed the
    // desktop template here. Counting columns cannot see that — both
    // templates happen to have four — so this compares the FIRST TRACK's
    // width: 1.5rem/24px on the phone against 1.75rem/28px on the desktop.
    const firstColumn = await page
      .locator(".mg-ranked-rail-row")
      .first()
      .evaluate((n) => Number.parseFloat(getComputedStyle(n).gridTemplateColumns));
    expect(firstColumn).toBeCloseTo(24, 0);
    // And the phone drops the rail outright: a 40px bar compares nothing.
    await expect(page.locator(".mg-ranked-rail-track").first()).toBeHidden();
  });
});
