#!/usr/bin/env node
// Records one HAR fixture per ROUTES entry against a running dev server,
// capturing every request to api.metagraph.sh so responsive-overflow.spec.ts
// can replay them deterministically instead of hitting live production data.
//
// Why this exists: the overflow check's dev server has no fixture layer of
// its own -- DEFAULT_API_BASE (src/lib/metagraphed/config.ts) points at real
// production by default, and this app fetches all its data client-side (no
// SSR loaders -- confirmed empirically: the raw server-rendered HTML has no
// embedded query state or subnet/incident data, just the static shell), so
// intercepting browser-level requests via page.routeFromHAR is sufficient --
// no server-process-level mocking needed. Before this, the overflow baseline
// silently went stale whenever live chain/incident data changed shape,
// failing PRs that never touched the affected pages (see the /status
// incidents-feed overflow that sat undetected for ~14h until unrelated data
// changed underneath it).
//
// Run after starting a dev server (`npm run dev --workspace=apps/ui`), and
// re-run whenever a page's real API surface changes (new query, new
// endpoint) -- a stale HAR makes the replayed test abort loudly on a
// request that isn't in the recording (notFound: "abort" in the spec),
// which is the intended signal that a re-record is due, not a silent
// fall-through back to live data.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { ROUTES, VIEWPORTS } from "./overflow-check.config.ts";
import { HAR_DIR, harPathForRoute } from "./har-path.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

mkdirSync(HAR_DIR, { recursive: true });

const browser = await chromium.launch();

for (const route of ROUTES) {
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
