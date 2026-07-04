import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function dbWith({ summaryKinds, summaryRecent, subnetCount } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/COUNT\(DISTINCT netuid\)/.test(sql)) {
                  return { results: [{ subnet_count: subnetCount ?? 0 }] };
                }
                if (/GROUP BY event_kind/.test(sql)) {
                  return { results: summaryKinds || [] };
                }
                if (
                  /observed_at >= \?/.test(sql) &&
                  /ORDER BY block_number DESC, event_index DESC LIMIT \?/.test(
                    sql,
                  )
                ) {
                  return { results: summaryRecent || [] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

test("GET /accounts/{ss58}/event-summary returns windowed kind aggregates", async () => {
  const env = dbWith({
    subnetCount: 1,
    summaryKinds: [
      {
        event_kind: "StakeAdded",
        event_count: 2,
        hotkey_count: 1,
        coldkey_count: 1,
        amount_tao: 3,
        alpha_amount: 0.5,
        first_block: 4_000_100,
        last_block: 4_000_200,
        first_observed_at: 1_750_008_000_000,
        last_observed_at: 1_750_009_000_000,
      },
    ],
    summaryRecent: [
      {
        block_number: 4_000_200,
        event_index: 2,
        event_kind: "NeuronRegistered",
        hotkey: SS58,
        coldkey: null,
        netuid: 7,
        uid: 3,
        amount_tao: null,
        observed_at: 1_750_009_000_000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/event-summary?window=7d&limit=3`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.window, "7d");
  assert.equal(body.data.subnet_count, 1);
  assert.equal(body.data.total_events, 2);
  assert.equal(body.data.event_kinds[0].category, "stake");
  assert.equal(body.data.recent_events[0].event_kind, "NeuronRegistered");
  assert.equal(
    body.meta.artifact_path,
    `/metagraph/accounts/${SS58}/event-summary.json`,
  );
});

test("GET /accounts/{ss58}/event-summary rejects bad window", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/event-summary?window=1y`),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/event-summary is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/event-summary`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.total_events, 0);
  assert.equal(body.data.subnet_count, 0);
  assert.deepEqual(body.data.recent_events, []);
});
