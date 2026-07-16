import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { envelopeResponse } from "../workers/responses.mjs";
import {
  markD1FallbackResponse,
  withEdgeCache,
} from "../workers/request-handlers/analytics.mjs";
import {
  handleBlocksSummary,
  handleSubnetStakeFlow,
} from "../workers/request-handlers/entities.mjs";
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
  if (sql.includes("FROM neurons")) {
    return [{ captured_at: 1_750_009_000_000 }];
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

  // #5554: HEAD probes on the D1-aggregation routes must be normalized through
  // the GET cache key so a HEAD-probe burst is served from the warm cache
  // instead of re-running the full aggregation every call (matching the 12
  // sibling routes). Before the fix these routes passed the raw HEAD request +
  // a zero-arg builder to withEdgeCache, so `cache` resolved to null and every
  // HEAD bypassed the cache and re-queried D1.
  test("REGRESSION #5554: a HEAD request hits the warm edge cache without re-querying D1", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const target =
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d";

    // Warm the cache with a GET — a cold cache must touch D1 and store one entry.
    const getRes = await handleRequest(new Request(target), env, ctx);
    assert.equal(getRes.status, 200);
    assert.equal(cache.putKeys.length, 1);
    const queriesAfterGet = queries.length;
    assert.ok(queriesAfterGet > 0, "cold GET should query D1");

    // A HEAD probe against the warm entry must be served from cache: no new D1
    // query, no re-put, a bodyless 200.
    const headRes = await handleRequest(
      new Request(target, { method: "HEAD" }),
      env,
      ctx,
    );
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), "", "HEAD carries no body");
    assert.equal(
      queries.length,
      queriesAfterGet,
      "HEAD cache hit must not re-run the D1 aggregation",
    );
    assert.equal(cache.putKeys.length, 1, "HEAD hit must not re-put");
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

  test("performance history canonicalizes equivalent window query strings before caching", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const variants = [
      "https://api.metagraph.sh/api/v1/subnets/7/performance/history?window=90d",
      "https://api.metagraph.sh/api/v1/subnets/7/performance/history?window=90d&",
      "https://api.metagraph.sh/api/v1/subnets/7/performance/history?window=90d&&",
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
        "subnet-performance-history",
        "/api/v1/subnets/7/performance/history",
        "?window=90d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("yield history canonicalizes equivalent window query strings before caching", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const variants = [
      "https://api.metagraph.sh/api/v1/subnets/7/yield/history?window=90d",
      "https://api.metagraph.sh/api/v1/subnets/7/yield/history?window=90d&",
      "https://api.metagraph.sh/api/v1/subnets/7/yield/history?window=90d&&",
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
        "subnet-yield-history",
        "/api/v1/subnets/7/yield/history",
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

  test("stake-flow canonicalizes omitted and explicit default window to the same cache key", async () => {
    // Postgres-unavailable stake-flow stubs are intentionally not edge-cached
    // (#6012); exercise the canonical key on a successful account_events tier.
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const dataApiCalls = [];
    const env = {
      ...analyticsEnv([]),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        async fetch(request) {
          dataApiCalls.push(request.url);
          return Response.json({
            data: {
              schema_version: 1,
              netuid: 7,
              window: "30d",
              total_staked_tao: 0,
              total_unstaked_tao: 0,
              net_flow_tao: 0,
              stake_events: 0,
              unstake_events: 0,
            },
            generatedAt: LAST_RUN_AT,
          });
        },
      },
    };

    // No ?window — should resolve to the 30d default and cache at ?window=30d.
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/stake-flow"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const callsAfterMiss = dataApiCalls.length;
    assert.equal(callsAfterMiss, 1);

    // Explicit ?window=30d is the canonical form — must be a cache HIT (no DATA_API).
    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=30d",
      ),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      dataApiCalls.length,
      callsAfterMiss,
      "explicit ?window=30d must be a cache HIT (no DATA_API fetches)",
    );

    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-stake-flow",
        "/api/v1/subnets/7/stake-flow",
        "?window=30d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet weights routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetWeights, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/weights"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_setters, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey("subnet-weights", "/api/v1/subnets/7/weights", "?window=7d"),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet serving routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetServing, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/serving"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_servers, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey("subnet-serving", "/api/v1/subnets/7/serving", "?window=7d"),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet prometheus routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetPrometheus, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/prometheus"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_exporters, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-prometheus",
        "/api/v1/subnets/7/prometheus",
        "?window=7d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet stake-moves routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetStakeMoves, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/stake-moves"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_movers, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-stake-moves",
        "/api/v1/subnets/7/stake-moves",
        "?window=7d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet stake-transfers routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetStakeTransfers, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/stake-transfers"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_senders, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-stake-transfers",
        "/api/v1/subnets/7/stake-transfers",
        "?window=7d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet registrations routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetRegistrations, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/registrations"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_registrants, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-registrations",
        "/api/v1/subnets/7/registrations",
        "?window=7d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet axon-removals routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetAxonRemovals, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/axon-removals"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_removers, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-axon-removals",
        "/api/v1/subnets/7/axon-removals",
        "?window=7d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("subnet deregistrations routes through the worker and caches at the default window", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetDeregistrations, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/deregistrations"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(typeof body.data.distinct_deregistered_hotkeys, "number");
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-deregistrations",
        "/api/v1/subnets/7/deregistrations",
        "?window=7d",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("chain-activity canonicalizes omitted and explicit default window to the same cache key", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    // No ?window — resolves to the 7d default and caches at ?window=7d.
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/activity"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    // Explicit ?window=7d is the canonical form — must be a cache HIT (no new D1).
    const hit = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/activity?window=7d"),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      queries.length,
      queriesAfterMiss,
      "explicit ?window=7d must be a cache HIT (no D1 queries)",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey("chain-activity", "/api/v1/chain/activity", "?window=7d"),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("chain-activity keys distinct windows separately (7d vs 30d)", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    for (const url of [
      "https://api.metagraph.sh/api/v1/chain/activity?window=7d",
      "https://api.metagraph.sh/api/v1/chain/activity?window=30d",
    ]) {
      await handleRequest(new Request(url), env, ctx);
      await Promise.resolve();
    }
    // Distinct windows remain distinct entries (canonical key preserves window).
    assert.equal(cache.store.size, 2);
    assert.deepEqual(cache.putKeys, [
      expectedKey("chain-activity", "/api/v1/chain/activity", "?window=7d"),
      expectedKey("chain-activity", "/api/v1/chain/activity", "?window=30d"),
    ]);
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

  // #6012: handleSubnetStakeFlow / handleBlocksSummary used to pass the
  // *Promise* from envelopeResponse into markD1FallbackResponse. withEdgeCache
  // then saw the awaited Response (a different object) and cached the stub.
  test("NO-CACHE-ON-ERROR: handleSubnetStakeFlow stub is marked and not edge-cached (#6012)", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = new Request(
      "https://api.metagraph.sh/api/v1/subnets/7/stake-flow",
    );
    const routeUrl = new URL(request.url);

    const res = await withEdgeCache(
      request,
      ctx,
      env,
      "subnet-stake-flow",
      () => handleSubnetStakeFlow(request, env, 7, routeUrl),
    );
    await Promise.resolve();

    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "postgres-unavailable stake-flow stub must not be edge-cached",
    );
    assert.equal(cache.store.size, 0);
  });

  test("NO-CACHE-ON-ERROR: handleBlocksSummary stub is marked and not edge-cached (#6012)", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = new Request(
      "https://api.metagraph.sh/api/v1/blocks/summary",
    );
    const routeUrl = new URL(request.url);

    const res = await withEdgeCache(request, ctx, env, "blocks-summary", () =>
      handleBlocksSummary(request, env, routeUrl),
    );
    await Promise.resolve();

    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "postgres-unavailable blocks/summary stub must not be edge-cached",
    );
    assert.equal(cache.store.size, 0);
  });

  test("HEAD requests use the GET edge-cache key while returning HEAD semantics", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = new Request("https://api.metagraph.sh/api/v1/test", {
      method: "HEAD",
    });
    let buildCalls = 0;
    let buildMethod = null;

    const first = await withEdgeCache(
      request,
      ctx,
      env,
      "unit",
      async (req) => {
        buildCalls += 1;
        buildMethod = req.method;
        return envelopeResponse(
          req,
          {
            data: { ok: true },
            meta: { generated_at: LAST_RUN_AT },
          },
          "short",
        );
      },
    );
    await Promise.resolve();

    assert.equal(first.status, 200);
    assert.equal(await first.text(), "");
    assert.equal(buildMethod, "GET");
    assert.equal(buildCalls, 1);
    assert.deepEqual(cache.putKeys, [expectedKey("unit", "/api/v1/test")]);

    const second = await withEdgeCache(
      request,
      ctx,
      env,
      "unit",
      async (_req) => {
        buildCalls += 1;
        throw new Error("cached HEAD should not rebuild");
      },
    );

    assert.equal(second.status, 200);
    assert.equal(await second.text(), "");
    assert.equal(buildCalls, 1);
    assert.equal(cache.matchCalls, 2);
  });

  test("HEAD /api/v1/validators reuses the GET edge cache before the Postgres tier", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const dataApiMethods = [];
    const env = {
      ...analyticsEnv([]),
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        async fetch(request) {
          dataApiMethods.push(request.method);
          return Response.json({
            schema_version: 1,
            sort: "subnet_count",
            limit: 20,
            captured_at: null,
            block_number: null,
            validator_count: 0,
            validators: [],
          });
        },
      },
    };
    const request = new Request("https://api.metagraph.sh/api/v1/validators", {
      method: "HEAD",
    });

    const first = await handleRequest(request, env, ctx);
    await Promise.resolve();
    const second = await handleRequest(request, env, ctx);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(await first.text(), "");
    assert.equal(await second.text(), "");
    assert.deepEqual(dataApiMethods, ["GET"]);
    assert.equal(cache.matchCalls, 2);
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

  test("health percentiles: bare path populates cache; explicit ?window=7d is a HIT", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/health/percentiles";

    const miss = await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(miss.status, 200);
    const queriesAfterMiss = queries.length;

    const hit = await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      queries.length,
      queriesAfterMiss,
      "explicit ?window=7d must be a cache HIT after bare request",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey("percentiles", base, "?window=7d"),
    ]);
  });

  test("health percentiles: explicit ?window=7d populates cache; bare path is a HIT", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/health/percentiles";

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
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
      "bare path must be a cache HIT after explicit ?window=7d",
    );
  });

  test("health incidents: bare path populates cache; explicit ?window=7d is a HIT", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/health/incidents";

    const miss = await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(miss.status, 200);
    const queriesAfterMiss = queries.length;

    const hit = await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      queries.length,
      queriesAfterMiss,
      "explicit ?window=7d must be a cache HIT after bare request",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey("incidents", base, "?window=7d"),
    ]);
  });

  test("health incidents: explicit ?window=7d populates cache; bare path is a HIT", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/health/incidents";

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
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
      "bare path must be a cache HIT after explicit ?window=7d",
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
        search: "?limit=20",
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

  test("subnet movers CSV requests use a distinct cache key", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/movers?sort=emission",
        { headers: { accept: "text/csv" } },
      ),
      env,
      ctx,
    );
    await Promise.resolve();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "subnet-movers",
        "/api/v1/subnets/movers",
        "?window=30d&sort=emission&limit=20&format=csv",
      ),
    ]);
  });
});

// #5358: the neurons/neuron_daily-backed cache-stamp functions
// (readSubnetNeuronsCacheStamp, readNeuronsCacheStamp, readNeuronDailyCacheStamp,
// withNeuronsEdgeCache) have been removed from
// workers/request-handlers/analytics.mjs. Every one of them read a D1 table
// (neurons / neuron_daily) that was fully dropped by #4772 ("retire D1
// chain-data write path"), so they had been reading a permanently-empty/
// nonexistent source and returning a frozen stamp ever since -- these routes'
// edge caches never correctly busted on new data (they just served stale
// content until the CDN's own TTL expired). The 11 call sites that used to pass
// one of these as a custom `resolveCacheStamp` now fall through to
// withEdgeCache's DEFAULT stamp: the same shared health-cron `last_run_at` KV
// value every other Postgres-tier analytics route already busts on. These
// handlers were also already migrated (#4909) to read Postgres only (a D1
// query would always miss the dropped table), so they never touch D1 at all
// now, on either a MISS or a HIT.

const FORMERLY_NEURONS_TIER_SUBNET_ROUTES = [
  { keyParts: "subnet-metagraph", path: "/api/v1/subnets/7/metagraph" },
  { keyParts: "subnet-validators", path: "/api/v1/subnets/7/validators" },
  {
    keyParts: "subnet-concentration",
    path: "/api/v1/subnets/7/concentration",
  },
  { keyParts: "subnet-performance", path: "/api/v1/subnets/7/performance" },
  { keyParts: "subnet-yield", path: "/api/v1/subnets/7/yield" },
];

describe("formerly neurons-tier routes now share the health-cron edge-cache stamp (#5358)", () => {
  test("a NEW neurons.captured_at value no longer busts the cache -- it's a dead signal now", async () => {
    // The key regression test: before #5358 this exact scenario (a fresh
    // neuron captured_at, unchanged last_run_at) would have busted the cache
    // via readSubnetNeuronsCacheStamp. It must NOT anymore.
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    let neuronCapturedAt = 1_700_000_000_000;
    // A D1 stub that WOULD answer a captured_at-keyed stamp query if anything
    // still asked one. `queries` staying empty across both passes below is
    // itself part of the regression proof (#4909 already moved these routes to
    // Postgres-tier-only, so nothing should ever reach this stub).
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              queries.push({ sql, params });
              return {
                all: () =>
                  Promise.resolve({
                    results: [{ captured_at: neuronCapturedAt }],
                  }),
              };
            },
          };
        },
      },
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta" ? { last_run_at: LAST_RUN_AT } : null;
        },
      },
    };

    for (const { path } of FORMERLY_NEURONS_TIER_SUBNET_ROUTES) {
      await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env,
        ctx,
      );
    }
    await Promise.resolve();
    const putKeysAfterFirstPass = [...cache.putKeys];
    assert.equal(
      putKeysAfterFirstPass.length,
      FORMERLY_NEURONS_TIER_SUBNET_ROUTES.length,
    );
    for (const key of putKeysAfterFirstPass) {
      assert.ok(
        key.includes(encodeURIComponent(LAST_RUN_AT)),
        `cache key must key on the shared health-cron stamp: ${key}`,
      );
    }

    // Bump the (now-dead) neuron captured_at signal, same last_run_at -- every
    // one of these routes must still be a cache HIT (same key, no new entry).
    neuronCapturedAt += 60_000;
    for (const { path } of FORMERLY_NEURONS_TIER_SUBNET_ROUTES) {
      await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env,
        ctx,
      );
    }
    await Promise.resolve();
    assert.deepEqual(
      cache.putKeys,
      putKeysAfterFirstPass,
      "a changed neuron captured_at must not seed any new cache entry",
    );
    assert.equal(cache.store.size, FORMERLY_NEURONS_TIER_SUBNET_ROUTES.length);
    assert.equal(
      queries.length,
      0,
      "none of these routes touch D1 at all anymore (Postgres-tier only, #4909)",
    );
  });

  test("a NEW health-cron last_run_at DOES bust the cache for all 5 formerly-neurons-tier per-subnet routes", async () => {
    for (const { keyParts, path } of FORMERLY_NEURONS_TIER_SUBNET_ROUTES) {
      originalCaches = globalThis.caches;
      const cache = mockCaches();
      cache.install();
      const url = `https://api.metagraph.sh${path}`;

      await handleRequest(
        new Request(url),
        analyticsEnv([], { lastRunAt: LAST_RUN_AT }),
        ctx,
      );
      await Promise.resolve();
      assert.equal(
        cache.store.size,
        1,
        `${keyParts}: first stamp seeds one entry`,
      );

      const NEW_LAST_RUN_AT = "2026-06-19T00:00:00.000Z";
      await handleRequest(
        new Request(url),
        analyticsEnv([], { lastRunAt: NEW_LAST_RUN_AT }),
        ctx,
      );
      await Promise.resolve();
      assert.equal(
        cache.store.size,
        2,
        `${keyParts}: a fresh health-cron last_run_at must seed a NEW entry`,
      );
      assert.ok(
        cache.putKeys.some((key) =>
          key.includes(encodeURIComponent(NEW_LAST_RUN_AT)),
        ),
        `${keyParts}: the new entry must key on the new last_run_at`,
      );

      globalThis.caches = originalCaches;
    }
  });

  test("global validators canonicalizes equivalent query variants before caching, with ZERO D1 queries on the HIT", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/validators?limit=1"),
      env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/validators?limit=01&sort=subnet_count",
      ),
      env,
      ctx,
    );
    assert.equal(hit.status, 200);
    // Before #5358 a HIT still issued one D1 query to read the neuron
    // captured_at stamp (readNeuronsCacheStamp); the stamp is now KV-sourced,
    // so a HIT must not touch D1 at all.
    assert.equal(
      queries.length,
      queriesAfterMiss,
      "a cache HIT must not issue any D1 query now that the stamp is KV-sourced",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "global-validators",
        "/api/v1/validators",
        "?sort=subnet_count&limit=1",
      ),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("global validators rejects invalid queries before touching D1 or the cache", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/validators?bogus=1"),
      env,
      ctx,
    );
    await Promise.resolve();

    assert.equal(res.status, 400);
    assert.equal(queries.length, 0, "invalid queries must not touch D1");
    assert.deepEqual(cache.putKeys, []);
    assert.equal(cache.store.size, 0);
  });

  test("health percentiles still bust on health last_run_at (unaffected sibling route)", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

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
