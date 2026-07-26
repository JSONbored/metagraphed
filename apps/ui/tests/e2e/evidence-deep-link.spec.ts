import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";

// #6434 (historical): /subnets/:netuid used to render EvidencePanel twice -- a
// preview embedded in the Overview tab and the full section under a dedicated
// Evidence tab, both claiming id="evidence" with SECTION_TO_TAB mapping that
// id to "overview" -- so a reader who opened the Evidence tab with #evidence
// bounced straight back to Overview. The fix gave the Overview embed its own
// `evidence-preview` id and pointed the bare `evidence` id at the tab that
// actually owned it.
//
// #8247 retired the Overview preview embed entirely (Overview is now a
// one-screen page of only the highest-signal facts, and a second, lower-
// density copy of the same primary-sources list the About tab already owns
// is exactly the kind of duplicate-fact the redesign removed) and folded the
// dedicated Evidence tab into the broader About tab. `evidence-preview` stays
// in SECTION_TO_TAB pointing at "overview" so an old bookmarked link degrades
// gracefully (lands on Overview, finds no matching element, no-ops) rather
// than erroring -- but there is no longer a section to assert visible there.
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
  await page.goto(url);
  // HAR responses resolve instantly, which starves "networkidle" of the quiet
  // window it needs on a route with recurring refetches -- fall back to a fixed
  // settle rather than hanging (same rationale as responsive-overflow.spec.ts).
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    await page.waitForTimeout(2000);
  }
}

test.describe("#6434 evidence deep links (updated for #8247's 7-tab consolidation)", () => {
  test("#evidence resolves to the About tab", async ({ page }) => {
    await openWithHar(page, `${ROUTE}#evidence`);

    // useHashScroll rewrites the tab search param when the hash's owning tab
    // isn't active -- Evidence now lives inside the broader About tab rather
    // than a dedicated tab of its own.
    await expect(page).toHaveURL(/[?&]tab=about/);
    await expect(page.locator("section#evidence")).toBeVisible();
  });

  test("#evidence-preview lands on Overview without erroring (the preview embed itself was retired)", async ({
    page,
  }) => {
    await openWithHar(page, `${ROUTE}#evidence-preview`);

    // SECTION_TO_TAB still maps this legacy id to "overview" so an old
    // bookmarked link degrades gracefully instead of dragging the reader onto
    // a tab that doesn't own it -- but the Overview preview section itself no
    // longer exists (retired as a duplicate of About's full EvidencePanel).
    await expect(page).not.toHaveURL(/[?&]tab=(about|evidence)/);
    await expect(page.locator("section#evidence-preview")).toHaveCount(0);
  });
});
