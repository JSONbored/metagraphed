import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
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

  // Regression for #1760: the four D1-backed analytics handlers tag a degraded
  // response into the D1_FALLBACK_RESPONSES WeakSet so withEdgeCache can refuse to
  // cache it (the per-response cold-D1 poison guard). That guard is only reachable
  // if `envelopeResponse` — which is async — is AWAITED at the tag site: a missing
  // await tags the *Promise*, and withEdgeCache checks the awaited Response, which
  // never matches, leaving the per-response guard inert (masked only by the coarser
  // module-level generation counter). Pin the awaits in the source so a regression
  // is caught even where the two guards happen to coincide in the harness. The
  // handlers + their cache guard live in request-handlers/analytics.mjs (#1763).
  test("REGRESSION #1760: every analytics handler awaits envelopeResponse at its fallback-tag site", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../workers/request-handlers/analytics.mjs", import.meta.url),
      ),
      "utf8",
    );
    // The bare `const response = envelopeResponse(` form is the bug: the response
    // is a Promise the WeakSet can never match. Only the awaited form is allowed
    // anywhere a response is bound for tagging.
    assert.equal(
      /const response = envelopeResponse\(/.test(source),
      false,
      "an un-awaited `const response = envelopeResponse(...)` cannot be tagged into the D1-fallback WeakSet",
    );
    // The four analytics handlers each tag their degraded response. Each
    // `markD1FallbackResponse(response)` must operate on a real (awaited) Response.
    assert.equal(
      (source.match(/\? markD1FallbackResponse\(response\)/g) || []).length,
      4,
      "all four analytics handlers tag their fallback response",
    );
  });

  // Exercises the WeakSet tag path end-to-end across all four handlers: each is
  // forced into a D1 fallback and the degraded response must not be cached. Because
  // the response is now the awaited Response (not a Promise), markD1FallbackResponse
  // tags the object withEdgeCache actually inspects.
  test("REGRESSION #1760: a degraded D1 response is refused by the edge cache across all four handlers", async () => {
    originalCaches = globalThis.caches;
    const routes = [
      "https://api.metagraph.sh/api/v1/health/trends",
      "https://api.metagraph.sh/api/v1/subnets/7/health/trends",
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      "https://api.metagraph.sh/api/v1/subnets/7/health/incidents?window=7d",
    ];
    for (const url of routes) {
      const cache = mockCaches();
      cache.install();
      const queries = [];
      const env = analyticsEnv(queries, {
        d1Error: new Error("D1 unavailable"),
      });
      const res = await handleRequest(new Request(url), env, ctx);
      await Promise.resolve();
      assert.equal(
        res.status,
        200,
        `${url}: degraded fallback still serves 200`,
      );
      assert.deepEqual(
        cache.putKeys,
        [],
        `${url}: a D1 fallback response must not poison the edge cache`,
      );
      assert.equal(cache.store.size, 0, `${url}: nothing cached`);
    }
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
      {
        keyParts: "reliability",
        path: "/api/v1/subnets/7/reliability",
        search: "?window=30d",
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
