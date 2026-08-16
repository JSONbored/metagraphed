import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

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

// #9079 asked which of two things this was: a real production defect, or a
// `wrangler dev` asset-serving artifact. It was the first, and the block is
// live again because the cause is fixed rather than because the assertions
// were loosened.
//
// Measured against DEPLOYED production (metagraph.sh), 2026-08-16, which is
// the distinction the issue said had to be made first:
//
//   GET /offline.html                  -> 307, location: /offline
//   cache.add("/offline.html")         -> { status: 200, redirected: TRUE,
//                                           url: "https://metagraph.sh/offline" }
//
// Cloudflare Workers Assets strips the `.html` extension. `cache.add` follows
// the redirect and succeeds, so the precache looked healthy -- but it stored a
// response flagged `redirected`. A navigation request has redirect mode
// "manual", and answering one from `respondWith` with a redirected response is
// a network error. That is the `net::ERR_FAILED` this issue opened on: not a
// missing asset, and not the SW failing to register, but the fallback response
// itself being unusable for the only kind of request that needs it.
//
// It passed under `npm run dev` because Vite serves `public/offline.html` as a
// file -- no extension stripping, no redirect. The production path had never
// worked; #8928 running the suite against the real Worker is what exposed it.
//
// The fix is in public/sw.js's `precacheOfflineShell`: re-wrap the body so the
// flag is cleared before `cache.put`. This block gates it from here on.
test.describe("#8384 offline PWA shell", () => {
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

    await gotoThroughRestart(page, ROUTE);
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
    await gotoThroughRestart(page, ROUTE);
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
