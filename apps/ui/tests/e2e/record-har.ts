#!/usr/bin/env node
// Records one HAR fixture per ROUTES entry against a running dev server,
// capturing every request to api.metagraph.sh so responsive-overflow.spec.ts
// can replay them deterministically instead of hitting live production data.
//
// Why this exists: the overflow check's dev server has no fixture layer of
// its own -- DEFAULT_API_BASE (src/lib/metagraphed/config.ts) points at real
// production by default, so the browser's requests are intercepted with
// page.routeFromHAR instead.
//
// THAT IS NOT THE WHOLE STORY, and the sentence that used to stand here said
// it was: "this app fetches all its data client-side (no SSR loaders --
// confirmed empirically)". It does not. router.tsx wires
// `setupRouterSsrQueryIntegration`, so a route's `useSuspenseQuery` also runs
// in the worker, where routeFromHAR cannot reach it. Those requests go to live
// production on every run. The empirical check that "confirmed" otherwise was
// run against `vite dev`, which fires no queries at all -- see the recording
// trap below. A fixture that omits a path the page reads therefore does not
// abort loudly; it silently reads production (#10938).
//
// Before this, the overflow baseline
// silently went stale whenever live chain/incident data changed shape,
// failing PRs that never touched the affected pages (see the /status
// incidents-feed overflow that sat undetected for ~14h until unrelated data
// changed underneath it).
//
// RECORD AGAINST THE SERVER THE SPEC USES, which is the one
// playwright.config.ts starts: `node tests/e2e/serve-e2e.ts $PORT` over a
// built worker bundle (`npm run build:worker` first), NOT `vite dev`.
//
// That distinction is not pedantry -- it is how this drifted (#10938).
// Measured 2026-08-12: under `vite dev` the /chain/analytics page issues
// ZERO `/api/v1/` requests (the shell renders, no query fires), so a
// recording made the documented way produced an EMPTY har; under the e2e
// server the same page issues 14, four of which the committed fixture
// lacked. With `notFound: "abort"` those four aborted, the page rendered its
// error state, and main went red on a backend-only commit.
//
//   npm run build:worker --workspace=apps/ui
//   node tests/e2e/serve-e2e.ts 8080 &        # the port playwright.config uses
//   npm run test:e2e:record-har --workspace=apps/ui
//
// The PORT is the same either way, which is exactly why the mistake is easy:
// `npm run dev` also listens on 8080, and a recording made against it looks
// like it worked.
//
// AND BUILD WITH `build:worker`, NOT `build:worker:e2e` (#10938). The `:e2e`
// build bakes VITE_METAGRAPH_API_BASE at the local stub, so the app requests
// 127.0.0.1:8081 and this recorder's `urlFilter: "**/api.metagraph.sh/**"`
// matches nothing -- another silently-empty HAR, the same failure the vite-dev
// trap above produces. Record against a production-pointed build; the stub is
// what REPLAYS those recordings afterwards.
//
// A browser recording still cannot capture an SSR-only endpoint -- the server
// makes those requests, and they never pass through a page. `node
// tests/e2e/api-stub.ts 8081 --record` fills those from production into
// har/ssr-supplement.json, which is the other half of the fixture set.
//
// Re-run whenever a page's real API surface changes (new query, new
// endpoint) -- a stale HAR makes the replayed test abort loudly on a
// request that isn't in the recording, which is the intended signal that a
// re-record is due, not a silent fall-through back to live data.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { ROUTES, VIEWPORTS } from "./overflow-check.config.ts";
import { HAR_DIR, harPathForRoute } from "./har-path.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

/**
 * Which routes to re-record, comma-separated; every route when unset.
 *
 * A page's API surface changes one page at a time, but this script rewrote all
 * 25 fixtures on every run -- so a one-route fix arrived as a 25-file diff in
 * which the one intended change was unreviewable, and 24 fixtures silently
 * took on whatever production happened to be serving that afternoon. Each of
 * those is a chance for the overflow baseline to shift for reasons unrelated
 * to the change.
 *
 *   RECORD_ROUTES='/chain;/status' npm run test:e2e:record-har --workspace=apps/ui
 *
 * The example named /chain/analytics until #11619 retired it into /chain. A
 * usage line has to name a route the sweep still visits: `only` is checked
 * against ROUTES and throws on anything else, so a stale example is a copied
 * command that fails.
 */
// Semicolon-separated: a swept route may itself contain a comma
// (`/compare?subnets=1,19`), which a comma-separated list cannot express.
const only = process.env.RECORD_ROUTES?.split(";")
  .map((r) => r.trim())
  .filter(Boolean);
const targets = only?.length ? ROUTES.filter((r) => only.includes(r)) : ROUTES;
if (only?.length) {
  const unknown = only.filter((r) => !ROUTES.includes(r));
  if (unknown.length > 0) {
    // A typo would otherwise record nothing and exit 0, leaving the fixture
    // exactly as stale as it was while the run looked successful.
    throw new Error(
      `RECORD_ROUTES names ${unknown.join(", ")}, which ROUTES does not list. ` +
        `A fixture only exists for a route the sweep visits.`,
    );
  }
  console.log(`Recording ${targets.length} of ${ROUTES.length} routes: ${targets.join(", ")}`);
}

mkdirSync(HAR_DIR, { recursive: true });

const browser = await chromium.launch();

for (const route of targets) {
  const harPath = harPathForRoute(route);
  const context = await browser.newContext({
    recordHar: { path: harPath, urlFilter: "**/api.metagraph.sh/**" },
  });
  // Every viewport, into ONE har. A route does not request the same thing at
  // every width: below `md` the list shells render cards instead of a table,
  // and the card path fetches endpoints the table path never touches. A HAR
  // recorded at a single width therefore satisfies that width and leaves the
  // others rendering an empty state -- which used to be invisible, because
  // an empty page has no overflow violations to report. /chain/extrinsics and
  // /chain/governance were both caught exactly this way: recorded and
  // verified at 1280, still empty at 1024 and 375.
  for (const viewport of VIEWPORTS) {
    // A FRESH page per viewport, not one page re-navigated four times.
    // Reusing it produced a reproducible net::ERR_FAILED partway through
    // (same routes, same width) while the very same URL served 200 to curl.
    const page = await context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Retry the navigation: the `wrangler dev` server backing this drops a
    // request occasionally (see the ProxyController note in
    // playwright.config.ts), and losing a whole 40-route recording run to one
    // transient ERR_FAILED is a bad trade for three lines.
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(BASE_URL + route, { waitUntil: "domcontentloaded" });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        console.warn(`  retry ${attempt} for ${route} @${viewport.width}: ${String(error)}`);
        await page.waitForTimeout(2000);
      }
    }
    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      // /explorer polls continuously and never reaches networkidle; give it a
      // fixed settle window instead so recording still captures its initial
      // load (mirrors the same "can't reach networkidle" caveat the overflow
      // check itself carries for this one route).
      await page.waitForTimeout(5000);
    }
    await page.close();
  }
  await context.close(); // flushes the HAR to disk
  console.log(`Recorded ${route} -> ${harPath}`);
}

await browser.close();
console.log(`\nWrote ${ROUTES.length} HAR fixture(s) to ${HAR_DIR}`);
