import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";

// #8384: the PWA foundation's own e2e coverage (issue requirement 7) --
// registers public/sw.js against the SAME HAR-replay fixtures every other
// e2e spec in this directory uses (deterministic, no live chain data), then
// flips the browser context offline and asserts:
//   1. reopening a PREVIOUSLY visited route serves the SW's cached shell
//      instead of the browser's own network-error interstitial;
//   2. navigating to a route that was NEVER visited online falls back to the
//      static public/offline.html page, not a browser error page.
// Hydration-dependent behavior (the offline banner, watchlist rows served
// from the SWR API cache, the cached-age affordance) needs a real
// `/assets/*.js` bundle to re-run React offline with -- Vite dev mode serves
// unbundled, individually-fetched ES modules instead, which this hand-rolled
// worker deliberately doesn't try to cache (see isAppShellAsset's own
// comment in public/sw.js). Verified separately against a production build
// (`npm run build && npm run preview`) instead -- see the PR body.
//
// Uses `context.routeFromHAR`/`context.route` (not the page-scoped
// variants) deliberately: the service worker's own `fetch()` calls run in a
// separate execution context from the page, and only context-level routing
// is guaranteed to intercept those too, alongside the page's own requests.
const ROUTE = "/";
const harPath = harPathForRoute(ROUTE);

if (!existsSync(harPath)) {
  throw new Error(
    `Missing HAR fixture for ${ROUTE}: ${harPath}. Run ` +
      `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
  );
}

// #9079: the WHOLE block is deferred, not deleted. Since #8928 this suite
// runs against the production Worker instead of the Vite dev server, and BOTH
// cases fail there -- the never-visited route with net::ERR_FAILED (the very
// browser network-error page the SW exists to prevent), and the
// previously-visited route intermittently too. It is not a missing asset:
// /offline.html, /sw.js and /apis/schemas all serve 200 from the built Worker,
// and the SW registers. The offline navigation path itself behaves differently
// under real-Worker serving.
//
// This spec was always dev-server-coupled -- its own header below records that
// production behaviour was "verified separately" BY HAND and never gated. So
// #8928 did not break it; it revealed that the production path was never
// actually covered.
//
// Left as fixme rather than "fixed" because the two candidate causes must be
// distinguished against a DEPLOYED preview first: either the offline fallback
// is genuinely broken in production (#8384's promise not kept, a user-facing
// bug), or this is a wrangler-dev asset-serving artifact. Editing the SW or
// the assertions now would paper over the first case.
test.describe.fixme("#8384 offline PWA shell", () => {
  test("a previously-visited route reopens from the service worker's cache while offline, instead of a browser network-error page", async ({
    page,
    context,
  }) => {
    await context.routeFromHAR(harPath, {
      url: "**/api.metagraph.sh/**",
      notFound: "fallback",
      update: false,
    });
    for (const pattern of DATED_ENDPOINT_PATTERNS) {
      const fixture = findHarFixture(harPath, pattern);
      if (fixture) await context.route(pattern, (route) => route.fulfill(fixture));
    }

    await page.goto(ROUTE);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, {
      timeout: 15_000,
    });

    // The FIRST navigation happened before the service worker existed, so it
    // was never cached by handleNavigation -- reload now that the worker
    // controls this page so this reload actually goes through public/sw.js's
    // fetch handler and caches the response.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await context.setOffline(true);
    await page.reload();

    // The cached shell renders (a real page, not a browser network-error
    // interstitial) AND it's specifically the cached HOME shell, not a
    // silent fallback to public/offline.html (which handleNavigation only
    // ever uses for a route with no cache entry at all -- see the second
    // test below).
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "You're offline" })).toHaveCount(0);
  });

  test("a route never visited online falls back to the static offline page instead of a browser error", async ({
    page,
    context,
  }) => {
    await context.routeFromHAR(harPath, {
      url: "**/api.metagraph.sh/**",
      notFound: "fallback",
      update: false,
    });

    // Register the service worker via a real (HAR-served) load of the home
    // route first -- a worker can only ever serve public/offline.html once
    // it's actually installed and controlling the page.
    await page.goto(ROUTE);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, {
      timeout: 15_000,
    });

    await context.setOffline(true);
    // /apis/schemas was never opened this session, so the SW has no cached
    // shell for it and must fall through to public/offline.html.
    await page.goto("/apis/schemas");

    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("link", { name: /go to your watchlist/i })).toBeVisible();
  });
});
