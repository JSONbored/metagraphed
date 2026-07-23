import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  buildChainIdentityHistory,
} from "../src/chain-identity-history.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// A network feed: identity changes from two subnets, newest first (the loader
// reads block_number DESC, netuid ASC).
function change(overrides = {}) {
  return {
    id: 10,
    netuid: 7,
    block_number: 100,
    observed_at: 1_700_000_000_000,
    subnet_name: "Alpha",
    symbol: "α",
    description: "old",
    github_repo: null,
    subnet_url: null,
    discord: null,
    logo_url: null,
    identity_hash: "abc",
    ...overrides,
  };
}

const ROWS = [
  change({ id: 4, netuid: 12, block_number: 400, subnet_name: "Delta" }),
  change({ id: 3, netuid: 7, block_number: 300, subnet_name: "Gamma" }),
  change({ id: 2, netuid: 12, block_number: 200, subnet_name: "Beta" }),
  change({ id: 1, netuid: 7, block_number: 100, subnet_name: "Alpha" }),
];

describe("buildChainIdentityHistory", () => {
  test("shapes multi-subnet rows with netuid on each entry, newest first", () => {
    const out = buildChainIdentityHistory(ROWS, { limit: 50 });
    assert.equal(out.schema_version, 1);
    assert.equal(out.count, 4);
    assert.equal(out.subnet_count, 2); // netuids 7 and 12
    assert.equal(out.changes.length, 4);
    // Order is preserved from the loader (newest first).
    assert.deepEqual(
      out.changes.map((c) => c.subnet_name),
      ["Delta", "Gamma", "Beta", "Alpha"],
    );
    // netuid rides each entry alongside the per-subnet identity fields.
    assert.equal(out.changes[0].netuid, 12);
    assert.equal(out.changes[0].block_number, 400);
    assert.equal(
      out.changes[0].observed_at,
      new Date(1_700_000_000_000).toISOString(),
    );
    assert.equal(out.changes[0].identity_hash, "abc");
    // Shape matches the per-subnet entry: same tracked keys + netuid.
    assert.deepEqual(Object.keys(out.changes[0]).sort(), [
      "block_number",
      "description",
      "discord",
      "github_repo",
      "identity_hash",
      "logo_url",
      "netuid",
      "observed_at",
      "subnet_name",
      "subnet_url",
      "symbol",
    ]);
  });

  test("caps the feed to the limit, keeping the newest rows", () => {
    const out = buildChainIdentityHistory(ROWS, { limit: 2 });
    assert.equal(out.count, 2);
    assert.equal(out.changes.length, 2);
    assert.deepEqual(
      out.changes.map((c) => c.subnet_name),
      ["Delta", "Gamma"],
    );
    // subnet_count reflects only the EMITTED feed (both are netuids 12 and 7).
    assert.equal(out.subnet_count, 2);
  });

  test("subnet_count counts distinct emitted netuids only", () => {
    const out = buildChainIdentityHistory(
      [
        change({ id: 3, netuid: 5, block_number: 30 }),
        change({ id: 2, netuid: 5, block_number: 20 }),
        change({ id: 1, netuid: 9, block_number: 10 }),
      ],
      { limit: 2 },
    );
    assert.equal(out.count, 2);
    assert.equal(out.subnet_count, 1); // only netuid 5 is within the cap
  });

  test("guards blank / non-integer / negative netuid cells for subnet_count", () => {
    const out = buildChainIdentityHistory(
      [
        change({ id: 6, netuid: 7 }),
        change({ id: 5, netuid: "7" }), // numeric string — same subnet, not double-counted
        change({ id: 4, netuid: null }), // null → netuid null on the entry
        change({ id: 3, netuid: "" }), // blank → must not coerce to subnet 0
        change({ id: 2, netuid: "   " }), // whitespace-only → must not coerce to subnet 0
        change({ id: 1, netuid: "abc" }), // non-integer → null
        change({ id: 0, netuid: -1 }), // negative → null
      ],
      { limit: 200 },
    );
    assert.equal(out.subnet_count, 1); // only netuid 7 counts
    assert.equal(out.count, 7); // every valid row still emitted
    assert.equal(out.changes[2].netuid, null); // null netuid preserved on entry
    assert.equal(out.changes[3].netuid, null); // blank → null
    assert.equal(out.changes[6].netuid, null); // negative → null
  });

  test("drops rows the shared formatter rejects", () => {
    const out = buildChainIdentityHistory([null, "nope", change()], {
      limit: 50,
    });
    assert.equal(out.count, 1);
    assert.equal(out.changes[0].subnet_name, "Alpha");
  });

  test("empty / non-array rows → schema-stable empty feed", () => {
    for (const rows of [[], null, undefined, "nope", 42]) {
      const out = buildChainIdentityHistory(rows, { limit: 50 });
      assert.deepEqual(out, {
        schema_version: 1,
        count: 0,
        subnet_count: 0,
        changes: [],
      });
    }
  });

  test("defaults an absent / invalid limit to the feed default", () => {
    // A row array longer than the default would be capped; here the default is
    // simply applied without throwing.
    for (const limit of [undefined, null, "nope", 0, -5, NaN]) {
      const out = buildChainIdentityHistory([change()], { limit });
      assert.equal(out.count, 1);
    }
    assert.equal(CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT, 50);
    assert.equal(CHAIN_IDENTITY_HISTORY_LIMIT_MAX, 200);
  });

  test("clamps an over-max limit to the ceiling", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      change({ id: i, block_number: 1000 - i, netuid: i }),
    );
    const out = buildChainIdentityHistory(many, { limit: 999 });
    assert.equal(out.count, CHAIN_IDENTITY_HISTORY_LIMIT_MAX); // 200
  });
});

describe("GET /api/v1/chain/identity-history", () => {
  // D1 fully eliminated (2026-07-16): subnet_identity_history's D1 write path
  // is retired, so without a Postgres hit this route always serves the
  // schema-stable empty feed -- mirrors chain-performance.test.mjs's own
  // post-#4772 "GET" describe block (its neurons-tier D1 mock is likewise
  // vestigial, kept only for the validation-error assertions below).
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/identity-history${q}`);

  test("cold store (no Postgres tier flag) → 200 with a schema-stable empty feed", async () => {
    const res = await handleRequest(req(), createLocalArtifactEnv(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.count, 0);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.changes, []);
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range / non-integer limit with 400", async () => {
    for (const q of ["?limit=0", "?limit=201", "?limit=abc", "?limit=-3"]) {
      const res = await handleRequest(req(q), createLocalArtifactEnv(), {});
      assert.equal(res.status, 400, q);
    }
  });

  test("accepts a valid in-range limit (200)", async () => {
    const res = await handleRequest(
      req("?limit=10"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.count, 0);
  });

  // #4832 gap-closure: METAGRAPH_SUBNET_IDENTITY_SOURCE reused (same
  // subnet_identity_history table this route already reads, no new flag).
  test("flag=postgres serves the DATA_API response", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            count: 1,
            subnet_count: 1,
            changes: [{ netuid: 99, subnet_name: "PgSubnet" }],
          }),
      },
    };
    const res = await handleRequest(req(), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.count, 1);
    assert.equal(body.data.changes[0].netuid, 99);
  });

  test("flag=postgres degrades to the empty feed when DATA_API fails", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await handleRequest(req(), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.count, 0);
    assert.deepEqual(body.data.changes, []);
  });
});

describe("chain/identity-history edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  // D1 fully eliminated (2026-07-16): the bespoke readIdentityHistoryCacheStamp
  // (D1 MAX(observed_at)) is retired alongside the D1 read it existed to bust
  // on -- this route now busts on the same shared health-cron `last_run_at`
  // KV value every sibling Postgres-tier analytics route already uses,
  // mirroring chain-performance.test.mjs's own post-#4772 edge-cache tests.
  function controlEnv(lastRunAt) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key) {
          if (key !== "health:meta") return null;
          return lastRunAt ? { last_run_at: lastRunAt } : null;
        },
      },
    };
  }

  function mockCacheStore() {
    const store = new Map();
    return {
      store,
      install() {
        globalThis.caches = {
          default: {
            async match(request) {
              const cached = store.get(request.url);
              return cached ? cached.clone() : undefined;
            },
            async put(request, response) {
              store.set(request.url, response.clone());
            },
          },
        };
      },
    };
  }

  test("engages the edge cache, busting on the health-cron last_run_at stamp", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCacheStore();
    cache.install();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/identity-history"),
      controlEnv("2026-06-18T00:00:00.000Z"),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    assert.equal(cache.store.size, 1);
  });

  test("skips the cache entirely when the health stamp is cold", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCacheStore();
    cache.install();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/identity-history"),
      controlEnv(null),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    assert.equal(cache.store.size, 0);
  });
});
