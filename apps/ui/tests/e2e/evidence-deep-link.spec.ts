import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

// #6434 (historical): /subnets/:netuid used to render EvidencePanel twice -- a
// preview embedded in the Overview tab and the full section under a dedicated
// Evidence tab, both claiming id="evidence" with SECTION_TO_TAB mapping that
// id to "overview" -- so a reader who opened the Evidence tab with #evidence
// bounced straight back to Overview.
//
// #11612 rebuilt the route as seven sections on one page with no tab bar at
// all, so the class of bug this file was opened for cannot recur: there is
// nothing left to switch. What it still guards is the invariant that made the
// bug possible -- that a hash deep link is a PLAIN in-page anchor. Nothing may
// translate a fragment into a search param, and the sections the nav names
// must be the sections the document contains.
//
// The evidence section itself is gone; its primary-source URLs live in the
// page's `Raw` block, and every URL on the page lives there. An old
// `#evidence` bookmark degrades to the page top, which is asserted below
// rather than assumed.
//
// Deterministic by design, mirroring responsive-overflow.spec.ts: the route
// replays tests/e2e/har/subnets-1.har rather than hitting live chain data, so
// a subnet's evidence changing shape can never make this flap.
const ROUTE = "/subnets/1";
const harPath = harPathForRoute(ROUTE);

if (!existsSync(harPath)) {
  throw new Error(
    `Missing HAR fixture for ${ROUTE}: ${harPath}. Run ` +
      `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
  );
}

/** Replay recorded API traffic + settle, matching responsive-overflow.spec.ts. */
async function openWithHar(page: import("@playwright/test").Page, url: string) {
  await page.routeFromHAR(harPath, {
    url: "**/api.metagraph.sh/**",
    notFound: "fallback",
    update: false,
  });
  // Registered after routeFromHAR so date-stamped endpoints still resolve to
  // the recorded fixture rather than falling through to live data.
  for (const pattern of DATED_ENDPOINT_PATTERNS) {
    const fixture = findHarFixture(harPath, pattern);
    if (fixture) {
      await page.route(pattern, (route) => route.fulfill(fixture));
    }
  }
  await gotoThroughRestart(page, url);
  // HAR responses resolve instantly, which starves "networkidle" of the quiet
  // window it needs on a route with recurring refetches -- fall back to a fixed
  // settle rather than hanging (same rationale as responsive-overflow.spec.ts).
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    await page.waitForTimeout(2000);
  }
}

test.describe("#6434 hash deep links on the subnet page (no tab bar since #11612)", () => {
  test("a hash names a real section, and nothing rewrites it into a search param", async ({
    page,
  }) => {
    await openWithHar(page, `${ROUTE}#surfaces`);

    await expect(page).toHaveURL(/#surfaces$/);
    await expect(page).not.toHaveURL(/[?&]tab=/);
    await expect(page.locator("section#surfaces")).toBeVisible({ timeout: 15_000 });
  });

  test("every section the nav offers is a section the document has", async ({ page }) => {
    await openWithHar(page, ROUTE);

    const targets = await page
      .locator('[data-mg-section-nav] a[href^="#"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")!.slice(1)));
    expect(targets.length).toBeGreaterThan(0);
    for (const id of targets) {
      await expect(page.locator(`section#${id}`)).toHaveCount(1);
    }
  });

  test("a retired section id degrades to the page top instead of erroring", async ({ page }) => {
    // `#evidence` and `#evidence-preview` both named sections that no longer
    // exist. Nothing rewrites the URL, no such section is found, and the page
    // renders exactly as it would without the hash.
    for (const hash of ["evidence", "evidence-preview"]) {
      await openWithHar(page, `${ROUTE}#${hash}`);
      await expect(page).not.toHaveURL(/[?&]tab=/);
      await expect(page.locator(`section#${hash}`)).toHaveCount(0);
      await expect(page.locator("[data-mg-hero]")).toBeVisible();
    }
  });
});
