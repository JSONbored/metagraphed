import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

/**
 * #8242: /api/v1/feeds/incidents reported "no incidents" while /status showed
 * dozens ongoing from the same underlying data.
 *
 * Cause was not the feed builder — it was the source. `loadGlobalIncidentsLedger`
 * is a schema-stable EMPTY stub (it hardcodes `incidentRows: []`) meant only as
 * the Postgres-tier-miss fallback. `handleGlobalIncidents` and the GraphQL
 * resolver both try the tier first; the feed injection called the stub directly,
 * so it was empty by construction on every request.
 *
 * These are source assertions rather than a live-tier test because the empty
 * stub is exactly what a test env resolves to — a behavioural test would pass
 * against the bug. What matters is that no caller reaches the stub without
 * going through the tier first.
 */
test("the incidents feed resolves through the Postgres tier, not the empty ledger stub", () => {
  const api = readFileSync("workers/api.ts", "utf8");

  // The feed injection must use the shared resolver...
  assert.match(api, /loadLiveIncidents:[\s\S]{0,200}?resolveGlobalIncidents\(/);
  // ...and must not reach the stub directly.
  assert.doesNotMatch(
    api,
    /loadLiveIncidents:[\s\S]{0,200}?loadGlobalIncidentsLedger\(/,
  );
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
