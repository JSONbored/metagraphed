import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

// #6434 (historical): /subnets/:netuid used to render EvidencePanel twice -- a
// preview embedded in the Overview tab and the full section under a dedicated
// Evidence tab, both claiming id="evidence" with SECTION_TO_TAB mapping that
// id to "overview" -- so a reader who opened the Evidence tab with #evidence
// bounced straight back to Overview. The fix gave the Overview embed its own
// `evidence-preview` id and pointed the bare `evidence` id at the tab that
// actually owned it.
//
// #8247 retired the Overview preview embed entirely (Overview is now a
// one-screen page of only the highest-signal facts) and folded the dedicated
// Evidence tab into the broader Records dossier. `evidence-preview` is kept as
// a legacy alias for the canonical Evidence section, so a saved link lands on
// evidence rather than a quiet, unrelated overview.
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

test.describe("#6434 evidence deep links (updated for the dossier consolidation)", () => {
  test("#evidence resolves to the Records view", async ({ page }) => {
    await openWithHar(page, `${ROUTE}#evidence`);

    // useHashScroll rewrites the tab search param when the hash's owning tab
    // isn't active -- Evidence now lives inside the broader Records view rather
    // than a dedicated tab of its own.
    //
    // The rewrite runs in a useEffect, so it waits on HYDRATION, not on a
    // network round-trip -- which is what openWithHar's networkidle wait
    // covers. On a loaded CI runner (4 parallel workers, cold cache) hydrating
    // this page can outlast the 5s default expect timeout, and the assertion
    // then reports the un-rewritten "#evidence" URL. 15s waits for the thing
    // actually being waited on; the assertion is unchanged, so a rewrite that
    // never happens still fails.
    await expect(page).toHaveURL(/[?&]tab=records/, { timeout: 15_000 });
    await expect(page.locator("section#evidence")).toBeVisible();
  });

  test("#evidence-preview resolves to canonical Evidence (the preview embed was retired)", async ({
    page,
  }) => {
    await openWithHar(page, `${ROUTE}#evidence-preview`);

    // The retired preview id intentionally aliases the mounted canonical
    // Evidence section, preserving old bookmarks without rendering duplicate
    // source lists on the high-signal overview.
    await expect(page).toHaveURL(/[?&]tab=records/, { timeout: 15_000 });
    await expect(page.locator("section#evidence")).toBeVisible();
  });
});
