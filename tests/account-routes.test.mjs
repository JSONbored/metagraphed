import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path, init) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

// A D1 mock that routes by SQL shape so the account handlers (#1347/#1847) get
// realistic rows. Order matters: more-specific shapes first.
function dbWith({
  agg,
  kinds,
  registrations,
  events,
  extrinsics,
  activity,
  modules,
} = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/GROUP BY event_kind/.test(sql))
                  return { results: kinds || [] };
                // Activity (#1847): the GROUP BY call_module list + tx_count
                // aggregate must be matched BEFORE the account_events `AS c`
                // aggregate (whose loose "AS c" substring also matches "AS count").
                if (/GROUP BY call_module/.test(sql))
                  return { results: modules || [] };
                if (/AS tx_count/.test(sql))
                  return { results: activity ? [activity] : [] };
                if (/COUNT\(\*\) AS c\b/.test(sql))
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
    activity: {
      tx_count: 9,
      last_tx_block: 200,
      last_tx_at: 1750009000000,
      total_fee_tao: 0.05,
    },
    modules: [
      { call_module: "SubtensorModule", count: 7 },
      { call_module: "Balances", count: 2 },
    ],
  });
  const res = await handleRequest(req(`/api/v1/accounts/${SS58}`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.event_count, 12);
  assert.equal(body.data.subnet_count, 3);
  // Activity sub-object (#1847) from the extrinsics tier.
  assert.equal(body.data.activity.tx_count, 9);
  assert.equal(body.data.activity.last_tx_block, 200);
  assert.equal(
    body.data.activity.last_tx_at,
    new Date(1750009000000).toISOString(),
  );
  assert.equal(body.data.activity.total_fee_tao, 0.05);
  assert.equal(
    body.data.activity.modules_called[0].call_module,
    "SubtensorModule",
  );
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

const EVENTS_CSV_HEADER =
  "block_number,event_index,event_kind,hotkey,coldkey,netuid,uid,amount_tao,alpha_amount,observed_at,extrinsic_index";

test("GET /accounts/{ss58}/events?format=csv streams the event rows as CSV", async () => {
  const env = dbWith({
    events: [
      {
        block_number: 200,
        event_index: 1,
        event_kind: "StakeAdded",
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
    req(`/api/v1/accounts/${SS58}/events?format=csv&kind=StakeAdded`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /attachment; filename="/,
  );
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], EVENTS_CSV_HEADER);
  assert.equal(lines.length, 2);
  const cells = lines[1].split(",");
  assert.equal(cells[0], "200"); // block_number
  assert.equal(cells[2], "StakeAdded"); // event_kind
  assert.equal(cells[7], "2"); // amount_tao
});

test("GET /accounts/{ss58}/events?format=csv emits a header-only CSV when cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/events?format=csv`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EVENTS_CSV_HEADER);
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
  // Activity (#1847) is schema-stable on a cold store.
  assert.equal(body.data.activity.tx_count, 0);
  assert.equal(body.data.activity.last_tx_at, null);
  assert.deepEqual(body.data.activity.modules_called, []);
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

test("GET /accounts/{ss58}/extrinsics JSON varies on Accept when CSV is negotiated by header", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/extrinsics`, {
      headers: { accept: "application/json" },
    }),
    {},
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("vary"), "Accept, Accept-Encoding");
  assert.match(res.headers.get("content-type"), /^application\/json/);
});

test("GET /accounts/{ss58}/extrinsics?format=csv exports extrinsic_id/block_number/call_module columns (#2534)", async () => {
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
    req(`/api/v1/accounts/${SS58}/extrinsics?format=csv`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv/);
  assert.equal(
    res.headers.get("content-disposition"),
    'attachment; filename="account-extrinsics.csv"',
  );
  const lines = (await res.text()).split("\r\n");
  assert.equal(
    lines[0],
    "extrinsic_id,block_number,extrinsic_index,extrinsic_hash,signer,call_module,call_function,success,fee_tao,tip_tao,observed_at",
  );
  assert.equal(
    lines[1],
    `200-2,200,2,0x${"a".repeat(64)},${SS58},SubtensorModule,add_stake,true,0.0125,,2025-06-15T17:36:40.000Z`,
  );
  assert.equal(lines.length, 2);
});

test("GET /accounts/{ss58}/extrinsics?format=csv emits a header-only CSV when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/extrinsics?format=csv`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const lines = (await res.text()).split("\r\n");
  assert.equal(
    lines[0],
    "extrinsic_id,block_number,extrinsic_index,extrinsic_hash,signer,call_module,call_function,success,fee_tao,tip_tao,observed_at",
  );
  assert.equal(lines.length, 1);
});

test("GET /accounts/{ss58}/transfers reshapes Transfer rows directionally (#1850)", async () => {
  const env = dbWith({
    // The poller stores hotkey=from / coldkey=to for Transfer events.
    events: [
      {
        block_number: 300,
        event_index: 0,
        event_kind: "Transfer",
        hotkey: SS58, // sender == queried account → "sent"
        coldkey: "5Recipient",
        netuid: null,
        uid: null,
        amount_tao: 4.2,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers?direction=sent`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.transfer_count, 1);
  assert.equal(body.data.transfers[0].from, SS58);
  assert.equal(body.data.transfers[0].to, "5Recipient");
  assert.equal(body.data.transfers[0].amount_tao, 4.2);
  assert.equal(body.data.transfers[0].direction, "sent");
});

test("GET /accounts/{ss58}/transfers rejects an unsupported query param (#1850)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers?bogus=1`),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/transfers rejects an unsupported direction enum value", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers?direction=invalid`),
    {},
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "invalid_query");
  assert.equal(body.meta.parameter, "direction");
});

test("GET /accounts/{ss58}/transfers is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.transfer_count, 0);
  assert.equal(Array.isArray(body.data.transfers), true);
});

test("GET /accounts/{ss58}/transfers JSON varies on Accept when CSV is negotiated by header", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers`, {
      headers: { accept: "application/json" },
    }),
    {},
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("vary"), "Accept, Accept-Encoding");
  assert.match(res.headers.get("content-type"), /^application\/json/);
});

test("GET /accounts/{ss58}/transfers?direction=sent&format=csv filters direction and exports from/to/amount_tao columns (#2534)", async () => {
  const env = dbWith({
    events: [
      {
        block_number: 300,
        event_index: 0,
        event_kind: "Transfer",
        hotkey: SS58, // sender == queried account -> "sent"
        coldkey: "5Recipient",
        netuid: null,
        uid: null,
        amount_tao: 4.2,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers?direction=sent&format=csv`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv/);
  assert.equal(
    res.headers.get("content-disposition"),
    'attachment; filename="account-transfers.csv"',
  );
  const lines = (await res.text()).split("\r\n");
  assert.equal(
    lines[0],
    "block_number,event_index,from,to,amount_tao,direction,observed_at",
  );
  assert.equal(
    lines[1],
    `300,0,${SS58},5Recipient,4.2,sent,2025-06-15T17:36:40.000Z`,
  );
  assert.equal(lines.length, 2);
});

test("GET /accounts/{ss58}/transfers?format=csv emits a header-only CSV when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/transfers?format=csv`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const lines = (await res.text()).split("\r\n");
  assert.equal(
    lines[0],
    "block_number,event_index,from,to,amount_tao,direction,observed_at",
  );
  assert.equal(lines.length, 1);
});

test("GET /accounts/{ss58}/stake-flow routes to the per-account stake-flow handler", async () => {
  const env = dbWith({
    events: [
      {
        netuid: 1,
        event_kind: "StakeAdded",
        total_tao: 80,
        event_count: 2,
        last_observed: 1750009000000,
      },
      {
        netuid: 1,
        event_kind: "StakeRemoved",
        total_tao: 20,
        event_count: 1,
        last_observed: 1750000000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/stake-flow?window=30d`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.window, "30d");
  assert.equal(body.data.net_flow_tao, 60);
  assert.equal(body.data.subnets[0].netuid, 1);
  assert.equal(body.meta.source, "chain-events");
});

test("GET /accounts/{ss58}/stake-flow is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/stake-flow`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/registrations routes to the per-account registrations handler", async () => {
  const env = dbWith({
    events: [
      {
        netuid: 1,
        registrations: 3,
        first_observed: 1750000000000,
        last_observed: 1750009000000,
      },
      {
        netuid: 7,
        registrations: 1,
        first_observed: 1750001000000,
        last_observed: 1750001000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/registrations?window=30d`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.window, "30d");
  assert.equal(body.data.total_registrations, 4);
  assert.equal(body.data.subnets[0].netuid, 1); // most registrations -> leads + dominant
  assert.equal(body.data.dominant_netuid, 1);
  assert.equal(body.meta.source, "chain-events");
});

test("GET /accounts/{ss58}/registrations is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/registrations`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/registrations rejects an unknown query param with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/registrations?bogus=1`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/registrations rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/registrations?window=1y`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "window");
});

test("GET /accounts/{ss58}/serving routes to the per-account serving handler", async () => {
  const env = dbWith({
    events: [
      {
        netuid: 1,
        announcements: 30,
        first_observed: 1750000000000,
        last_observed: 1750009000000,
      },
      {
        netuid: 7,
        announcements: 5,
        first_observed: 1750001000000,
        last_observed: 1750001000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/serving?window=30d`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.window, "30d");
  assert.equal(body.data.total_announcements, 35);
  assert.equal(body.data.subnets[0].netuid, 1); // most announcements -> leads + dominant
  assert.equal(body.data.dominant_netuid, 1);
  assert.equal(body.meta.source, "chain-events");
});

test("GET /accounts/{ss58}/serving is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/serving`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/serving rejects an unknown query param with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/serving?bogus=1`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/serving rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/serving?window=1y`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "window");
});

test("GET /accounts/{ss58}/deregistrations routes to the per-account deregistrations handler", async () => {
  const env = dbWith({
    events: [
      {
        netuid: 1,
        deregistrations: 3,
        first_observed: 1750000000000,
        last_observed: 1750009000000,
      },
      {
        netuid: 7,
        deregistrations: 1,
        first_observed: 1750001000000,
        last_observed: 1750001000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/deregistrations?window=30d`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.window, "30d");
  assert.equal(body.data.total_deregistrations, 4);
  assert.equal(body.data.subnets[0].netuid, 1); // most deregistrations -> leads + dominant
  assert.equal(body.data.dominant_netuid, 1);
  assert.equal(body.meta.source, "chain-events");
});

test("GET /accounts/{ss58}/deregistrations is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/deregistrations`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/deregistrations rejects an unknown query param with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/deregistrations?bogus=1`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/deregistrations rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/deregistrations?window=1y`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "window");
});

test("GET /accounts/{ss58}/prometheus routes to the per-account prometheus handler", async () => {
  const env = dbWith({
    events: [
      {
        netuid: 1,
        announcements: 30,
        first_observed: 1750000000000,
        last_observed: 1750009000000,
      },
      {
        netuid: 7,
        announcements: 5,
        first_observed: 1750001000000,
        last_observed: 1750001000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/prometheus?window=30d`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.window, "30d");
  assert.equal(body.data.total_announcements, 35);
  assert.equal(body.data.subnets[0].netuid, 1); // most announcements -> leads + dominant
  assert.equal(body.data.dominant_netuid, 1);
  assert.equal(body.meta.source, "chain-events");
});

test("GET /accounts/{ss58}/prometheus is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/prometheus`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/prometheus rejects an unknown query param with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/prometheus?bogus=1`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/prometheus rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/prometheus?window=1y`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "window");
});

test("GET /accounts/{ss58}/axon-removals routes to the per-account axon-removals handler", async () => {
  const env = dbWith({
    events: [
      {
        netuid: 1,
        removals: 4,
        first_observed: 1750000000000,
        last_observed: 1750009000000,
      },
      {
        netuid: 7,
        removals: 1,
        first_observed: 1750001000000,
        last_observed: 1750001000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/axon-removals?window=30d`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.window, "30d");
  assert.equal(body.data.total_removals, 5);
  assert.equal(body.data.subnets[0].netuid, 1); // most removals -> leads + dominant
  assert.equal(body.data.dominant_netuid, 1);
  assert.equal(body.meta.source, "chain-events");
});

test("GET /accounts/{ss58}/axon-removals is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/axon-removals`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/axon-removals rejects an unknown query param with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/axon-removals?bogus=1`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/axon-removals rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/axon-removals?window=1y`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "window");
});
