import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { findOverflowViolations } from "./find-overflow-violations.ts";
import {
  ROUTES,
  VIEWPORTS,
  ERROR_STATE_ALLOWED,
  EMPTY_LIST_ALLOWED,
  NO_API_ROUTES,
} from "./overflow-check.config.ts";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

// ZERO TOLERANCE: nothing may escape the viewport, at any of the four widths.
//
// This was a baseline diff for two years. The app carried pre-existing overflow
// bugs (#3930, #3931, #3985) that were separately-scored contributor work, so
// the check compared against a snapshot of KNOWN violations and failed only on
// a NEW one -- which caught regressions without making every apps/ui PR red
// until the backlog cleared.
//
// The backlog cleared. The v2 rebuild (#11604) emptied
// `overflow-baseline.json` completely: 76 route@width keys, every one of them
// an empty array. A baseline that grants nothing is not a baseline, and keeping
// the file would leave `test:e2e:update-baseline` standing as a way to make a
// real overflow bug pass by re-recording it -- the one escape hatch this gate
// must not have. Both are deleted; the assertion is now `toEqual([])` against
// the detector's raw output.
//
// Deterministic by design: every route replays a HAR fixture
// (tests/e2e/har/*.har, recorded via `npm run test:e2e:record-har`) instead
// of hitting live production data. Before this, the set of DOM elements a
// route rendered (and therefore what could overflow) depended on live chain
// state -- a subnet's incident history changing shape could newly trip this
// check for a PR that never touched the affected page (confirmed: the
// /status page's incidents-feed overflow, introduced by an unrelated PR,
// sat undetected for ~14h until live incident data happened to surface it).
// Re-record the HAR (in addition to the baseline, if the DOM also changed)
// whenever a route's real API surface changes -- a stale HAR aborts/falls
// back predictably rather than silently drifting.
function fingerprint(v: { tag: string; cls: string }): string {
  return `${v.tag}:${v.cls}`;
}

for (const route of ROUTES) {
  test.describe(route, () => {
    const harPath = harPathForRoute(route);
    // A route that reads no API has nothing to replay; requiring a fixture is
    // what kept /privacy, /terms and /design/primitives outside this sweep.
    const needsFixture = !NO_API_ROUTES.has(route);
    if (needsFixture && !existsSync(harPath)) {
      throw new Error(
        `Missing HAR fixture for ${route}: ${harPath}. Run ` +
          `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
      );
    }

    for (const viewport of VIEWPORTS) {
      test(`no new overflow-escaping elements at ${viewport.name} (${viewport.width}px)`, async ({
        page,
      }) => {
        // Replay the recorded API traffic instead of hitting live production.
        //
        // BOTH SIDES ARE COVERED NOW (#10938), and only one of them is covered
        // here. The app fetches during SSR too -- router.tsx wires
        // `setupRouterSsrQueryIntegration`, so a route's `useSuspenseQuery`
        // runs in the worker -- and `page.routeFromHAR` cannot intercept a
        // request the SERVER makes. Those reached live production on every run
        // until the `:e2e` build pinned VITE_METAGRAPH_API_BASE at
        // tests/e2e/api-stub.ts, which replays these same fixtures to the
        // server. Playwright starts that stub as its first webServer.
        //
        // (An older version of this comment claimed the app "fetches
        // everything client-side -- no SSR loaders, confirmed empirically".
        // That was measured against `vite dev`, where the page issues no API
        // requests at all, and it cost real debugging time.)
        //
        // This routeFromHAR therefore matters only for a build still pointed at
        // api.metagraph.sh -- a local `npm run build:worker` run. Under the
        // `:e2e` build the browser talks to the stub as well, so the two paths
        // serve the same bytes either way.
        //
        // `notFound: "fallback"` (not "abort"): a handful of background/retry
        // requests genuinely fall outside any single recorded snapshot
        // (react-query refetch intervals keep firing after the recording window
        // closes) -- aborting those wedges the page in an infinite
        // request/retry loop instead of settling. Everything the initial render
        // needs IS in the recording (the record script waits for networkidle
        // before saving), so the fixture still fully determines what is on
        // screen when this check reads the DOM.
        if (needsFixture) {
          await page.routeFromHAR(harPath, {
            url: "**/api.metagraph.sh/**",
            notFound: "fallback",
            update: false,
          });
        }
        // Registered AFTER routeFromHAR (Playwright matches the most-recently
        // registered handler first), so a dated endpoint's fixture is served
        // regardless of which date the live app requests today -- otherwise
        // it would miss the HAR's exact-URL match and fall back to live data
        // (see DATED_ENDPOINT_PATTERNS in har-path.js for why).
        if (needsFixture) {
          for (const pattern of DATED_ENDPOINT_PATTERNS) {
            const fixture = findHarFixture(harPath, pattern);
            if (fixture) {
              await page.route(pattern, (route) => route.fulfill(fixture));
            }
          }
        }
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await gotoThroughRestart(page, route);
        // HAR-replayed responses resolve near-instantly (no real network
        // latency), which removes the natural gaps "networkidle" needs to
        // detect quiet -- pages with any recurring refetch/poll (/, /subnets/1,
        // /explorer all have one) never produce a 500ms idle window under
        // replay and hang until the test timeout. Try networkidle first (the
        // common case settles well within this), but fall back to a fixed
        // settle window rather than hanging -- HAR responses are instant, so
        // 2s is generous for the initial render to finish regardless of route.
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          await page.waitForTimeout(2000);
        }
        // Self-hosted brand fonts (apps/ui/src/styles.css) load via
        // font-display: swap -- the page paints with a fallback font
        // immediately, then reflows onto the real font whenever its woff2
        // finishes downloading. That download is real network activity
        // (unlike the HAR-mocked API calls above), so its timing isn't
        // bounded by the fixed 2s fallback above -- it can still be
        // in-flight when overflow gets measured, producing an
        // environment/timing-dependent false positive (surfaced by #4876:
        // reproduced non-deterministically both locally and in CI, exact
        // same 3-element diff every time it fired, only after fonts were
        // self-hosted). Block until the swap is guaranteed to have happened.
        await page.evaluate(() => document.fonts.ready);

        // An empty page cannot overflow, so "no new violations" is also what
        // a route that rendered NOTHING looks like. That is not theoretical:
        // chain-extrinsics.har went stale, /chain/extrinsics rendered its
        // filters and an empty state with no table at all, and this sweep
        // stayed green on it until a different spec demanded real rows.
        // Assert the route actually rendered before trusting its measurement.
        // A RETRYING assertion, not a snapshot count. `isEmpty` in ListShell
        // is `rows.length === 0`, which is also true for the moment before
        // data arrives -- so a one-shot `.count()` reports a page that is
        // merely still loading as a page that rendered nothing. That made the
        // check itself flaky on /chain/extrinsics and /chain/governance,
        // fixtures that had just been re-recorded and verified. toHaveCount
        // polls until the empty state actually settles or the timeout is hit.
        if (!EMPTY_LIST_ALLOWED.has(`${route}@${viewport.width}`))
          await expect(
            page.locator("[data-mg-list-empty]"),
            `${route} at ${viewport.width}px rendered an EMPTY list. Its overflow ` +
              `measurement is meaningless -- there is nothing on the page to overflow. ` +
              `Almost always a stale HAR fixture: re-record with ` +
              `\`npm run test:e2e:record-har --workspace=apps/ui\`.`,
          ).toHaveCount(0, { timeout: 15_000 });

        // ErrorState renders role="alert". On a fixture-backed run nothing
        // should error, so an alert means either the fixture no longer
        // satisfies the page or an SSR fetch to live production failed.
        // Error states persist once rendered, so the same retrying form is
        // safe here and keeps a slow render from reading as a failure.
        if (!ERROR_STATE_ALLOWED.has(route)) {
          await expect(
            page.locator('[role="alert"]'),
            `${route} at ${viewport.width}px rendered an error state. Either the HAR ` +
              `fixture no longer covers what the page requests, or an SSR fetch (which ` +
              `bypasses HAR replay and hits live production) failed.`,
          ).toHaveCount(0, { timeout: 10_000 });
        }

        const violations = await page.evaluate(findOverflowViolations, viewport.width);
        const escaping = [...new Set(violations.map(fingerprint))];

        expect(
          escaping,
          escaping.length
            ? `${route} at ${viewport.width}px: ${escaping.length} element(s) escape the viewport: ` +
                `${escaping.join(", ")}. Fix the layout -- there is no baseline to record this into.`
            : "",
        ).toEqual([]);
      });
    }
  });
}
