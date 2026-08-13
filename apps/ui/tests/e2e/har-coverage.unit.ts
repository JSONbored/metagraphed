// The fixture-coverage ratchet for the overflow sweep (#10938).
//
// Runs in vitest, not Playwright, and that is the point: `npm test
// --workspace=apps/ui` runs BEFORE `build:worker` and `test:e2e` in the `ui`
// job, so an uncovered path is named in seconds instead of surfacing as a
// mid-sweep "rendered an error state" whose real cause is production.
//
// `.unit.ts` rather than `.test.ts` because playwright.config.ts sets testDir
// to ./tests/e2e and its default testMatch claims *.test.ts -- see the note in
// apps/ui/vitest.config.ts.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./overflow-check.config.ts";
import { harPathForRoute } from "./har-path.ts";
import {
  coverageForRoute,
  declaredApiPaths,
  harRecordedPaths,
  resolveRouteFile,
  routeFileIndex,
} from "./har-coverage.ts";

const index = routeFileIndex();

/**
 * Declared paths a fixture does NOT cover today, and therefore fetches from
 * live production on every sweep.
 *
 * A SNAPSHOT, NOT AN EXEMPTION -- the same shape as overflow-baseline.json
 * beside it, and for the same reason: the backlog is real, pre-existing, and
 * not something this check should force-fix. New entries fail; so does an
 * entry that is no longer needed (see the two assertions below). A list only
 * ever added to is not a ratchet.
 *
 * WHY THIS CANNOT SIMPLY BE RECORDED AWAY. These are SSR fetches. The page's
 * `useSuspenseQuery` runs in the worker, which renders the answer straight
 * into the HTML -- measured 2026-08-12: `curl` of the local e2e server returns
 * "Schemas 65 Stable 57 New 1 Drift 7 Contracts 225", live production numbers,
 * in server-rendered markup. The browser therefore never re-requests those
 * paths, and record-har.ts records the BROWSER. Re-recording the ten affected
 * routes moved exactly one of them (/validators, whose queries are
 * client-side) and made /status worse by dropping a path that happened not to
 * fire that run.
 *
 * Emptying this list means intercepting the WORKER's outbound fetches, not
 * recording harder. #10938 tracks that; the header of responsive-overflow.spec
 * records the previous attempt (a local stub the worker could not reliably
 * reach under the parallel sweep).
 */
const KNOWN_UNCOVERED: Record<string, string[]> = {
  "/status": ["/api/v1/feeds/incidents", "/api/v1/self-health"],
  "/settings": ["/api/v1/keys", "/api/v1/watch/triggers", "/api/v1/webhooks/subscriptions"],
  "/apis/schemas": ["/api/v1/contracts", "/api/v1/schemas"],
  "/chain/blocks": ["/api/v1/blocks/summary", "/api/v1/chain/activity"],
  "/chain/events": ["/api/v1/chain-events/stats"],
  "/chain/extrinsics": ["/api/v1/chain/fees", "/api/v1/extrinsics"],
  "/chain/analytics": [
    "/api/v1/chain/concentration",
    "/api/v1/chain/idle-stake",
    "/api/v1/chain/stake-flow",
    "/api/v1/economics",
    "/api/v1/economics/trends",
    "/api/v1/validators",
  ],
  "/chain/runtime": ["/api/v1/network/parameters", "/api/v1/runtime"],
  "/accounts": [
    "/api/v1/accounts",
    "/api/v1/accounts/top-holders",
    "/api/v1/accounts/{ss58}",
    "/api/v1/chain/signers",
  ],
};

describe("every swept route resolves to a page", () => {
  // Guards the guard: coverageForRoute reports "nothing declared" both for a
  // page that declares nothing and for a page it failed to find, and those
  // must not look alike.
  it.each(ROUTES)("%s is served by a createFileRoute", (route) => {
    expect(() => resolveRouteFile(route, index)).not.toThrow();
  });

  it("throws on a route no file declares", () => {
    expect(() => resolveRouteFile("/not-a-real-route", index)).toThrow(/No createFileRoute/);
  });
});

describe("no route grows a NEW live-production dependency", () => {
  // THE #10938 GATE. A declared path with no recorded entry is fetched from
  // live production on every sweep, so the overflow result depends on
  // production being healthy: `main` failed the `ui` job three times running
  // on e1bd435ab, a backend-only commit that could not touch any page.
  it.each(ROUTES)("%s", (route) => {
    const harPath = harPathForRoute(route);
    expect(existsSync(harPath), `no HAR fixture at ${harPath}`).toBe(true);
    const { missing } = coverageForRoute(route, harPath, index);
    const known = KNOWN_UNCOVERED[route] ?? [];
    const added = missing.filter((p) => !known.includes(p));
    expect(
      added,
      added.length === 0
        ? ""
        : `${route} declares ${added.length} API path(s) its HAR fixture does not ` +
            `record:\n  ${added.join("\n  ")}\n\n` +
            `If the page fetches these in the BROWSER, re-record just this route:\n` +
            `  npm run build:worker --workspace=apps/ui\n` +
            `  node apps/ui/tests/e2e/serve-e2e.ts 8080 &\n` +
            `  RECORD_ROUTES=${route} npm run test:e2e:record-har --workspace=apps/ui\n` +
            `(NOT \`vite dev\` -- it listens on the same port and records nothing.)\n\n` +
            `If it fetches them during SSR, recording cannot reach them: add them to ` +
            `KNOWN_UNCOVERED with that reason, and know that the overflow sweep for ` +
            `this route now depends on production answering.`,
    ).toEqual([]);
  });
});

describe("the known-uncovered list can only shrink", () => {
  // The other half of a ratchet, and the half that is usually missing: a
  // ceiling nobody lowers stops being one. validate-unreferenced-exports.ts
  // fails the same way when the count IMPROVES without the ceiling moving.
  it.each(Object.keys(KNOWN_UNCOVERED))("%s lists nothing already fixed", (route) => {
    const { missing } = coverageForRoute(route, harPathForRoute(route), index);
    const stale = (KNOWN_UNCOVERED[route] ?? []).filter((p) => !missing.includes(p));
    expect(
      stale,
      `${route}'s fixture now covers ${stale.join(", ")}. Remove ${
        stale.length === 1 ? "it" : "them"
      } from KNOWN_UNCOVERED so the gain is locked in.`,
    ).toEqual([]);
  });

  it("names only routes the sweep actually visits", () => {
    expect(Object.keys(KNOWN_UNCOVERED).filter((r) => !ROUTES.includes(r))).toEqual([]);
  });
});

describe("the detector can fail", () => {
  // A gate nobody has watched fail is a gate nobody knows works. These drive
  // the pure functions over inputs whose answer is known by construction.
  const fixtureHar = harPathForRoute("/chain/analytics");

  it("reports a declared path the HAR never recorded", () => {
    const recorded = harRecordedPaths(fixtureHar);
    expect(recorded.has("/api/v1/definitely-not-recorded")).toBe(false);
    expect(["/api/v1/definitely-not-recorded"].filter((p) => !recorded.has(p))).toEqual([
      "/api/v1/definitely-not-recorded",
    ]);
  });

  it("drops the query string before comparing", () => {
    // The HAR records `/api/v1/subnets?limit=128`; a footer declares
    // `/api/v1/subnets`. Comparing raw URLs would call every path missing.
    expect(harRecordedPaths(fixtureHar).has("/api/v1/subnets")).toBe(true);
  });

  it("reads paths out of a page reached through a local import", () => {
    // chain.analytics.tsx renders nothing itself -- the footer lives in
    // -chain-analytics-page.tsx, so a non-recursive reader would see zero
    // declared paths here and call the fixture complete.
    const declared = declaredApiPaths(resolveRouteFile("/chain/analytics", index));
    expect(declared).toContain("/api/v1/chain/concentration");
    expect(declared.length).toBeGreaterThan(5);
  });
});
