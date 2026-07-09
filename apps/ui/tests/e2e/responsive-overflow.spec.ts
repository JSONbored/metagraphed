import { existsSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { findOverflowViolations } from "./find-overflow-violations.js";
import { ROUTES, VIEWPORTS } from "./overflow-check.config.js";
import { harPathForRoute } from "./har-path.js";

// Baseline-diff, not zero-tolerance: this app has pre-existing, already-tracked
// overflow bugs (#3930, #3931, #3985, etc.) that are separately-scored
// contributor work, not something this check should force-fix or block on.
// The baseline is a snapshot of KNOWN violations at the time it was last
// regenerated; this test fails only on a NEW element escaping the viewport
// that isn't already in that snapshot -- converting "a human might notice a
// new regression by luck" into "CI always catches it," without also making
// every apps/ui PR red until the existing backlog is cleared.
//
// Regenerate after intentionally fixing (shrinks it) or after confirming a
// new entry is an accepted layout choice, not a bug (grows it) --
// `npm run test:e2e:update-baseline --workspace=apps/ui`. Don't hand-edit;
// let the script keep it consistent with the real detector output.
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
const BASELINE_PATH = new URL("./overflow-baseline.json", import.meta.url);
const baseline: Record<string, string[]> = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

function fingerprint(v: { tag: string; cls: string }): string {
  return `${v.tag}:${v.cls}`;
}

for (const route of ROUTES) {
  test.describe(route, () => {
    const harPath = harPathForRoute(route);
    if (!existsSync(harPath)) {
      throw new Error(
        `Missing HAR fixture for ${route}: ${harPath}. Run ` +
          `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
      );
    }

    for (const viewport of VIEWPORTS) {
      test(`no new overflow-escaping elements at ${viewport.name} (${viewport.width}px)`, async ({
        page,
      }) => {
        // Replay the recorded API traffic instead of hitting live production
        // data (this app fetches everything client-side -- no SSR loaders,
        // confirmed empirically against the raw server-rendered HTML -- so
        // browser-level interception is sufficient). `notFound: "fallback"`
        // (not "abort"): a handful of background/retry requests genuinely
        // fall outside any single recorded snapshot (react-query refetch
        // intervals keep firing after the recording window closes) --
        // aborting those wedges the page in an infinite request/retry loop
        // instead of settling. Everything the initial render needs IS in the
        // recording (the record script itself waits for networkidle before
        // saving), so the fixture still fully determines what's on screen
        // when this check reads the DOM.
        await page.routeFromHAR(harPath, {
          url: "**/api.metagraph.sh/**",
          notFound: "fallback",
          update: false,
        });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route);
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

        const violations = await page.evaluate(findOverflowViolations, viewport.width);
        const found = new Set(violations.map(fingerprint));
        const known = new Set(baseline[`${route}@${viewport.width}`] ?? []);
        const newViolations = [...found].filter((f) => !known.has(f));

        expect(
          newViolations,
          newViolations.length
            ? `${route} at ${viewport.width}px: ${newViolations.length} new element(s) escaping the viewport, not in the known baseline: ${newViolations.join(", ")}. If this is confirmed intentional (not a bug), regenerate the baseline; otherwise this is a real regression.`
            : "",
        ).toEqual([]);
      });
    }
  });
}
