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
import { ROUTES } from "./overflow-check.config.js";
import { HAR_DIR, harPathForRoute } from "./har-path.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

mkdirSync(HAR_DIR, { recursive: true });

const browser = await chromium.launch();

for (const route of ROUTES) {
  const harPath = harPathForRoute(route);
  const context = await browser.newContext({
    recordHar: { path: harPath, urlFilter: "**/api.metagraph.sh/**" },
  });
  const page = await context.newPage();
  await page.goto(BASE_URL + route, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    // /explorer polls continuously and never reaches networkidle; give it a
    // fixed settle window instead so recording still captures its initial
    // load (mirrors the same "can't reach networkidle" caveat the overflow
    // check itself carries for this one route).
    await page.waitForTimeout(5000);
  }
  await context.close(); // flushes the HAR to disk
  console.log(`Recorded ${route} -> ${harPath}`);
}

await browser.close();
console.log(`\nWrote ${ROUTES.length} HAR fixture(s) to ${HAR_DIR}`);
