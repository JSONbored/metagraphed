import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { envelopeResponse } from "../workers/responses.mjs";
import {
  markD1FallbackResponse,
  withEdgeCache,
} from "../workers/request-handlers/analytics.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { CONTRACT_VERSION } from "../src/contracts.mjs";

// Edge-cache coverage for the D1-backed analytics routes (audit #6). These four
// handlers (per-subnet health trends / percentiles / incidents + the bulk-trends
// route) used to re-run a full-window D1 aggregation on EVERY request; they are
// now wrapped in withEdgeCache, which mirrors the existing live-overlay
// collection cache (Cloudflare Cache API keyed on contract_version + the cron
// snapshot's last_run_at). These tests assert the cache is correct AND
// transparent: same body, keyed on what changes the data, never caching errors.

const LAST_RUN_AT = "2026-06-18T00:00:00.000Z";

// One row backs every shape the analytics SQL returns (the shared ok-latency CTE
// carries both uptime and latency stats; incidents reuse the same row).
function rowsForSql(sql) {
  if (sql.includes("WITH ranked") || sql.includes("FROM ranked")) {
    return [
      {
        surface_id: "s1",
        surface_key: "s1",
        total: 100,
        ok_count: 98,
        lat_cnt: 96,
        latency_samples: 96,
        samples: 100,
        p50: 120,
        p95: 400,
        p99: 800,
        avg_latency_ms: 150,
        min_latency_ms: 40,
        max_latency_ms: 900,
      },
    ];
  }
  if (sql.includes("SUM(ok) AS ok_count")) {
    return [{ surface_id: "s1", surface_key: "s1", total: 100, ok_count: 98 }];
  }
  if (sql.includes("WITH checks")) {
    return [
      {
        surface_id: "s1",
        surface_key: "s1",
        started_at: 1_000_000_000_000,
        ended_at: 1_000_000_120_000,
        failed_samples: 2,
      },
    ];
  }
  if (sql.includes("FROM surface_uptime_daily")) {
    return [
      {
        netuid: 7,
        day: "2026-06-17",
        date: "2026-06-17",
        total: 100,
        ok_count: 98,
        latency_samples: 96,
        p50: 120,
        p95: 400,
      },
    ];
  }
  if (sql.includes("FROM neuron_daily")) {
    return [
      { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 10 },
      { snapshot_date: "2026-06-27", stake_tao: 1, emission_tao: 1 },
    ];
  }
  return [];
}

// Local artifact env + a query-recording D1 + a KV control plane that serves the
// snapshot stamp. `queries` records every {sql, params} so a test can assert
// whether D1 was touched at all (the whole point of the cache).
function analyticsEnv(
  queries,
  { lastRunAt = LAST_RUN_AT, d1Error = null } = {},
) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            queries.push({ sql, params });
            return {
              all: () =>
                d1Error
                  ? Promise.reject(d1Error)
                  : Promise.resolve({ results: rowsForSql(sql) }),
            };
          },
        };
      },
    },
    METAGRAPH_CONTROL: {
      async get(key) {
        if (key === "health:meta") {
          return lastRunAt ? { last_run_at: lastRunAt } : null;
        }
        return null;
      },
    },
  };
}

// A minimal stand-in for the Workers `caches.default`: a Map keyed on the
// Request URL, recording every put key and every match call (mirrors the
// existing edge-cache test stub in worker-runtime.test.mjs).
function mockCaches() {
  const store = new Map();
  const putKeys = [];
  let matchCalls = 0;
  return {
    store,
    putKeys,
    get matchCalls() {
      return matchCalls;
    },
    install() {
      globalThis.caches = {
        default: {
          async match(request) {
            matchCalls += 1;
            const cached = store.get(request.url);
            return cached ? cached.clone() : undefined;
          },
          async put(request, response) {
            putKeys.push(request.url);
            store.set(request.url, response.clone());
          },
        },
      };
    },
  };
}

// Rebuild the exact cache key the worker computes, so the invariant assertions
// don't hard-code a brittle literal and survive a contract-version bump.
function expectedKey(keyParts, pathname, search = "") {
  return `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
    CONTRACT_VERSION,
  )}/${encodeURIComponent(LAST_RUN_AT)}/${keyParts}${pathname}${search}`;
}

const ctx = { waitUntil: (promise) => promise };

let originalCaches;
afterEach(() => {
  globalThis.caches = originalCaches;
});

describe("analytics edge cache", () => {
  test("INVARIANT: cache key includes contract_version + snapshot stamp + netuid + window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    // Per-subnet percentiles (netuid + window both vary the key).
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d",
      ),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "percentiles",
        "/api/v1/subnets/7/health/percentiles",
        "?window=30d",
      ),
    ]);
    const key = cache.putKeys[0];
    assert.ok(key.includes(encodeURIComponent(CONTRACT_VERSION)), "contract");
    assert.ok(key.includes(encodeURIComponent(LAST_RUN_AT)), "snapshot stamp");
    assert.ok(key.includes("/subnets/7/"), "netuid");
    assert.ok(key.includes("window=30d"), "window");
  });

  test("INVARIANT: a different window and a different netuid key separately", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    for (const url of [
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d",
      "https://api.metagraph.sh/api/v1/subnets/9/health/percentiles?window=7d",
    ]) {
      await handleRequest(new Request(url), env, ctx);
      await Promise.resolve();
    }
    // Three distinct (netuid, window) combinations → three distinct entries.
    assert.equal(cache.store.size, 3);
    assert.equal(cache.putKeys.length, 3);
    assert.equal(new Set(cache.putKeys).size, 3);
  });

  test("concentration history canonicalizes equivalent window query strings before caching", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const variants = [
      "https://api.metagraph.sh/api/v1/subnets/7/concentration/history?window=90d",
      "https://api.metagraph.sh/api/v1/subnets/7/concentration/history?window=90d&",
      "https://api.metagraph.sh/api/v1/subnets/7/concentration/history?window=90d&&",
    ];

    const first = await handleRequest(new Request(variants[0]), env, ctx);
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    for (const variant of variants.slice(1)) {
      const hit = await handleRequest(new Request(variant), env, ctx);
      assert.equal(hit.status, 200);
    }

    assert.equal(queries.length, queriesAfterMiss);
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-concentration-history",
        "/api/v1/subnets/7/concentration/history",
        "?window=90d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("turnover canonicalizes omitted and explicit default window to the same cache key", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    // No ?window — should resolve to the 30d default and cache at ?window=30d.
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/turnover"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    // Explicit ?window=30d is the canonical form — must be a cache HIT (no new D1).
    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/turnover?window=30d",
      ),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      queries.length,
      queriesAfterMiss,
      "explicit ?window=30d must be a cache HIT (no D1 queries)",
    );

    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-turnover",
        "/api/v1/subnets/7/turnover",
        "?window=30d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("turnover: explicit ?window=30d populates cache; omitted window is a HIT", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    // Explicit ?window=30d is the canonical form — cache MISS, populates.
    const first = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/turnover?window=30d",
      ),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    // Omitted window resolves to the same 30d key — must be a HIT (no D1).
    const hit = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/turnover"),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      queries.length,
      queriesAfterMiss,
      "omitted window must reuse the ?window=30d cache slot (no D1 queries)",
    );
    assert.equal(cache.store.size, 1);
  });

  test("HIT: a pre-populated cache serves the cached body WITHOUT touching D1", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const url =
      "https://api.metagraph.sh/api/v1/subnets/7/health/incidents?window=7d";

    // First request is a MISS: it runs D1 and populates the cache.
    const first = await handleRequest(new Request(url), env, ctx);
    await Promise.resolve();
    const firstBody = await first.text();
    assert.equal(first.status, 200);
    assert.ok(queries.length > 0, "the cold MISS must run the D1 aggregation");

    // Second request is a HIT: served from cache, D1 untouched.
    const queryCountAfterMiss = queries.length;
    const second = await handleRequest(new Request(url), env, ctx);
    assert.equal(second.status, 200);
    assert.equal(
      await second.text(),
      firstBody,
      "the cached body is byte-identical",
    );
    assert.equal(
      queries.length,
      queryCountAfterMiss,
      "a cache HIT must not issue any D1 query",
    );
  });

  test("HIT: a warm cache honours conditional requests with a 304", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const url = "https://api.metagraph.sh/api/v1/health/trends";

    const first = await handleRequest(new Request(url), env, ctx);
    await Promise.resolve();
    const etag = first.headers.get("etag");
    assert.equal(first.status, 200);
    const queryCountAfterMiss = queries.length;

    const conditional = await handleRequest(
      new Request(url, { headers: { "if-none-match": etag } }),
      env,
      ctx,
    );
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    assert.equal(
      queries.length,
      queryCountAfterMiss,
      "a 304 from the warm cache must not touch D1",
    );
  });

  test("MISS: an empty cache runs D1 once and issues a cache.put via waitUntil", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    let putAt = null;
    const putCtx = {
      waitUntil: (promise) => {
        putAt = promise;
        return promise;
      },
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/health/trends"),
      env,
      putCtx,
    );
    assert.equal(res.status, 200);
    assert.ok(putAt, "the MISS must schedule the cache write under waitUntil");
    await putAt;
    assert.deepEqual(cache.putKeys, [
      expectedKey("bulk-trends", "/api/v1/health/trends"),
    ]);
    // The cached response is the success 200 (never a placeholder/error).
    const cached = cache.store.get(cache.putKeys[0]);
    assert.equal(cached.status, 200);
  });

  test("NO-CACHE-ON-ERROR: a 400 (bad window) is never cached", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=bogus",
      ),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("x-metagraph-error-code"), "invalid_query");
    assert.deepEqual(cache.putKeys, [], "a 400 must not be cached");
    assert.equal(cache.store.size, 0);
  });

  test("NO-CACHE-ON-ERROR: a D1 failure still serves a 200 empty envelope but is not cached when the snapshot stamp is cold", async () => {
    // When KV is cold (no last_run_at) the handler still returns a schema-stable
    // 200, but the cache must be skipped entirely so a cold/empty payload can
    // never seed a stale entry (mirrors the overlay cache's lastRunAt guard).
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries, { lastRunAt: null });

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/incidents?window=7d",
      ),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "a cold-snapshot response must not be cached",
    );
    assert.equal(
      cache.matchCalls,
      0,
      "a cold snapshot skips the cache lookup entirely",
    );
  });

  test("NO-CACHE-ON-ERROR: a marked fallback Response is skipped even when the generation is unchanged", async () => {
    // This isolates the WeakSet response marker from the independent D1 fallback
    // generation guard: a handler must mark the awaited Response object, not the
    // Promise that produces it, or withEdgeCache cannot recognize the fallback.
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = new Request("https://api.metagraph.sh/api/v1/test");

    const res = await withEdgeCache(request, ctx, env, "unit", async () => {
      const response = await envelopeResponse(
        request,
        {
          data: { degraded: true },
          meta: { generated_at: LAST_RUN_AT },
        },
        "short",
      );
      return markD1FallbackResponse(response);
    });
    await Promise.resolve();

    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "the per-response fallback marker must block cache.put",
    );
    assert.equal(cache.store.size, 0);
  });

  test("NO-CACHE-ON-ERROR: a D1 failure with a snapshot stamp is served but not cached", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries, { d1Error: new Error("D1 unavailable") });

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      ),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "a D1 fallback response must not poison the edge cache",
    );
    assert.equal(cache.store.size, 0);
  });

  test("NO-CACHE-ON-ERROR: D1 fallback on the five additional edge-cached routes is not cached", async () => {
    const routes = [
      {
        path: "/api/v1/registry/leaderboards",
        search: "",
      },
      {
        path: "/api/v1/incidents",
        search: "?window=7d",
      },
      {
        path: "/api/v1/subnets/7/trajectory",
        search: "",
      },
      {
        path: "/api/v1/subnets/7/uptime",
        search: "?window=90d",
      },
      {
        path: "/api/v1/compare",
        search: "?netuids=7",
      },
    ];
    originalCaches = globalThis.caches;
    for (const r of routes) {
      const cache = mockCaches();
      cache.install();
      const queries = [];
      const env = analyticsEnv(queries, {
        d1Error: new Error("D1 unavailable"),
      });
      const url = `https://api.metagraph.sh${r.path}${r.search}`;

      const res = await handleRequest(new Request(url), env, ctx);
      await Promise.resolve();
      assert.equal(res.status, 200, `${r.path}: fallback is still 200`);
      assert.deepEqual(
        cache.putKeys,
        [],
        `${r.path}: D1 fallback must not poison the edge cache`,
      );
      assert.equal(cache.store.size, 0, `${r.path}: cache stays empty`);
    }
  });

  test("NO-CACHE-ON-ERROR: an unbound D1 binding with a warm snapshot stamp is not cached", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {},
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta" ? { last_run_at: LAST_RUN_AT } : null;
        },
      },
    };

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/registry/leaderboards"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "an unbound D1 cold fallback must not seed the edge cache",
    );
    assert.equal(cache.store.size, 0);
  });

  test("transparency: the cached body equals the uncached body for the same handler", async () => {
    // Same request, once with the cache stubbed and once without — the served
    // body must be byte-identical (the cache adds nothing to the payload).
    originalCaches = globalThis.caches;
    const url =
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d";

    // Uncached: no globalThis.caches → withEdgeCache falls through to D1.
    globalThis.caches = undefined;
    const uncached = await handleRequest(
      new Request(url),
      analyticsEnv([]),
      ctx,
    );
    const uncachedBody = await uncached.text();

    // Cached MISS path.
    const cache = mockCaches();
    cache.install();
    const cachedMiss = await handleRequest(
      new Request(url),
      analyticsEnv([]),
      ctx,
    );
    const cachedBody = await cachedMiss.text();

    assert.equal(cachedBody, uncachedBody);
  });

  test("subnet-history ?window variants share a single cache entry (canonical key)", async () => {
    const queries = [];
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/history";

    // First request with explicit default window — caches under ?window=30d.
    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=30d`),
      env,
      ctx,
    );
    await Promise.resolve();
    const queriesAfterFirst = queries.length;

    // Trailing-amp variant must be a cache HIT (same canonical key).
    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=30d&`),
      env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "?window=30d& hits cache of ?window=30d",
    );

    // Omitting window entirely defaults to 30d — also a cache HIT.
    await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "no ?window hits cache of ?window=30d",
    );
  });

  test("economics-trends ?window variants share a single cache entry (canonical key)", async () => {
    const queries = [];
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv(queries);
    const base = "/api/v1/economics/trends";

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=30d`),
      env,
      ctx,
    );
    await Promise.resolve();
    const queriesAfterFirst = queries.length;

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "no ?window hits cache of ?window=30d",
    );
  });

  test("the 4 additional deterministic routes are now edge-cached (MISS→put under their key, HIT→no D1)", async () => {
    // These routes (global incidents, per-subnet trajectory, per-subnet uptime,
    // registry leaderboards) were edgeCache=0 — they re-ran their D1 aggregation
    // on every request. Now wrapped in withEdgeCache at the call site, keyed on
    // the same contract_version + last_run_at + pathname + search.
    const routes = [
      {
        keyParts: "leaderboards",
        path: "/api/v1/registry/leaderboards",
        search: "",
      },
      {
        keyParts: "global-incidents",
        path: "/api/v1/incidents",
        search: "?window=7d",
      },
      {
        keyParts: "trajectory",
        path: "/api/v1/subnets/7/trajectory",
        search: "",
      },
      {
        keyParts: "uptime",
        path: "/api/v1/subnets/7/uptime",
        search: "?window=90d",
      },
    ];
    originalCaches = globalThis.caches;
    for (const r of routes) {
      const cache = mockCaches();
      cache.install();
      const queries = [];
      const env = analyticsEnv(queries);
      const url = `https://api.metagraph.sh${r.path}${r.search}`;

      // MISS: runs D1 and caches under the route's key.
      const miss = await handleRequest(new Request(url), env, ctx);
      await Promise.resolve();
      assert.equal(miss.status, 200, `${r.keyParts}: MISS is 200`);
      assert.ok(
        cache.putKeys.includes(expectedKey(r.keyParts, r.path, r.search)),
        `${r.keyParts}: cached under its expected key`,
      );
      const queriesAfterMiss = queries.length;

      // HIT: served from cache, no additional D1.
      const hit = await handleRequest(new Request(url), env, ctx);
      assert.equal(hit.status, 200, `${r.keyParts}: HIT is 200`);
      assert.equal(
        queries.length,
        queriesAfterMiss,
        `${r.keyParts}: a HIT issues no further D1 query`,
      );
    }
  });
});

const NEURON_CAPTURED_AT = 1_781_500_000_000;
const NEURON_ROW = {
  uid: 0,
  hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  coldkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  active: 1,
  validator_permit: 1,
  rank: 0.1,
  trust: 0.9,
  validator_trust: 0.8,
  consensus: 0.7,
  incentive: 0.6,
  dividends: 0.5,
  emission_tao: 1,
  stake_tao: 100,
  registered_at_block: 1,
  is_immunity_period: 0,
  axon: null,
  block_number: 100,
  captured_at: NEURON_CAPTURED_AT,
};

function neuronsEnv(
  queries,
  { lastRunAt = LAST_RUN_AT, neuronCapturedAt = NEURON_CAPTURED_AT } = {},
) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            queries.push({ sql, params });
            if (sql.includes("MAX(captured_at)")) {
              return {
                all: () =>
                  Promise.resolve({
                    results: [{ captured_at: neuronCapturedAt }],
                  }),
              };
            }
            if (sql.includes("FROM neurons")) {
              return {
                all: () => Promise.resolve({ results: [NEURON_ROW] }),
              };
            }
            return { all: () => Promise.resolve({ results: [] }) };
          },
        };
      },
    },
    METAGRAPH_CONTROL: {
      async get(key) {
        if (key === "health:meta") {
          return lastRunAt ? { last_run_at: lastRunAt } : null;
        }
        return null;
      },
    },
  };
}

function expectedStampKey(stamp, keyParts, pathname, search = "") {
  return `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
    CONTRACT_VERSION,
  )}/${encodeURIComponent(stamp)}/${keyParts}${pathname}${search}`;
}

describe("neurons-tier edge cache", () => {
  test("metagraph/validators/concentration key on neuron captured_at, not health last_run_at", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = neuronsEnv(queries);

    for (const [keyParts, path] of [
      ["subnet-metagraph", "/api/v1/subnets/7/metagraph"],
      ["subnet-validators", "/api/v1/subnets/7/validators"],
      ["subnet-concentration", "/api/v1/subnets/7/concentration"],
    ]) {
      await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env,
        ctx,
      );
      await Promise.resolve();
      assert.ok(
        cache.putKeys.some((key) =>
          key.includes(encodeURIComponent(String(NEURON_CAPTURED_AT))),
        ),
        `${keyParts}: cache key must include neuron captured_at`,
      );
      assert.ok(
        !cache.putKeys.some((key) =>
          key.includes(encodeURIComponent(LAST_RUN_AT)),
        ),
        `${keyParts}: cache key must not use health last_run_at`,
      );
    }
  });

  test("a new neuron captured_at busts cache while health last_run_at is unchanged", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const envA = neuronsEnv(queries, { neuronCapturedAt: NEURON_CAPTURED_AT });
    const url = "https://api.metagraph.sh/api/v1/subnets/7/metagraph";

    await handleRequest(new Request(url), envA, ctx);
    await Promise.resolve();
    assert.deepEqual(cache.putKeys, [
      expectedStampKey(
        String(NEURON_CAPTURED_AT),
        "subnet-metagraph",
        "/api/v1/subnets/7/metagraph",
      ),
    ]);

    const envB = neuronsEnv(queries, {
      neuronCapturedAt: NEURON_CAPTURED_AT + 60_000,
    });
    await handleRequest(new Request(url), envB, ctx);
    await Promise.resolve();
    assert.equal(
      cache.store.size,
      2,
      "a newer captured_at must seed a new entry",
    );
  });

  test("health percentiles still bust on health last_run_at only", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = neuronsEnv(queries);

    await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      ),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "percentiles",
        "/api/v1/subnets/7/health/percentiles",
        "?window=7d",
      ),
    ]);
  });
});
