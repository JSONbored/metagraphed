import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that routes by SQL shape so the account handlers (#1347) get
// realistic rows. Order matters: GROUP BY (kinds) before COUNT (agg).
function dbWith({ agg, kinds, registrations, events, extrinsics } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/GROUP BY event_kind/.test(sql))
                  return { results: kinds || [] };
                if (/COUNT\(\*\) AS c/.test(sql))
                  return { results: agg ? [agg] : [] };
                if (/FROM neurons/.test(sql))
                  return { results: registrations || [] };
                if (/FROM extrinsics/.test(sql))
                  return { results: extrinsics || [] };
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

test("GET /accounts/{ss58} returns a cross-subnet summary (#1347)", async () => {
  const env = dbWith({
    agg: {
      c: 12,
      sc: 3,
      fb: 100,
      lb: 200,
      fo: 1750000000000,
      lo: 1750009000000,
    },
    kinds: [
      { kind: "StakeAdded", count: 7 },
      { kind: "WeightsSet", count: 5 },
    ],
    registrations: [
      { netuid: 7, uid: 3, stake_tao: 100, validator_permit: 1, active: 1 },
    ],
    events: [
      {
        block_number: 200,
        event_index: 1,
        event_kind: "StakeAdded",
        hotkey: SS58,
        coldkey: null,
        netuid: 7,
        uid: 3,
        amount_tao: 1.5,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(req(`/api/v1/accounts/${SS58}`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.event_count, 12);
  assert.equal(body.data.subnet_count, 3);
  assert.equal(body.data.registrations[0].netuid, 7);
  assert.equal(body.data.registrations[0].validator_permit, true);
  assert.equal(body.data.event_kinds[0].kind, "StakeAdded");
  assert.equal(body.data.recent_events[0].event_kind, "StakeAdded");
});

test("GET /accounts/{ss58}/events returns paginated history + kind filter (#1347)", async () => {
  const env = dbWith({
    events: [
      {
        block_number: 200,
        event_index: 1,
        event_kind: "StakeRemoved",
        hotkey: SS58,
        coldkey: null,
        netuid: 7,
        uid: 3,
        amount_tao: 2.0,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/events?limit=50&kind=StakeRemoved`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(Array.isArray(body.data.events), true);
  assert.equal(body.data.events[0].event_kind, "StakeRemoved");
  assert.equal(body.data.limit, 50);
});

test("GET /accounts/{ss58}/events rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/events?bogus=1`),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/subnets returns the cross-subnet footprint (#1347)", async () => {
  const env = dbWith({
    registrations: [
      { netuid: 7, uid: 3, stake_tao: 100, validator_permit: 0, active: 1 },
      { netuid: 64, uid: 12, stake_tao: 5, validator_permit: 1, active: 1 },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/subnets`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.subnet_count, 2);
  assert.equal(body.data.subnets[1].netuid, 64);
  assert.equal(body.data.subnets[1].validator_permit, true);
});

test("GET /accounts/{ss58} is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req(`/api/v1/accounts/${SS58}`), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.event_count, 0);
  assert.equal(Array.isArray(body.data.registrations), true);
});

test("GET /accounts/{ss58}/extrinsics returns this account's signed extrinsics (#1844)", async () => {
  const env = dbWith({
    extrinsics: [
      {
        block_number: 200,
        extrinsic_index: 2,
        extrinsic_hash: `0x${"a".repeat(64)}`,
        signer: SS58,
        call_module: "SubtensorModule",
        call_function: "add_stake",
        call_args: null,
        fee_tao: 0.0125,
        success: 1,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/extrinsics?limit=50`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.extrinsic_count, 1);
  assert.equal(body.data.extrinsics[0].call_function, "add_stake");
  assert.equal(body.data.extrinsics[0].signer, SS58);
  assert.equal(body.data.extrinsics[0].success, true);
  assert.equal(body.data.extrinsics[0].fee_tao, 0.0125);
  assert.equal(body.data.limit, 50);
});

test("GET /accounts/{ss58}/extrinsics rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/extrinsics?bogus=1`),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/extrinsics is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/extrinsics`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.extrinsic_count, 0);
  assert.equal(Array.isArray(body.data.extrinsics), true);
});
