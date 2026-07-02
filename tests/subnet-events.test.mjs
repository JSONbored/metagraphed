import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// D1 mock routing by SQL shape: the subnet-events handler reads account_events
// filtered by netuid (#1345). A cold/absent DB returns no rows → schema-stable.
function dbWith({ events } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/FROM account_events/.test(sql))
                  return { results: events || [] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

const ROW = {
  block_number: 4_000_200,
  event_index: 2,
  event_kind: "NeuronRegistered",
  hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  coldkey: null,
  netuid: 7,
  uid: 3,
  amount_tao: null,
  observed_at: 1_750_009_000_000,
};

test("GET /subnets/{netuid}/events returns the per-subnet chain-event stream (#1345)", async () => {
  const env = dbWith({ events: [ROW] });
  const res = await handleRequest(req("/api/v1/subnets/7/events"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.netuid, 7);
  assert.equal(body.data.event_count, 1);
  assert.equal(Array.isArray(body.data.events), true);
  assert.equal(body.data.events[0].event_kind, "NeuronRegistered");
  assert.equal(body.data.events[0].netuid, 7);
  // Enveloped like every other route: weak ETag + contract-version header.
  assert.ok(res.headers.get("etag"));
  assert.ok(res.headers.get("x-metagraph-contract-version"));
});

test("GET /subnets/{netuid}/events honors ?limit and ?kind", async () => {
  const env = dbWith({ events: [{ ...ROW, event_kind: "WeightsSet" }] });
  const res = await handleRequest(
    req("/api/v1/subnets/7/events?limit=25&kind=WeightsSet"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.limit, 25);
  assert.equal(body.data.events[0].event_kind, "WeightsSet");
});

test("GET /subnets/{netuid}/events rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/events?bogus=1"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /subnets/{netuid}/events is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/subnets/7/events"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 7);
  assert.equal(body.data.event_count, 0);
  assert.equal(Array.isArray(body.data.events), true);
});
