import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.js";

// #6434: /subnets/:netuid renders EvidencePanel twice -- a preview embedded in
// the Overview tab and the full section under the dedicated Evidence tab. Both
// used to claim id="evidence", and SECTION_TO_TAB mapped that id to "overview",
// so useHashScroll bounced a reader who opened the Evidence tab with #evidence
// straight back to Overview: the tab's own SectionAnchor "copy link" button
// produced a URL that navigated away from the tab it was copied from.
//
// The fix gives the Overview embed its own `evidence-preview` id (the
// preview-vs-full split providers.$slug.tsx already uses for
// `subnets-served-preview` vs `subnets-served`) and points the bare `evidence`
// id at the tab that actually owns it. These two tests pin both directions of
// that mapping -- the first one fails on the pre-fix code, which is the point.
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

test.describe("#6434 evidence deep links", () => {
  test("#evidence resolves to the dedicated Evidence tab", async ({ page }) => {
    await openWithHar(page, `${ROUTE}#evidence`);

    // useHashScroll rewrites the tab search param when the hash's owning tab
    // isn't active, so landing on Overview with #evidence must switch tabs.
    await expect(page).toHaveURL(/[?&]tab=evidence/);
    await expect(page.locator("section#evidence")).toBeVisible();
  });

  test("#evidence-preview stays on the Overview tab", async ({ page }) => {
    await openWithHar(page, `${ROUTE}#evidence-preview`);

    // The preview lives on Overview (the default tab), so the hash must not
    // drag the reader onto the Evidence tab.
    await expect(page).not.toHaveURL(/[?&]tab=evidence/);
    await expect(page.locator("section#evidence-preview")).toBeVisible();
  });
});
