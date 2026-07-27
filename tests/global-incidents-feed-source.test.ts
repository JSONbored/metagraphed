import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  configureAnalytics,
  resolveGlobalIncidents,
  resolveGlobalIncidentsForFeed,
} from "../workers/request-handlers/analytics.ts";
import { mockEnv, type Row } from "./row-type.ts";

// The Postgres-tier-miss fallback path (loadGlobalIncidentsLedger) reads
// last-run metadata via this injected reader -- same wiring every other test
// of this module already does (see tests/request-handlers-analytics.test.ts).
// Only the fallback branch below needs it; a plain null is a valid "no
// metadata yet" reading.
configureAnalytics({ readHealthMetaKv: async () => null });

/**
 * #8242: /api/v1/feeds/incidents reported "no incidents" while /status showed
 * dozens ongoing from the same underlying data.
 *
 * Cause was not the feed builder — it was the source. `loadGlobalIncidentsLedger`
 * is a schema-stable EMPTY stub (it hardcodes `incidentRows: []`) meant only as
 * the Postgres-tier-miss fallback. `handleGlobalIncidents` and the GraphQL
 * resolver both try the tier first; the feed injection called the stub directly,
 * so it was empty by construction on every request.
 */
test("the incidents feed resolves through the Postgres tier, not the empty ledger stub", () => {
  const api = readFileSync("workers/api.ts", "utf8");

  // The feed injection must use the dedicated feed resolver...
  assert.match(api, /loadLiveIncidents:\s*resolveGlobalIncidentsForFeed/);
  // ...and must not reach the stub directly.
  assert.doesNotMatch(
    api,
    /loadLiveIncidents:[\s\S]{0,200}?loadGlobalIncidentsLedger\(/,
  );
});

/**
 * metagraphed#8353: #8242's fix was source-correct (it DID call the shared
 * resolver) and still broken in production, because `resolveGlobalIncidents`
 * forwards its `request` argument VERBATIM to the DATA_API service binding --
 * and #8242 passed the feed's own request, for /api/v1/feeds/incidents.json,
 * a path DATA_API has no route for. DATA_API 404'd, tryPostgresTier read that
 * as a tier miss, and the resolver silently returned the empty stub -- the
 * exact "feed says zero, /status says dozens" symptom #8242 believed it had
 * fixed. A source-pattern test (matching "resolveGlobalIncidents(" appearing
 * near "loadLiveIncidents:") could not catch this: the call WAS there, just
 * with the wrong request. This test drives the real functions against a mock
 * DATA_API that distinguishes paths the way the real one does, so it fails on
 * the #8242 shape and passes on the #8353 fix.
 */
test("resolveGlobalIncidentsForFeed reaches real data even though DATA_API has no /api/v1/feeds/* route", async () => {
  const REAL_INCIDENTS = {
    schema_version: 1,
    summary: { incident_count: 3, affected_surface_count: 2 },
    surfaces: [{ netuid: 8, surface_id: "sn8-api", incidents: [] }],
  };
  // Mirrors DATA_API's real dispatcher: matches /api/v1/incidents, 404s on
  // anything else -- including a /api/v1/feeds/* path, which is the whole
  // point (DATA_API genuinely has no route for the feeds surface at all).
  const dataApiFetch = async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/api/v1/incidents") {
      return new Response(JSON.stringify(REAL_INCIDENTS), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
    });
  };
  const env = mockEnv({
    METAGRAPH_HEALTH_SOURCE: "postgres",
    DATA_API: { fetch: dataApiFetch },
  });

  const viaFeedResolver = await resolveGlobalIncidentsForFeed(env);
  assert.deepEqual(viaFeedResolver, REAL_INCIDENTS);

  // Pin the exact failure mode this replaces: forwarding the feed's OWN
  // request (a /api/v1/feeds/incidents.json path) through the general
  // resolver silently degrades to the empty stub, not an error -- which is
  // precisely why #8242's fix looked complete but wasn't.
  const { data: viaFeedsOwnRequest, isFallback } = await resolveGlobalIncidents(
    new Request("https://d/api/v1/feeds/incidents.json"),
    env,
  );
  assert.equal(isFallback, true);
  assert.deepEqual((viaFeedsOwnRequest as Row).surfaces, []);
});

test("every global-incident caller tries the tier before the stub", () => {
  const analytics = readFileSync(
    "workers/request-handlers/analytics.ts",
    "utf8",
  );
  const graphql = readFileSync("src/graphql.ts", "utf8");

  // The shared resolver exists and is tier-first.
  assert.match(analytics, /export async function resolveGlobalIncidents/);
  assert.match(
    analytics,
    /resolveGlobalIncidents[\s\S]{0,400}?tryPostgresTier[\s\S]{0,300}?loadGlobalIncidentsLedger/,
  );
  // The REST route goes through it.
  assert.match(
    analytics,
    /handleGlobalIncidents[\s\S]{0,900}?resolveGlobalIncidents\(/,
  );
  // GraphQL keeps its own tier-first chain (tryPostgresTier ?? stub).
  assert.match(
    graphql,
    /tryPostgresTier\([\s\S]{0,300}?METAGRAPH_HEALTH_SOURCE[\s\S]{0,200}?\?\?[\s\S]{0,120}?loadGlobalIncidentsLedger/,
  );
});
