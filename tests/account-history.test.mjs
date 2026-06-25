import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// D1 mock routing by SQL shape: the history handler reads account_events_daily
// filtered by hotkey (#1854). A cold/absent DB returns no rows → schema-stable.
function dbWith({ days } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/FROM account_events_daily/.test(sql))
                  return { results: days || [] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

const DAY = {
  day: "2026-06-24",
  netuid: 7,
  event_count: 12,
  event_kinds: "StakeAdded,WeightsSet,WeightsSet",
  first_block: 4_000_100,
  last_block: 4_000_900,
};

test("GET /accounts/{ss58}/history returns the per-day series (#1854)", async () => {
  const env = dbWith({ days: [DAY] });
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

test("GET /accounts/{ss58}/history honors ?netuid / ?from / ?to / ?limit", async () => {
  const env = dbWith({ days: [DAY] });
  const res = await handleRequest(
    req(
      `/api/v1/accounts/${SS58}/history?netuid=7&from=2026-06-01&to=2026-06-30&limit=50`,
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.limit, 50);
  assert.equal(body.data.days[0].netuid, 7);
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
