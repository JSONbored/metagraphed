import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, vi } from "vitest";

// loadGlobalIncidentsLedger reads `surface_checks` through readStore, which
// builds its own `new Client(...)`; the module is the seam (#10179).
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import { pgMockEnv } from "./helpers/pg-mock.ts";
import {
  configureAnalytics,
  resolveGlobalIncidentsForFeed,
} from "../workers/request-handlers/analytics.ts";
import { mockEnv, type Row } from "./row-type.ts";

// The Postgres-tier-miss fallback path (loadGlobalIncidentsLedger) reads
// last-run metadata via this injected reader -- same wiring every other test
// of this module already does (see tests/request-handlers-analytics.test.ts).
// Only the fallback branch below needs it; a plain null is a valid "no
// metadata yet" reading.
configureAnalytics({
  readHealthMetaKv: async () => null,
  readEconomicsCurrentKv: async () => null,
});

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
 * a path DATA_API has no route for. DATA_API 404'd, tryDataApiTier read that
 * as a tier miss, and the resolver silently returned the empty stub -- the
 * exact "feed says zero, /status says dozens" symptom #8242 believed it had
 * fixed. A source-pattern test (matching "resolveGlobalIncidents(" appearing
 * near "loadLiveIncidents:") could not catch this: the call WAS there, just
 * with the wrong request. This test drives the real functions against a mock
 * DATA_API that distinguishes paths the way the real one does, so it fails on
 * the #8242 shape and passes on the #8353 fix.
 */
test("resolveGlobalIncidentsForFeed reaches real data even though DATA_API has no /api/v1/feeds/* route", async () => {
  // #10190: METAGRAPH_HEALTH_SOURCE is deleted from every config and absent from
  // FORWARDABLE_TIER_FLAGS, so the tier this doubled never answered -- and the
  // point of this test survives it intact. DATA_API genuinely has no
  // /api/v1/feeds/* route, so a feed resolver that reached for one would get a
  // 404 and serve the stub; it reads `surface_checks` through readStore instead,
  // which is the same read the REST route makes.
  pg.control.queries.length = 0;
  pg.control.rows = [
    {
      netuid: 8,
      surface_id: "sn8-api",
      surface_key: "sn8-api",
      started_at: 1_750_000_000_000,
      ended_at: 1_750_000_300_000,
      failed_samples: 3,
    },
  ];
  const env = mockEnv(pgMockEnv() as unknown as Row);

  const viaFeedResolver = (await resolveGlobalIncidentsForFeed(env)) as Row;
  // Real data, not the stub: the surface the store row describes is present.
  assert.equal((viaFeedResolver.surfaces as Row[]).length, 1);
  assert.equal((viaFeedResolver.surfaces as Row[])[0].netuid, 8);
  assert.equal((viaFeedResolver.surfaces as Row[])[0].surface_id, "sn8-api");
});

test("every global-incident caller reaches the ledger, none stops at the stub", () => {
  // WAS a source regex for `tryDataApiTier(METAGRAPH_HEALTH_SOURCE)` ahead of
  // the ledger. That call is deleted (#10190) -- the flag reads "d1" and is
  // absent from FORWARDABLE_TIER_FLAGS, so it resolved to null on every request
  // and the ledger was always the answer. Asserting it still appears would pin
  // the dead read back in place.
  //
  // The invariant it protected is unchanged and is what is asserted now: no
  // caller may answer from the schema-stable stub without first reading the
  // ledger. The stub is a floor, not a source.
  const analytics = readFileSync(
    "workers/request-handlers/analytics.ts",
    "utf8",
  );
  const graphql = readFileSync("src/graphql.ts", "utf8");

  // The shared resolver exists and reads the ledger.
  assert.match(analytics, /export async function resolveGlobalIncidents/);
  assert.match(
    analytics,
    /resolveGlobalIncidents[\s\S]{0,600}?loadGlobalIncidentsLedger/,
  );
  // Both REST callers go through it rather than building their own chain.
  assert.match(
    analytics,
    /handleGlobalIncidents[\s\S]{0,900}?resolveGlobalIncidents\(/,
  );
  // The feed resolver delegates rather than building its own chain -- which is
  // the whole point: it must not forward the feed's own /api/v1/feeds/* path.
  assert.match(
    analytics,
    /export async function resolveGlobalIncidentsForFeed[\s\S]{0,400}?resolveGlobalIncidents\(/,
  );
  assert.match(
    analytics,
    /resolveGlobalIncidentsForFeed[\s\S]{0,400}?\/api\/v1\/incidents/,
  );
  // GraphQL reads the same ledger directly (it has no Request to pass).
  assert.match(graphql, /loadGlobalIncidentsLedger\(/);
  // And nobody reaches for the retired tier again.
  assert.doesNotMatch(
    analytics,
    /tryDataApiTier\([\s\S]{0,300}?METAGRAPH_HEALTH_SOURCE/,
  );
});
