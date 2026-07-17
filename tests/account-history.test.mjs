import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { buildAccountHistory } from "../src/account-events.mjs";

// SQL-capturing D1 mock variant: records each bound (sql, params) so a test can
// assert the query shape (keyset seek vs offset).
function dbCapture(days = []) {
  const captured = [];
  return {
    captured,
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              captured.push({ sql, params });
              return {
                async all() {
                  return {
                    results: /FROM account_events_daily/.test(sql) ? days : [],
                  };
                },
              };
            },
          };
        },
      },
    },
  };
}

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

const DAY = {
  day: "2026-06-24",
  netuid: 7,
  event_count: 12,
  event_kinds: "StakeAdded,WeightsSet,WeightsSet",
  first_block: 4_000_100,
  last_block: 4_000_900,
};

// D1 fully eliminated (2026-07-17, #1854): handleAccountHistory now reads
// METAGRAPH_ACCOUNT_EVENTS_SOURCE's Postgres tier only, via
// tryPostgresTier(env, request, ...) -> DATA_API. On a hit, DATA_API's JSON
// body is used directly as `data` (no reshaping), so the mock returns the
// already-built buildAccountHistory output, mirroring what
// workers/data-api.mjs actually serves for this route.
function postgresEnv({ days } = {}) {
  return {
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      async fetch() {
        return Response.json(
          buildAccountHistory(days || [], SS58, {
            limit: 100,
            offset: 0,
            nextCursor: null,
          }),
        );
      },
    },
  };
}

test("GET /accounts/{ss58}/history returns the per-day series (#1854)", async () => {
  const env = postgresEnv({ days: [DAY] });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.day_count, 1);
  assert.equal(body.data.days[0].day, "2026-06-24");
  assert.equal(body.data.days[0].netuid, 7);
  // event_kinds CSV split into a deduped-by-storage array (raw split here).
  assert.deepEqual(body.data.days[0].event_kinds, [
    "StakeAdded",
    "WeightsSet",
    "WeightsSet",
  ]);
  assert.ok(res.headers.get("etag"));
});

test("GET /accounts/{ss58}/history rejects malformed ?from / ?to", async () => {
  const bad = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?from=June`),
    {},
    {},
  );
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_param");
});

test("GET /accounts/{ss58}/history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?bogus=1`),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/history is schema-stable when cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.day_count, 0);
  assert.equal(Array.isArray(body.data.days), true);
});

test("GET /accounts/{ss58}/history exposes x-metagraph-artifact-source on both the normal and inverted-range short-circuit paths (#2618)", async () => {
  // The normal path stamps meta.source and exposes the CORS header; the inverted
  // from>to short-circuit stamps the same meta.source, so it must expose the
  // header too — it must not be dropped just because the range is empty.
  const normal = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history`),
    postgresEnv({ days: [DAY] }),
    {},
  );
  assert.equal(
    normal.headers.get("x-metagraph-artifact-source"),
    "chain-events",
  );

  const { env, captured } = dbCapture([DAY]);
  const inverted = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?from=2026-06-30&to=2026-06-01`),
    env,
    {},
  );
  assert.equal(inverted.status, 200);
  assert.equal((await inverted.json()).data.day_count, 0);
  // Short-circuited before D1 — no account_events_daily scan.
  assert.ok(!captured.some((q) => /FROM account_events_daily/.test(q.sql)));
  assert.equal(
    inverted.headers.get("x-metagraph-artifact-source"),
    "chain-events",
  );
});
