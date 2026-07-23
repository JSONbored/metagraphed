import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import type { Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string, init?: RequestInit) {
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
}: {
  agg?: Row | null;
  kinds?: Row[];
  registrations?: Row[];
  events?: Row[];
  extrinsics?: Row[];
  activity?: Row | null;
  modules?: Row[];
} = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
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
                // Account weight-setters (#3842): the query is one UNION ALL
                // combining a `FROM account_events` seek with a `FROM neurons
                // ... JOIN account_events` fallback, so it textually matches
                // BOTH the `FROM neurons` and `FROM account_events` checks
                // below -- match its unique `AS weight_sets` alias first so
                // it resolves to the `events` fixture, not `registrations`.
                if (/AS weight_sets/.test(sql))
                  return { results: events || [] };
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

test("GET /accounts/{ss58}/weight-setters is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/weight-setters`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.address, SS58);
  assert.equal(body.data.subnet_count, 0);
  assert.equal(Array.isArray(body.data.subnets), true);
});

test("GET /accounts/{ss58}/weight-setters rejects an unknown query param with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/weight-setters?bogus=1`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/weight-setters rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/weight-setters?window=90d`),
    dbWith({}),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "window");
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
