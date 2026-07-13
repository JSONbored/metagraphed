import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_READ_COLUMNS,
  buildChainIdentityHistory,
  loadChainIdentityHistory,
} from "../src/chain-identity-history.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { readIdentityHistoryCacheStamp } from "../workers/request-handlers/analytics.mjs";

describe("readIdentityHistoryCacheStamp", () => {
  const envWith = (results) => ({
    METAGRAPH_HEALTH_DB: {
      prepare: () => ({
        bind: () => ({ all: () => Promise.resolve({ results }) }),
      }),
    },
  });

  test("returns the newest observed_at across all subnets as a string", async () => {
    const stamp = await readIdentityHistoryCacheStamp(
      envWith([{ observed_at: 1_700_000_000_000 }]),
    );
    assert.equal(stamp, "1700000000000");
  });

  test("coerces D1 numeric-string observed_at stamps", async () => {
    const stamp = await readIdentityHistoryCacheStamp(
      envWith([{ observed_at: "1700000000000" }]),
    );
    assert.equal(stamp, "1700000000000");
  });

  test("returns null when the store is cold or the stamp is non-positive/non-integer", async () => {
    assert.equal(
      await readIdentityHistoryCacheStamp(envWith([{ observed_at: null }])),
      null,
    );
    assert.equal(
      await readIdentityHistoryCacheStamp(envWith([{ observed_at: 0 }])),
      null,
    );
    assert.equal(await readIdentityHistoryCacheStamp(envWith([])), null);
  });

  test("returns null when D1 is unbound (fallback rows)", async () => {
    assert.equal(await readIdentityHistoryCacheStamp({}), null);
  });
});

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

describe("loadChainIdentityHistory", () => {
  test("issues one un-filtered SELECT ordered newest-first with a clamped limit", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadChainIdentityHistory(d1, { limit: 2 });
    assert.match(seen.sql, /FROM subnet_identity_history/);
    assert.doesNotMatch(seen.sql, /WHERE netuid/); // network-wide: no filter
    assert.match(seen.sql, /ORDER BY block_number DESC, netuid ASC/);
    assert.match(seen.sql, /LIMIT \?/);
    assert.match(seen.sql, new RegExp(CHAIN_IDENTITY_HISTORY_READ_COLUMNS));
    assert.deepEqual(seen.params, [2]); // clamped limit bound
    assert.equal(out.count, 2);
    assert.equal(out.subnet_count, 2);
  });

  test("clamps an over-max limit before binding it", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return [];
    };
    await loadChainIdentityHistory(d1, { limit: 10_000 });
    assert.deepEqual(seen.params, [CHAIN_IDENTITY_HISTORY_LIMIT_MAX]);
  });

  test("falls back to the default limit when absent", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return [];
    };
    await loadChainIdentityHistory(d1);
    assert.deepEqual(seen.params, [CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT]);
  });
});

describe("GET /api/v1/chain/identity-history", () => {
  // The MAX(observed_at) cache stamp and the feed read both hit
  // `FROM subnet_identity_history`, so route the stamp query first.
  function identityEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: (...params) => ({
              all: () =>
                Promise.resolve({
                  results: /MAX\(observed_at\)/.test(sql)
                    ? [{ observed_at: 1_700_000_000_000 }]
                    : rows,
                  __params: params,
                }),
            }),
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/identity-history${q}`);

  test("returns the recent change feed across all subnets (200)", async () => {
    const res = await handleRequest(
      req(),
      identityEnv([
        change({ id: 2, netuid: 12, block_number: 200, subnet_name: "Beta" }),
        change({ id: 1, netuid: 7, block_number: 100, subnet_name: "Alpha" }),
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.count, 2);
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.changes[0].netuid, 12);
    assert.equal(body.data.changes[0].subnet_name, "Beta");
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("cold/empty store → 200 with a schema-stable empty feed", async () => {
    const res = await handleRequest(req(), identityEnv([]), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.count, 0);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.changes, []);
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), identityEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range / non-integer limit with 400", async () => {
    for (const q of ["?limit=0", "?limit=201", "?limit=abc", "?limit=-3"]) {
      const res = await handleRequest(req(q), identityEnv([]), {});
      assert.equal(res.status, 400, q);
    }
  });

  test("accepts a valid in-range limit (200)", async () => {
    const res = await handleRequest(
      req("?limit=10"),
      identityEnv([change()]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.count, 1);
  });

  // #4832 gap-closure: METAGRAPH_SUBNET_IDENTITY_SOURCE reused (same
  // subnet_identity_history table this route already reads, no new flag) --
  // tryPostgresTier's own fallback contract is unit-tested in
  // workers/postgres-tier.mjs's own tests, so these two just prove the
  // wiring: a Postgres hit is served as-is with D1 never queried, and a
  // Postgres failure falls back to D1.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = {
      ...identityEnv([]),
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
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const res = await handleRequest(req(), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.count, 1);
    assert.equal(body.data.changes[0].netuid, 99);
    assert.equal(d1Called, false);
  });

  test("flag=postgres falls back to D1 when DATA_API fails", async () => {
    const env = {
      ...identityEnv([change({ id: 1, netuid: 7, subnet_name: "Alpha" })]),
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
    assert.equal(body.data.count, 1);
    assert.equal(body.data.changes[0].subnet_name, "Alpha");
  });
});

describe("chain/identity-history edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  function identityEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /MAX\(observed_at\)/.test(sql)
                    ? [{ observed_at: 1_700_000_000_000 }]
                    : rows,
                }),
            }),
          };
        },
      },
    };
  }

  test("engages the edge cache, busting on the newest identity observed_at", async () => {
    originalCaches = globalThis.caches;
    const store = new Map();
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
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/identity-history"),
      identityEnv([
        {
          id: 1,
          netuid: 1,
          block_number: 400,
          observed_at: 1_700_000_000_000,
          subnet_name: "Alpha",
          symbol: "α",
          description: "d",
          github_repo: null,
          subnet_url: null,
          discord: null,
          logo_url: null,
          identity_hash: "h1",
        },
      ]),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    // A non-null stamp resolver + 200 means the response was cached: proof the
    // readIdentityHistoryCacheStamp arrow ran and returned the network observed_at.
    assert.equal(store.size, 1);
  });
});
