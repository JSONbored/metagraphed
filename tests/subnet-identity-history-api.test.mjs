import assert from "node:assert/strict";
import { test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// D1 fully eliminated (2026-07-16): subnet_identity_history's D1 write/read
// path is fully retired -- handleSubnetIdentityHistory now goes
// tryPostgresTier -> buildSubnetIdentityHistory([], ...) on any miss/outage,
// never a live D1 read.
test("GET /subnets/{netuid}/identity-history returns the identity timeline (#1647)", async () => {
  const env = {
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          netuid: 86,
          entry_count: 1,
          limit: null,
          offset: null,
          next_cursor: null,
          entries: [{ subnet_name: "MIAO", identity_hash: "hash-1" }],
        }),
    },
  };
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 1);
  assert.equal(body.data.entries[0].subnet_name, "MIAO");
});

test("GET /subnets/{netuid}/identity-history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history?bogus=1"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /subnets/{netuid}/identity-history is schema-stable when cold (no Postgres tier flag)", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 0);
  assert.deepEqual(body.data.entries, []);
});

// D1 fully eliminated (2026-07-16): loadPreviouslyKnownAs/loadPreviouslyKnownAsForNetuids
// (the D1-querying loaders workers/api.mjs's overlay wrappers used to fall back
// to) are gone -- these overlays only ever populate previously_known_as when
// the Postgres tier flag is on now (see the "flag=postgres" tests below);
// without it, the overlay is simply absent (schema-stable), never sourced
// from a live D1 read.
function postgresAliasesEnv(rows) {
  return {
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
    DATA_API: { fetch: async () => Response.json({ rows }) },
  };
}

test("GET /subnets/{netuid} overlays previously_known_as on the subnet detail", async () => {
  const env = createLocalArtifactEnv({
    ...postgresAliasesEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
  });
  const res = await handleRequest(req("/api/v1/subnets/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.subnet?.previously_known_as, ["Old Allways"]);
});

test("GET /subnets/{netuid} overlays previously_known_as on flat subnet detail", async () => {
  const env = createLocalArtifactEnv({
    ...postgresAliasesEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
    METAGRAPH_ARCHIVE: {
      async get(key) {
        if (!String(key).includes("subnets/7.json")) return null;
        return {
          async json() {
            return {
              schema_version: 1,
              generated_at: "2026-06-12T21:00:00.000Z",
              netuid: 7,
              name: "Allways",
              endpoints: [],
            };
          },
          async text() {
            return JSON.stringify({
              schema_version: 1,
              generated_at: "2026-06-12T21:00:00.000Z",
              netuid: 7,
              name: "Allways",
              endpoints: [],
            });
          },
        };
      },
    },
  });
  const res = await handleRequest(req("/api/v1/subnets/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.previously_known_as, ["Old Allways"]);
  assert.equal(body.data.subnet, undefined);
});

test("GET /agent-catalog overlays previously_known_as on index entries", async () => {
  const env = createLocalArtifactEnv({
    ...postgresAliasesEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
  });
  const res = await handleRequest(req("/api/v1/agent-catalog"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  const subnet = body.data.subnets.find((entry) => entry.netuid === 7);
  assert.ok(subnet);
  assert.deepEqual(subnet.previously_known_as, ["Old Allways"]);
});

test("GET /agent-catalog/{netuid} overlays previously_known_as on the detail entry", async () => {
  const env = createLocalArtifactEnv({
    ...postgresAliasesEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
  });
  const res = await handleRequest(req("/api/v1/agent-catalog/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.previously_known_as, ["Old Allways"]);
});

// #4832 gap-closure: loadPreviouslyKnownAs/loadPreviouslyKnownAsForNetuids are
// D1-fetch helpers embedded in these overlay call sites (no standalone route),
// so tryPostgresTier can't forward the caller's own request -- api.mjs
// synthesizes an internal request instead. These tests prove that wiring,
// reusing METAGRAPH_SUBNET_IDENTITY_SOURCE (already flipped in production).
// Only the alias query itself must be skipped when Postgres serves it -- the
// same request also runs the unrelated live-health overlay (surface_status),
// which stays D1-backed here since only METAGRAPH_SUBNET_IDENTITY_SOURCE is
// flipped in these tests.
function identityAliasesMustNotBeQueried() {
  let called = false;
  return {
    get called() {
      return called;
    },
    db: {
      prepare(sql) {
        if (/subnet_identity_history/.test(sql)) {
          called = true;
          throw new Error(
            "D1 must not be queried when Postgres serves the request",
          );
        }
        return {
          bind: () => ({
            async all() {
              return { results: [] };
            },
          }),
        };
      },
    },
  };
}

test("GET /agent-catalog/{netuid}: flag=postgres serves the DATA_API response, D1 never queried", async () => {
  const tracker = identityAliasesMustNotBeQueried();
  const env = createLocalArtifactEnv({
    METAGRAPH_HEALTH_DB: tracker.db,
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          rows: [{ netuid: 7, subnet_name: "Old Allways", observed_at: 2 }],
        }),
    },
  });
  const res = await handleRequest(req("/api/v1/agent-catalog/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.previously_known_as, ["Old Allways"]);
  assert.equal(tracker.called, false);
});

test("GET /agent-catalog/{netuid}: flag=postgres degrades to no overlay when DATA_API fails", async () => {
  const env = createLocalArtifactEnv({
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
    DATA_API: {
      fetch: async () => {
        throw new Error("boom");
      },
    },
  });
  const res = await handleRequest(req("/api/v1/agent-catalog/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.previously_known_as, undefined);
});

test("GET /agent-catalog: flag=postgres serves the bulk DATA_API response, D1 never queried", async () => {
  const tracker = identityAliasesMustNotBeQueried();
  const env = createLocalArtifactEnv({
    METAGRAPH_HEALTH_DB: tracker.db,
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          rows: [{ netuid: 7, subnet_name: "Old Allways", observed_at: 2 }],
        }),
    },
  });
  const res = await handleRequest(req("/api/v1/agent-catalog"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  const subnet = body.data.subnets.find((entry) => entry.netuid === 7);
  assert.ok(subnet);
  assert.deepEqual(subnet.previously_known_as, ["Old Allways"]);
  assert.equal(tracker.called, false);
});
