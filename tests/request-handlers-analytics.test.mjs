// Direct unit tests for workers/request-handlers/analytics.mjs (#1925).
// Imports every exported handler/helper and exercises the D1 read path,
// query-param guards, edge-cache contract, and schema-stable cold-store
// payloads without routing through workers/api.mjs.

import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  configureAnalytics,
  withEdgeCache,
  handleBulkHealthTrends,
  handleHealthTrends,
  handleHealthPercentiles,
  handleHealthIncidents,
  handleGlobalIncidents,
  handleChainActivity,
  handleChainCalls,
  handleChainSigners,
  handleChainFees,
  validateQueryParams,
  analyticsWindow,
  d1All,
  d1Runner,
  hasD1FallbackRows,
  markD1FallbackResponse,
  analyticsQueryError,
  canonicalAnalyticsCacheRoute,
  canonicalHealthWindowCachePath,
} from "../workers/request-handlers/analytics.mjs";
import { tryPostgresTier } from "../workers/postgres-tier.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import {
  ANALYTICS_WINDOW_PARAM,
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  DAY_MS,
} from "../workers/config.mjs";

configureAnalytics({
  readHealthMetaKv: async (env) => {
    if (typeof env.__healthMeta !== "undefined") return env.__healthMeta;
    if (env.METAGRAPH_CONTROL?.get) {
      return env.METAGRAPH_CONTROL.get("health:meta", { type: "json" });
    }
    return null;
  },
});

const NETUID = 7;
const LAST_RUN_AT = "2026-06-18T00:00:00.000Z";
const ctx = { waitUntil: (promise) => promise };

function req(path, init = {}) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res, status = 400) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

function emptyEnv() {
  return {};
}

// One row backs every shape the analytics SQL returns (shared ok-latency CTE,
// SLA aggregates, gap-island incidents, bulk daily uptime).
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
  if (sql.includes("SUM(ok) AS ok_count") && !sql.includes("WITH")) {
    return [{ surface_id: "s1", surface_key: "s1", total: 100, ok_count: 98 }];
  }
  if (sql.includes("WITH checks") || sql.includes("recent_checks")) {
    return [
      {
        netuid: NETUID,
        surface_id: "s1",
        surface_key: "s1",
        started_at: 1_000_000_000_000,
        ended_at: 1_000_000_120_000,
        failed_samples: 2,
      },
    ];
  }
  if (sql.includes("FROM surface_uptime_daily")) {
    const recentDay = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    const olderDay = new Date(Date.now() - 20 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return [
      {
        netuid: NETUID,
        day: recentDay,
        date: recentDay,
        total: 100,
        ok_count: 98,
        latency_samples: 96,
        p50: 120,
        p95: 400,
      },
      {
        netuid: NETUID,
        day: olderDay,
        date: olderDay,
        total: 50,
        ok_count: 45,
        latency_samples: 48,
        p50: 200,
        p95: 500,
      },
    ];
  }
  return [];
}

// D1 mock that routes SQL by regex patterns (order-sensitive: specific first).
function dbWith({
  rows = null,
  rowsFn = rowsForSql,
  d1Error = null,
  captures = null,
} = {}) {
  const cap = captures || { sql: [], params: [] };
  const record = (sql, params) => {
    cap.sql.push(sql);
    cap.params.push(params);
  };
  const resolveRows = (sql) => {
    if (rows !== null) return rows;
    return rowsFn(sql);
  };
  return {
    env: {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              record(sql, params);
              return {
                all: () =>
                  d1Error
                    ? Promise.reject(d1Error)
                    : Promise.resolve({ results: resolveRows(sql) }),
              };
            },
          };
        },
      },
      METAGRAPH_CONTROL: {
        async get(key) {
          if (key === "health:meta") {
            return { last_run_at: LAST_RUN_AT };
          }
          return null;
        },
      },
    },
    captures: cap,
  };
}

function analyticsEnv(
  queries,
  { lastRunAt = LAST_RUN_AT, d1Error = null, healthMeta = undefined } = {},
) {
  const env = {
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
          if (healthMeta !== undefined) return healthMeta;
          return lastRunAt ? { last_run_at: lastRunAt } : null;
        }
        return null;
      },
    },
  };
  if (healthMeta !== undefined) {
    env.__healthMeta = healthMeta;
  }
  return env;
}

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

function expectedKey(keyParts, pathname, search = "") {
  return `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
    CONTRACT_VERSION,
  )}/${encodeURIComponent(LAST_RUN_AT)}/${keyParts}${pathname}${search}`;
}

let originalCaches;
afterEach(() => {
  globalThis.caches = originalCaches;
});

// ---- A) Pure helper tests ---------------------------------------------------

describe("validateQueryParams", () => {
  test("returns null when no query params and none allowed", () => {
    assert.equal(validateQueryParams(url("/x"), []), null);
  });

  test("returns null when only allowed params are present once", () => {
    const u = url("/x?window=7d");
    assert.equal(validateQueryParams(u, ["window"]), null);
  });

  test("returns null when multiple distinct allowed params appear once each", () => {
    const u = url("/x?window=7d&foo=bar");
    assert.equal(validateQueryParams(u, ["window", "foo"]), null);
  });

  test("rejects an unsupported query param", () => {
    const u = url("/x?bogus=1");
    const err = validateQueryParams(u, []);
    assert.equal(err.parameter, "bogus");
    assert.match(err.message, /not supported/);
  });

  test("rejects the first unsupported param when several are present", () => {
    const u = url("/x?alpha=1&beta=2");
    const err = validateQueryParams(u, ["window"]);
    assert.equal(err.parameter, "alpha");
  });

  test("rejects a duplicate allowed param", () => {
    const u = url("/x?window=7d&window=30d");
    const err = validateQueryParams(u, ["window"]);
    assert.equal(err.parameter, "window");
    assert.match(err.message, /only be provided once/);
  });

  test("rejects duplicate unsupported params on the first occurrence in iteration", () => {
    const u = url("/x?foo=1&foo=2");
    const err = validateQueryParams(u, []);
    assert.equal(err.parameter, "foo");
  });

  test("allows empty-string values for allowed params", () => {
    const u = url("/x?window=");
    assert.equal(validateQueryParams(u, ["window"]), null);
  });

  test("rejects params not in the allow-list even when value is empty", () => {
    const u = url("/x?cursor=");
    const err = validateQueryParams(u, ["window"]);
    assert.equal(err.parameter, "cursor");
  });

  test("handles params with special characters in the key", () => {
    const u = url("/x?weird%5Bkey%5D=1");
    const err = validateQueryParams(u, []);
    assert.equal(err.parameter, "weird[key]");
  });

  test("accepts window-only allow-list for percentiles-style routes", () => {
    const u = url(`/x?${ANALYTICS_WINDOW_PARAM}=30d`);
    assert.equal(validateQueryParams(u, [ANALYTICS_WINDOW_PARAM]), null);
  });

  test("rejects netuid query param on routes that take none", () => {
    const u = url("/x?netuid=7");
    const err = validateQueryParams(u, []);
    assert.equal(err.parameter, "netuid");
  });
});

describe("canonicalAnalyticsCacheRoute", () => {
  test("normalizes decoded query values for cache keys", () => {
    const plain = url(
      "/api/v1/chain/signers?call_module=Balances&limit=10&window=30d&sort=total_fee_tao",
    );
    const encoded = url(
      "/api/v1/chain/signers?limit=10&call_module=%42alances&sort=total_fee_tao&window=30d",
    );

    assert.equal(
      canonicalAnalyticsCacheRoute(plain, ["limit", "call_module", "sort"]),
      "/api/v1/chain/signers?window=30d&limit=10&call_module=Balances&sort=total_fee_tao",
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(encoded, ["limit", "call_module", "sort"]),
      canonicalAnalyticsCacheRoute(plain, ["limit", "call_module", "sort"]),
    );
  });

  test("normalizes a missing window to the default window", () => {
    const bare = url("/api/v1/chain/transfers?limit=25");
    const explicit = url(`/api/v1/chain/transfers?window=7d&limit=25`);
    assert.equal(
      canonicalAnalyticsCacheRoute(bare, ["limit"]),
      `/api/v1/chain/transfers?window=${DEFAULT_ANALYTICS_WINDOW}&limit=25`,
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(explicit, ["limit"]),
      canonicalAnalyticsCacheRoute(bare, ["limit"]),
    );
  });

  test("includes the chain calls grouping and module filter in canonical order", () => {
    const requestUrl = url(
      "/api/v1/chain/calls?call_module=SubtensorModule&limit=10&group_by=module_function&window=30d",
    );

    assert.equal(
      canonicalAnalyticsCacheRoute(requestUrl, [
        "group_by",
        "limit",
        "call_module",
      ]),
      "/api/v1/chain/calls?window=30d&group_by=module_function&limit=10&call_module=SubtensorModule",
    );
  });
});

describe("canonicalHealthWindowCachePath", () => {
  test("normalizes bare path to explicit default window", () => {
    assert.equal(
      canonicalHealthWindowCachePath(
        url("/api/v1/subnets/7/health/percentiles"),
      ),
      `/api/v1/subnets/7/health/percentiles?window=${DEFAULT_ANALYTICS_WINDOW}`,
    );
  });

  test("explicit default window collapses to same key as bare path", () => {
    assert.equal(
      canonicalHealthWindowCachePath(
        url("/api/v1/subnets/7/health/incidents?window=7d"),
      ),
      `/api/v1/subnets/7/health/incidents?window=${DEFAULT_ANALYTICS_WINDOW}`,
    );
  });

  test("preserves valid non-default window", () => {
    assert.equal(
      canonicalHealthWindowCachePath(
        url("/api/v1/subnets/7/health/percentiles?window=30d"),
      ),
      "/api/v1/subnets/7/health/percentiles?window=30d",
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = "/api/v1/subnets/7/health/incidents?cacheBust=x";
    assert.equal(canonicalHealthWindowCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid window value", () => {
    const raw = "/api/v1/subnets/7/health/percentiles?window=bogus";
    assert.equal(canonicalHealthWindowCachePath(url(raw)), raw);
  });
});

describe("analyticsWindow", () => {
  test("defaults to 7d when window param is absent", () => {
    const out = analyticsWindow(url("/x"));
    assert.equal(out.label, "7d");
    assert.equal(out.days, ANALYTICS_WINDOWS["7d"]);
    assert.equal(out.error, undefined);
  });

  test("accepts explicit 7d window", () => {
    const out = analyticsWindow(url("/x?window=7d"));
    assert.equal(out.label, "7d");
    assert.equal(out.days, 7);
  });

  test("accepts explicit 30d window", () => {
    const out = analyticsWindow(url("/x?window=30d"));
    assert.equal(out.label, "30d");
    assert.equal(out.days, 30);
  });

  test("rejects an invalid window value", () => {
    const out = analyticsWindow(url("/x?window=bogus"));
    assert.ok(out.error);
    assert.equal(out.error.parameter, ANALYTICS_WINDOW_PARAM);
    assert.match(out.error.message, /not a valid window/);
    assert.match(out.error.message, /7d/);
    assert.match(out.error.message, /30d/);
  });

  test("rejects unsupported extra query params", () => {
    const out = analyticsWindow(url("/x?window=7d&limit=10"));
    assert.ok(out.error);
    assert.equal(out.error.parameter, "limit");
  });

  test("rejects duplicate window params", () => {
    const out = analyticsWindow(url("/x?window=7d&window=30d"));
    assert.ok(out.error);
    assert.equal(out.error.parameter, "window");
  });

  test("rejects empty window string as invalid", () => {
    const out = analyticsWindow(url("/x?window="));
    assert.ok(out.error);
    assert.equal(out.error.parameter, ANALYTICS_WINDOW_PARAM);
  });

  test("rejects numeric window without suffix", () => {
    const out = analyticsWindow(url("/x?window=7"));
    assert.ok(out.error);
  });

  test("rejects 90d window (not in ANALYTICS_WINDOWS)", () => {
    const out = analyticsWindow(url("/x?window=90d"));
    assert.ok(out.error);
    assert.match(out.error.message, /90d/);
  });

  test("rejects case-sensitive window labels", () => {
    const out = analyticsWindow(url("/x?window=7D"));
    assert.ok(out.error);
  });

  test("returns days matching the configured ANALYTICS_WINDOWS map", () => {
    for (const [label, days] of Object.entries(ANALYTICS_WINDOWS)) {
      const out = analyticsWindow(url(`/x?window=${label}`));
      assert.equal(out.label, label);
      assert.equal(out.days, days);
    }
  });

  test("does not include error field on success", () => {
    const out = analyticsWindow(url("/x?window=30d"));
    assert.equal(out.error, undefined);
  });
});

describe("analyticsQueryError", () => {
  test("returns 400 invalid_query with parameter detail", async () => {
    const res = analyticsQueryError({
      parameter: "window",
      message: '"bogus" is not a valid window.',
    });
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
    assert.match(body.error.message, /bogus/);
  });

  test("sets x-metagraph-error-code header", async () => {
    const res = analyticsQueryError({
      parameter: "foo",
      message: "foo is not supported.",
    });
    assert.equal(res.headers.get("x-metagraph-error-code"), "invalid_query");
  });

  test("wraps validateQueryParams output for unsupported param", async () => {
    const validationError = validateQueryParams(url("/x?cursor=abc"), [
      ANALYTICS_WINDOW_PARAM,
    ]);
    const res = analyticsQueryError(validationError);
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "cursor");
  });
});

// ---- B) d1All / d1Runner / fallback bookkeeping -----------------------------

describe("d1All", () => {
  test("returns empty array when METAGRAPH_HEALTH_DB is unbound", async () => {
    const rows = await d1All(emptyEnv(), "SELECT 1", []);
    assert.deepEqual(rows, []);
  });

  test("returns empty array when db.prepare is missing", async () => {
    const rows = await d1All({ METAGRAPH_HEALTH_DB: {} }, "SELECT 1", []);
    assert.deepEqual(rows, []);
  });

  test("marks fallback rows when env is cold", async () => {
    const rows = await d1All(emptyEnv(), "SELECT 1", []);
    assert.equal(hasD1FallbackRows(rows), true);
  });

  test("returns query results on happy path", async () => {
    const { env } = dbWith();
    const rows = await d1All(
      env,
      "SELECT netuid FROM surface_uptime_daily WHERE day >= ?",
      ["2026-01-01"],
    );
    assert.ok(rows.length > 0);
    assert.equal(hasD1FallbackRows(rows), false);
  });

  test("marks fallback rows when D1 throws", async () => {
    const { env } = dbWith({ d1Error: new Error("D1 unavailable") });
    const rows = await d1All(env, "SELECT 1", []);
    assert.deepEqual(rows, []);
    assert.equal(hasD1FallbackRows(rows), true);
  });

  test("binds params to the prepared statement", async () => {
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    await d1All(env, "SELECT ? AS x", [NETUID]);
    assert.equal(cap.params[0][0], NETUID);
  });

  test("handles null results from D1 driver", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return { all: () => Promise.resolve(null) };
            },
          };
        },
      },
    };
    const rows = await d1All(env, "SELECT 1", []);
    assert.deepEqual(rows, []);
    assert.equal(hasD1FallbackRows(rows), false);
  });
});

describe("d1Runner", () => {
  test("binds env into a (sql, params) => rows function", async () => {
    const { env } = dbWith();
    const run = d1Runner(env);
    const rows = await run("SELECT netuid FROM surface_uptime_daily", []);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length > 0);
  });

  test("runner inherits cold-env fallback semantics", async () => {
    const run = d1Runner(emptyEnv());
    const rows = await run("SELECT 1", []);
    assert.deepEqual(rows, []);
    assert.equal(hasD1FallbackRows(rows), true);
  });
});

describe("markD1FallbackResponse / hasD1FallbackRows", () => {
  test("markD1FallbackResponse tags a Response object", () => {
    const response = new Response("{}");
    const tagged = markD1FallbackResponse(response);
    assert.equal(tagged, response);
  });

  test("hasD1FallbackRows detects any marked row set", async () => {
    const good = [{ x: 1 }];
    const bad = await d1All(emptyEnv(), "SELECT 1", []);
    assert.equal(hasD1FallbackRows(good), false);
    assert.equal(hasD1FallbackRows(good, bad), true);
    assert.equal(hasD1FallbackRows(bad), true);
  });

  test("hasD1FallbackRows returns false for unmarked empty arrays", () => {
    assert.equal(hasD1FallbackRows([]), false);
  });
});

// ---- C) withEdgeCache -------------------------------------------------------

describe("withEdgeCache", () => {
  test("MISS: runs buildResponse and caches 200 when snapshot stamp is warm", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const request = req(
      `/api/v1/subnets/${NETUID}/health/percentiles?window=7d`,
    );
    const pathname = `/api/v1/subnets/${NETUID}/health/percentiles`;
    const search = "?window=7d";

    const res = await withEdgeCache(
      request,
      ctx,
      env,
      "percentiles",
      async () => {
        queries.push({ handler: "build" });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"test-etag"',
          },
        });
      },
      `${pathname}${search}`,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, [
      expectedKey("percentiles", pathname, search),
    ]);
  });

  test("HIT: serves cached body without calling buildResponse", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = req("/api/v1/health/trends");
    const cacheRoute = "/api/v1/health/trends";
    const key = expectedKey("bulk-trends", cacheRoute);
    cache.store.set(
      key,
      new Response(JSON.stringify({ ok: true, cached: true }), {
        status: 200,
        headers: { etag: '"cached"' },
      }),
    );

    let built = false;
    const res = await withEdgeCache(
      request,
      ctx,
      env,
      "bulk-trends",
      async () => {
        built = true;
        return new Response("should not run");
      },
      cacheRoute,
    );
    assert.equal(built, false);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, true);
  });

  test("304: honours If-None-Match against cached etag", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const cacheRoute = `/api/v1/subnets/${NETUID}/health/trends`;
    const key = expectedKey("trends", cacheRoute);
    const cached = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { etag: '"snap-etag"', "cache-control": "max-age=60" },
    });
    cache.store.set(key, cached);

    const res = await withEdgeCache(
      req(cacheRoute, { headers: { "if-none-match": '"snap-etag"' } }),
      ctx,
      env,
      "trends",
      async () => new Response("miss"),
      cacheRoute,
    );
    assert.equal(res.status, 304);
    assert.equal(await res.text(), "");
  });

  test("skips cache entirely when last_run_at is null", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([], { lastRunAt: null });
    let built = false;
    const res = await withEdgeCache(
      req("/api/v1/health/trends"),
      ctx,
      env,
      "bulk-trends",
      async () => {
        built = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    assert.equal(built, true);
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, []);
    assert.equal(cache.matchCalls, 0);
  });

  test("does not cache when buildResponse returns non-200", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const res = await withEdgeCache(
      req("/api/v1/health/trends"),
      ctx,
      env,
      "bulk-trends",
      async () => new Response("bad", { status: 400 }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(cache.putKeys, []);
  });

  test("does not cache when response is marked as D1 fallback", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const res = await withEdgeCache(
      req("/api/v1/health/trends"),
      ctx,
      env,
      "bulk-trends",
      async () =>
        markD1FallbackResponse(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, []);
  });

  test("does not cache when d1FallbackGeneration changes during buildResponse", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const res = await withEdgeCache(
      req("/api/v1/health/trends"),
      ctx,
      env,
      "bulk-trends",
      async () => {
        await d1All(emptyEnv(), "SELECT 1", []);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, []);
  });

  test("does not cache when Postgres-tier fallback generation changes during buildResponse", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const res = await withEdgeCache(
      req("/api/v1/blocks/summary"),
      ctx,
      env,
      "blocks-summary",
      async () => {
        await tryPostgresTier(
          { METAGRAPH_BLOCKS_SOURCE: "postgres" },
          req("/api/v1/blocks/summary"),
          "METAGRAPH_BLOCKS_SOURCE",
        );
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, []);
  });

  test("skips cache for non-GET requests", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    let built = false;
    const res = await withEdgeCache(
      new Request("https://api.metagraph.sh/api/v1/health/trends", {
        method: "POST",
      }),
      ctx,
      env,
      "bulk-trends",
      async () => {
        built = true;
        return new Response("ok", { status: 200 });
      },
    );
    assert.equal(built, true);
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, []);
  });

  test("uses request pathname+search when cachePathAndSearch is omitted", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    await withEdgeCache(
      req(`/api/v1/subnets/${NETUID}/health/incidents?window=30d`),
      ctx,
      env,
      "incidents",
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { etag: '"e"' },
        }),
    );
    await Promise.resolve();
    assert.ok(
      cache.putKeys[0].includes(
        `/subnets/${NETUID}/health/incidents?window=30d`,
      ),
    );
  });

  test("reads health meta from env.__healthMeta override", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([], {
      healthMeta: { last_run_at: LAST_RUN_AT },
      lastRunAt: null,
    });
    await withEdgeCache(
      req("/api/v1/health/trends"),
      ctx,
      env,
      "bulk-trends",
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { etag: '"e"' },
        }),
    );
    await Promise.resolve();
    assert.equal(cache.putKeys.length, 1);
  });
});

// ---- D) handleBulkHealthTrends ----------------------------------------------

describe("handleBulkHealthTrends", () => {
  test("rejects any query param with 400", async () => {
    for (const qs of ["?window=7d", "?foo=1", "?limit=10&cursor=abc"]) {
      const res = await handleBulkHealthTrends(
        req(`/api/v1/health/trends${qs}`),
        emptyEnv(),
        url(`/api/v1/health/trends${qs}`),
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
    }
  });

  test("reports the offending parameter name in error details", async () => {
    const res = await handleBulkHealthTrends(
      req("/api/v1/health/trends?window=7d"),
      emptyEnv(),
      url("/api/v1/health/trends?window=7d"),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("cold D1 returns schema-stable empty windows", async () => {
    globalThis.caches = undefined;
    const env = { ...emptyEnv(), __healthMeta: { last_run_at: null } };
    const body = await json(
      await handleBulkHealthTrends(
        req("/api/v1/health/trends"),
        env,
        url("/api/v1/health/trends"),
      ),
    );
    assert.equal(body.data.schema_version, 1);
    assert.deepEqual(body.data.windows["7d"].subnets, []);
    assert.deepEqual(body.data.windows["30d"].subnets, []);
    assert.equal(body.data.observed_at, null);
  });

  test("happy path includes surface_uptime_daily aggregates per window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00.000Z"));
    try {
      globalThis.caches = undefined;
      const { env } = dbWith();
      env.__healthMeta = { last_run_at: LAST_RUN_AT };
      const body = await json(
        await handleBulkHealthTrends(
          req("/api/v1/health/trends"),
          env,
          url("/api/v1/health/trends"),
        ),
      );
      assert.equal(body.data.observed_at, LAST_RUN_AT);
      assert.ok(body.data.windows["7d"].subnets.length > 0);
      assert.equal(body.data.windows["7d"].subnets[0].netuid, NETUID);
    } finally {
      vi.useRealTimers();
    }
  });

  test("meta block carries bulk trends artifact path", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleBulkHealthTrends(
        req("/api/v1/health/trends"),
        env,
        url("/api/v1/health/trends"),
      ),
    );
    assert.equal(body.meta.artifact_path, "/metagraph/health/trends.json");
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.cache, "short");
  });

  test("D1 failure still returns 200 empty envelope", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith({ d1Error: new Error("boom") });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const res = await handleBulkHealthTrends(
      req("/api/v1/health/trends"),
      env,
      url("/api/v1/health/trends"),
    );
    const body = await json(res);
    assert.deepEqual(body.data.windows["7d"].subnets, []);
  });

  test("edge cache MISS then HIT avoids second D1 query", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const path = "/api/v1/health/trends";

    await handleBulkHealthTrends(req(path), env, url(path), ctx);
    await Promise.resolve();
    const afterMiss = queries.length;
    assert.ok(afterMiss > 0);

    await handleBulkHealthTrends(req(path), env, url(path), ctx);
    assert.equal(queries.length, afterMiss);
  });

  test("accepts request with no query string", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleBulkHealthTrends(
        req("/api/v1/health/trends"),
        env,
        url("/api/v1/health/trends"),
      ),
    );
    assert.equal(body.data.windows["7d"].days, 7);
    assert.equal(body.data.windows["30d"].days, 30);
  });

  test("filters older rows into 30d window only when within range", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleBulkHealthTrends(
        req("/api/v1/health/trends"),
        env,
        url("/api/v1/health/trends"),
      ),
    );
    assert.ok(Array.isArray(body.data.windows["30d"].subnets));
    assert.equal(body.data.windows["30d"].days, 30);
  });
});

// ---- E) handleHealthTrends --------------------------------------------------

describe("handleHealthTrends", () => {
  const trendsPath = `/api/v1/subnets/${NETUID}/health/trends`;

  test("rejects unsupported query params with 400", async () => {
    for (const qs of ["?window=7d", "?foo=bar", "?limit=1"]) {
      const res = await handleHealthTrends(
        req(`${trendsPath}${qs}`),
        emptyEnv(),
        NETUID,
        url(`${trendsPath}${qs}`),
      );
      await errorJson(res);
    }
  });

  test("cold D1 returns empty surfaces for all windows", async () => {
    globalThis.caches = undefined;
    const env = { ...emptyEnv(), __healthMeta: { last_run_at: null } };
    const body = await json(
      await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath)),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.deepEqual(body.data.windows["7d"].surfaces, []);
    assert.deepEqual(body.data.windows["30d"].surfaces, []);
  });

  test("happy path returns ranked CTE aggregates per window", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath)),
    );
    assert.equal(body.data.observed_at, LAST_RUN_AT);
    assert.equal(body.data.windows["7d"].surfaces[0].surface_id, "s1");
    assert.ok(body.data.windows["7d"].surfaces[0].uptime_ratio > 0);
  });

  test("meta references per-subnet trends artifact", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath)),
    );
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/health/trends/${NETUID}.json`,
    );
  });

  test("D1 throw per window still returns 200", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith({ d1Error: new Error("fail") });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath)),
    );
    assert.deepEqual(body.data.windows["7d"].surfaces, []);
  });

  test("issues parallel D1 queries for each configured window", async () => {
    globalThis.caches = undefined;
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath));
    const rankedQueries = cap.sql.filter((s) => s.includes("ranked"));
    assert.equal(rankedQueries.length, 2);
  });

  test("edge cache HIT avoids D1 on second request", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);

    await handleHealthTrends(
      req(trendsPath),
      env,
      NETUID,
      url(trendsPath),
      ctx,
    );
    await Promise.resolve();
    const afterMiss = queries.length;

    await handleHealthTrends(
      req(trendsPath),
      env,
      NETUID,
      url(trendsPath),
      ctx,
    );
    assert.equal(queries.length, afterMiss);
  });

  test("binds netuid param into ranked CTE query", async () => {
    globalThis.caches = undefined;
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath));
    assert.ok(cap.params.some((p) => p[0] === NETUID));
  });
});

// ---- F) handleHealthPercentiles ---------------------------------------------

describe("handleHealthPercentiles", () => {
  const base = `/api/v1/subnets/${NETUID}/health/percentiles`;

  test("rejects invalid window with 400", async () => {
    const res = await handleHealthPercentiles(
      req(`${base}?window=bogus`),
      emptyEnv(),
      NETUID,
      url(`${base}?window=bogus`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("rejects unsupported params alongside window", async () => {
    const res = await handleHealthPercentiles(
      req(`${base}?window=7d&sort=p95`),
      emptyEnv(),
      NETUID,
      url(`${base}?window=7d&sort=p95`),
    );
    await errorJson(res);
  });

  test("defaults to 7d window when param omitted", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthPercentiles(req(base), env, NETUID, url(base)),
    );
    assert.equal(body.data.window, "7d");
  });

  test("cold D1 returns empty surfaces", async () => {
    globalThis.caches = undefined;
    const env = { ...emptyEnv(), __healthMeta: { last_run_at: null } };
    const body = await json(
      await handleHealthPercentiles(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.deepEqual(body.data.surfaces, []);
    assert.equal(body.data.observed_at, null);
  });

  test("happy path maps latency percentiles from ranked CTE", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthPercentiles(
        req(`${base}?window=30d`),
        env,
        NETUID,
        url(`${base}?window=30d`),
      ),
    );
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.surfaces[0].surface_id, "s1");
    assert.equal(body.data.surfaces[0].latency_ms.p50, 120);
    assert.equal(body.data.surfaces[0].latency_ms.p95, 400);
  });

  test("meta uses percentiles artifact path", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthPercentiles(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/health/percentiles/${NETUID}.json`,
    );
  });

  test("D1 failure returns 200 with empty surfaces", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith({ d1Error: new Error("down") });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthPercentiles(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.deepEqual(body.data.surfaces, []);
  });

  test("accepts both configured window labels", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    for (const label of Object.keys(ANALYTICS_WINDOWS)) {
      const body = await json(
        await handleHealthPercentiles(
          req(`${base}?window=${label}`),
          env,
          NETUID,
          url(`${base}?window=${label}`),
        ),
      );
      assert.equal(body.data.window, label);
    }
  });

  test("edge cache stores percentiles under window-specific key", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    await handleHealthPercentiles(
      req(`${base}?window=7d`),
      env,
      NETUID,
      url(`${base}?window=7d`),
      ctx,
    );
    await Promise.resolve();
    assert.ok(cache.putKeys[0].includes("window=7d"));
  });
});

// ---- G) handleHealthIncidents -----------------------------------------------

describe("handleHealthIncidents", () => {
  const base = `/api/v1/subnets/${NETUID}/health/incidents`;

  test("rejects invalid window", async () => {
    const res = await handleHealthIncidents(
      req(`${base}?window=invalid`),
      emptyEnv(),
      NETUID,
      url(`${base}?window=invalid`),
    );
    await errorJson(res);
  });

  test("rejects duplicate window param", async () => {
    const res = await handleHealthIncidents(
      req(`${base}?window=7d&window=30d`),
      emptyEnv(),
      NETUID,
      url(`${base}?window=7d&window=30d`),
    );
    await errorJson(res);
  });

  test("cold D1 returns empty surfaces and incidents", async () => {
    globalThis.caches = undefined;
    const env = { ...emptyEnv(), __healthMeta: { last_run_at: null } };
    const body = await json(
      await handleHealthIncidents(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.deepEqual(body.data.surfaces, []);
    assert.equal(body.data.observed_at, null);
  });

  test("happy path merges SLA rows and gap-island incidents", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthIncidents(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.surfaces.length, 1);
    assert.equal(body.data.surfaces[0].surface_id, "s1");
    assert.ok(body.data.surfaces[0].uptime_ratio > 0);
    assert.equal(body.data.surfaces[0].incidents.length, 1);
  });

  test("issues parallel SLA and incident SQL queries", async () => {
    globalThis.caches = undefined;
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    await handleHealthIncidents(
      req(`${base}?window=30d`),
      env,
      NETUID,
      url(`${base}?window=30d`),
    );
    assert.ok(cap.sql.some((s) => s.includes("GROUP BY COALESCE")));
    assert.ok(cap.sql.some((s) => s.includes("WITH checks")));
    assert.ok(cap.sql.some((s) => s.includes("ROW_NUMBER()")));
    assert.equal(cap.sql.length, 2);
  });

  test("meta references incidents artifact path", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthIncidents(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/health/incidents/${NETUID}.json`,
    );
  });

  test("D1 failure on either query returns 200 empty envelope", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith({ d1Error: new Error("err") });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthIncidents(
        req(`${base}?window=7d`),
        env,
        NETUID,
        url(`${base}?window=7d`),
      ),
    );
    assert.deepEqual(body.data.surfaces, []);
  });

  test("defaults window to 7d when omitted", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthIncidents(req(base), env, NETUID, url(base)),
    );
    assert.equal(body.data.window, "7d");
  });

  test("edge cache HIT skips D1 on repeat request", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const queries = [];
    const env = analyticsEnv(queries);
    const u = `${base}?window=7d`;

    await handleHealthIncidents(req(u), env, NETUID, url(u), ctx);
    await Promise.resolve();
    const n = queries.length;
    await handleHealthIncidents(req(u), env, NETUID, url(u), ctx);
    assert.equal(queries.length, n);
  });
});

// ---- H) handleGlobalIncidents -----------------------------------------------

describe("handleGlobalIncidents", () => {
  const base = "/api/v1/incidents";

  test("rejects invalid window with analyticsQueryError shape", async () => {
    const res = await handleGlobalIncidents(
      req(`${base}?window=not-a-window`),
      emptyEnv(),
      url(`${base}?window=not-a-window`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("rejects unsupported extra params", async () => {
    const res = await handleGlobalIncidents(
      req(`${base}?window=7d&netuid=7`),
      emptyEnv(),
      url(`${base}?window=7d&netuid=7`),
    );
    await errorJson(res);
  });

  test("cold D1 returns empty incidents list", async () => {
    const env = { ...emptyEnv(), __healthMeta: { last_run_at: null } };
    const body = await json(
      await handleGlobalIncidents(
        req(`${base}?window=7d`),
        env,
        url(`${base}?window=7d`),
      ),
    );
    assert.deepEqual(body.data.surfaces, []);
    assert.equal(body.data.observed_at, null);
  });

  test("happy path runs global incident gap-island SQL", async () => {
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleGlobalIncidents(
        req(`${base}?window=7d`),
        env,
        url(`${base}?window=7d`),
      ),
    );
    assert.ok(cap.sql[0].includes("recent_checks"));
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.surfaces.length, 1);
    assert.equal(body.data.surfaces[0].netuid, NETUID);
    assert.equal(body.data.surfaces[0].incidents.length, 1);
  });

  test("defaults to 7d when window omitted", async () => {
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleGlobalIncidents(req(base), env, url(base)),
    );
    assert.equal(body.data.window, "7d");
  });

  test("accepts 30d window", async () => {
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleGlobalIncidents(
        req(`${base}?window=30d`),
        env,
        url(`${base}?window=30d`),
      ),
    );
    assert.equal(body.data.window, "30d");
  });

  test("meta references global incidents artifact", async () => {
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleGlobalIncidents(
        req(`${base}?window=7d`),
        env,
        url(`${base}?window=7d`),
      ),
    );
    assert.equal(body.meta.artifact_path, "/metagraph/incidents.json");
    assert.equal(body.meta.source, "live-cron-prober");
  });

  test("D1 failure returns 200 with empty incidents", async () => {
    const { env } = dbWith({ d1Error: new Error("fail") });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleGlobalIncidents(
        req(`${base}?window=7d`),
        env,
        url(`${base}?window=7d`),
      ),
    );
    assert.deepEqual(body.data.surfaces, []);
  });

  test("does not use withEdgeCache (no ctx required)", async () => {
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    await handleGlobalIncidents(
      req(`${base}?window=7d`),
      env,
      url(`${base}?window=7d`),
    );
    assert.equal(cap.sql.length, 1);
  });

  test("binds since timestamp and cap params into global SQL", async () => {
    const cap = { sql: [], params: [] };
    const { env } = dbWith({ captures: cap });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    await handleGlobalIncidents(
      req(`${base}?window=7d`),
      env,
      url(`${base}?window=7d`),
    );
    assert.ok(Array.isArray(cap.params[0]));
    assert.ok(typeof cap.params[0][0] === "number");
  });
});

// ---- Cross-handler invariants ------------------------------------------------

describe("analytics handler invariants", () => {
  test("all successful handler responses include ok: true envelope", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const handlers = [
      () =>
        handleBulkHealthTrends(
          req("/api/v1/health/trends"),
          env,
          url("/api/v1/health/trends"),
        ),
      () =>
        handleHealthTrends(
          req(`/api/v1/subnets/${NETUID}/health/trends`),
          env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/health/trends`),
        ),
      () =>
        handleHealthPercentiles(
          req(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
          env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
        ),
      () =>
        handleHealthIncidents(
          req(`/api/v1/subnets/${NETUID}/health/incidents?window=7d`),
          env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/health/incidents?window=7d`),
        ),
      () =>
        handleGlobalIncidents(
          req("/api/v1/incidents?window=7d"),
          env,
          url("/api/v1/incidents?window=7d"),
        ),
    ];
    for (const run of handlers) {
      const body = await json(await run());
      assert.equal(body.data.schema_version, 1);
    }
  });

  test("contract_version in meta matches CONTRACT_VERSION constant", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthPercentiles(
        req(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
      ),
    );
    assert.equal(body.meta.contract_version, CONTRACT_VERSION);
  });

  test("readHealthMetaKv falls back to METAGRAPH_CONTROL KV", async () => {
    globalThis.caches = undefined;
    const env = analyticsEnv([]);
    const body = await json(
      await handleHealthPercentiles(
        req(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
      ),
    );
    assert.equal(body.data.observed_at, LAST_RUN_AT);
  });

  test("etag header present on edge-cached handler success", async () => {
    globalThis.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const res = await handleHealthTrends(
      req(`/api/v1/subnets/${NETUID}/health/trends`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/health/trends`),
    );
    assert.ok(res.headers.get("etag"));
  });

  test("D1 fallback responses are not edge-cached when stamp is warm", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([], { d1Error: new Error("D1 down") });
    await handleHealthPercentiles(
      req(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/health/percentiles?window=7d`),
      ctx,
    );
    await Promise.resolve();
    assert.deepEqual(cache.putKeys, []);
  });
});

// ---- Chain-analytics CSV export (#2532) ------------------------------------

describe("chain analytics ?format=csv export", () => {
  const cases = [
    {
      name: "chain-activity",
      path: "/api/v1/chain/activity",
      handler: handleChainActivity,
      header:
        "day,block_count,extrinsic_count,event_count,successful_extrinsics,success_rate,unique_signers",
    },
    {
      name: "chain-calls",
      path: "/api/v1/chain/calls",
      handler: handleChainCalls,
      header: "call_module,count,share",
    },
    {
      name: "chain-signers",
      path: "/api/v1/chain/signers",
      handler: handleChainSigners,
      header: "signer,tx_count,total_fee_tao,total_tip_tao,last_tx_block",
      // #4909/#6013: extrinsics' D1 write path is retired, so chain-signers no
      // longer queries D1 at all -- there is no "degraded D1" scenario to mark
      // as fallback anymore (see the dedicated test below instead).
      skipDegradedD1: true,
    },
    {
      name: "chain-fees",
      path: "/api/v1/chain/fees",
      handler: handleChainFees,
      header:
        "day,extrinsic_count,total_fee_tao,avg_fee_tao,median_fee_tao,total_tip_tao,avg_tip_tao,median_tip_tao",
    },
  ];

  for (const { name, path, handler, header, skipDegradedD1 } of cases) {
    test(`${name} ?window=7d&format=csv emits its columns as text/csv`, async () => {
      const { env } = dbWith({ rows: [] });
      const p = `${path}?window=7d&format=csv`;
      const res = await handler(req(p), env, url(p));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/csv/);
      // Explicit columns → a cold store still emits a header-only CSV (never empty).
      const text = await res.text();
      assert.equal(text.split("\r\n")[0], header);
    });

    test(`${name} keeps the JSON envelope when format is absent`, async () => {
      const { env } = dbWith({ rows: [] });
      const res = await handler(
        req(`${path}?window=7d`),
        env,
        url(`${path}?window=7d`),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /application\/json/);
    });

    test(`${name} rejects a ?format value outside the json|csv enum`, async () => {
      const p = `${path}?window=7d&format=xml`;
      const res = await handler(req(p), emptyEnv(), url(p));
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "format");
    });

    if (!skipDegradedD1) {
      test(`${name} degraded D1 still emits header-only CSV, marked fallback (not edge-cached)`, async () => {
        // A degraded D1 read yields fallback-marked rows; the CSV response must
        // still be a valid header-only CSV (never a 500) AND be tagged as fallback
        // so withEdgeCache never persists the degraded body.
        originalCaches = globalThis.caches;
        const cache = mockCaches();
        cache.install();
        const { env } = dbWith({ d1Error: new Error("d1 down") });
        const p = `${path}?window=7d&format=csv`;
        const res = await handler(req(p), env, url(p), ctx);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") || "", /text\/csv/);
        const text = await res.text();
        assert.equal(text.split("\r\n")[0], header);
        assert.deepEqual(cache.putKeys, []);
      });
    }
  }

  // #4909/#6013: chain-signers skips D1 entirely (extrinsics is retired), so a
  // "degraded D1" response never happens -- confirm the empty-stub CSV is a
  // normal, cacheable 200 instead of the fallback-marked path the other three
  // handlers exercise above.
  test("chain-signers never touches D1 and is edge-cacheable even when METAGRAPH_HEALTH_DB would error", async () => {
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const { env } = dbWith({ d1Error: new Error("d1 down") });
    const p = "/api/v1/chain/signers?window=7d&format=csv";
    const res = await handleChainSigners(req(p), env, url(p), ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/csv/);
    const text = await res.text();
    assert.equal(
      text.split("\r\n")[0],
      "signer,tx_count,total_fee_tao,total_tip_tao,last_tx_block",
    );
    await Promise.resolve();
    assert.deepEqual(cache.putKeys, [
      "https://edge-cache.metagraph.sh/analytics/2026-07-03.2/2026-06-18T00%3A00%3A00.000Z/chain-signers/api/v1/chain/signers?window=7d&format=csv",
    ]);
  });

  test("Accept: text/csv negotiates CSV without an explicit ?format", async () => {
    const { env } = dbWith({ rows: [] });
    const p = "/api/v1/chain/signers?window=7d";
    const res = await handleChainSigners(
      req(p, { headers: { accept: "text/csv" } }),
      env,
      url(p),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/csv/);
  });

  test("?format=json forces JSON even when Accept prefers text/csv", async () => {
    const { env } = dbWith({ rows: [] });
    const p = "/api/v1/chain/signers?window=7d&format=json";
    const res = await handleChainSigners(
      req(p, { headers: { accept: "text/csv" } }),
      env,
      url(p),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
  });

  test("chain-calls ?group_by=module_function adds the call_function column", async () => {
    const { env } = dbWith({ rows: [] });
    const p =
      "/api/v1/chain/calls?window=7d&group_by=module_function&format=csv";
    const res = await handleChainCalls(req(p), env, url(p));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(
      text.split("\r\n")[0],
      "call_module,call_function,count,share",
    );
  });

  test("chain-calls scoped by ?call_module still exports CSV", async () => {
    const { env } = dbWith({ rows: [] });
    const p =
      "/api/v1/chain/calls?window=7d&call_module=SubtensorModule&format=csv";
    const res = await handleChainCalls(req(p), env, url(p));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/csv/);
  });

  test("a healthy CSV response is edge-cached under a distinct format=csv key", async () => {
    // Proves the CSV path participates in the edge cache (so the degraded
    // not-cached assertion above is meaningful) and that CSV gets its own cache
    // entry, never colliding with the JSON envelope for the same URL.
    originalCaches = globalThis.caches;
    const cache = mockCaches();
    cache.install();
    const { env } = dbWith({ rows: [] });
    const p = "/api/v1/chain/activity?window=7d&format=csv";
    const res = await handleChainActivity(req(p), env, url(p), ctx);
    assert.equal(res.status, 200);
    assert.equal(cache.putKeys.length, 1);
    assert.match(cache.putKeys[0], /format=csv/);
  });
});

// #4832 gap-closure: these 4 handlers were D1-only with no Postgres tier at
// all until now. METAGRAPH_EXTRINSICS_SOURCE is reused (already "postgres"
// in production -- see wrangler.jsonc) since these read the same
// extrinsics/blocks tables the Tier 1a routes already serve from Postgres;
// no new flag-flip cycle needed. tryPostgresTier's own fallback contract is
// unit-tested in workers/postgres-tier.mjs's own tests, so these just prove
// the wiring: a Postgres hit is served as-is with D1 never queried, and a
// Postgres failure falls back to D1 with fallback-marking intact.
describe("chain analytics extrinsics-derived: postgres tier wiring", () => {
  const cases = [
    {
      name: "chain-activity",
      path: "/api/v1/chain/activity",
      handler: handleChainActivity,
      pgBody: {
        schema_version: 1,
        window: "7d",
        observed_at: null,
        day_count: 1,
        days: [
          {
            day: "2026-07-10",
            block_count: 5,
            extrinsic_count: 10,
            event_count: 20,
            successful_extrinsics: 9,
            success_rate: 0.9,
            unique_signers: 3,
          },
        ],
      },
    },
    {
      name: "chain-calls",
      path: "/api/v1/chain/calls",
      handler: handleChainCalls,
      pgBody: {
        schema_version: 1,
        window: "7d",
        group_by: "module",
        observed_at: null,
        total_extrinsics: 10,
        call_count: 1,
        calls: [
          {
            call_module: "SubtensorModule",
            call_function: null,
            count: 10,
            share: 1,
          },
        ],
      },
    },
    {
      name: "chain-signers",
      path: "/api/v1/chain/signers",
      handler: handleChainSigners,
      pgBody: {
        schema_version: 1,
        window: "7d",
        sort: "tx_count",
        observed_at: null,
        signer_count: 1,
        signers: [
          {
            signer: "5PgSigner",
            tx_count: 10,
            total_fee_tao: 1,
            total_tip_tao: 0,
            last_tx_block: 100,
          },
        ],
      },
    },
    {
      name: "chain-fees",
      path: "/api/v1/chain/fees",
      handler: handleChainFees,
      pgBody: {
        schema_version: 1,
        window: "7d",
        observed_at: null,
        day_count: 1,
        daily: [
          {
            day: "2026-07-10",
            extrinsic_count: 10,
            total_fee_tao: 1,
            avg_fee_tao: 0.1,
            median_fee_tao: 0.1,
            total_tip_tao: 0,
            avg_tip_tao: 0,
            median_tip_tao: 0,
          },
        ],
        top_fee_payers: [
          {
            signer: "5PgPayer",
            total_fee_tao: 1,
            total_tip_tao: 0,
            extrinsic_count: 10,
          },
        ],
      },
    },
  ];

  test("chain-fees charges the data-tier limiter before Postgres", async () => {
    let limiterCalls = 0;
    let dataApiCalls = 0;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_RATE_LIMITER = {
      limit: async ({ key }) => {
        limiterCalls += 1;
        assert.equal(key, "data:203.0.113.10");
        return { success: false };
      },
    };
    env.DATA_API = {
      fetch: async () => {
        dataApiCalls += 1;
        return Response.json({});
      },
    };

    const res = await handleChainFees(
      req("/api/v1/chain/fees?window=7d&call_module=Balances", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      env,
      url("/api/v1/chain/fees?window=7d&call_module=Balances"),
      ctx,
    );

    const body = await errorJson(res, 429);
    assert.equal(body.error.code, "data_rate_limited");
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(limiterCalls, 1);
    assert.equal(dataApiCalls, 0);
  });

  for (const { name, path, handler, pgBody } of cases) {
    test(`${name}: flag=postgres serves the DATA_API response, D1 never queried`, async () => {
      let d1Called = false;
      const { env } = dbWith({ rows: [] });
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = { fetch: async () => Response.json(pgBody) };
      env.METAGRAPH_HEALTH_DB.prepare = () => {
        d1Called = true;
        throw new Error(
          "D1 must not be queried when Postgres serves the request",
        );
      };
      const p = `${path}?window=7d`;
      const res = await handler(req(p), env, url(p), ctx);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data, pgBody);
      assert.equal(d1Called, false);
    });

    test(`${name}: flag=postgres falls back to D1 when DATA_API fails`, async () => {
      const { env } = dbWith({ rows: [] });
      env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
      env.DATA_API = {
        fetch: async () => {
          throw new Error("boom");
        },
      };
      const p = `${path}?window=7d`;
      const res = await handler(req(p), env, url(p), ctx);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.schema_version, 1);
    });
  }
});

// #4832 gap-closure: METAGRAPH_HEALTH_SOURCE is a NEW flag, deliberately
// left unset in wrangler.jsonc (see handleBulkHealthTrends' own header
// comment) -- these tests only prove the wiring, not a live flip.
describe("health analytics: postgres tier wiring", () => {
  test("handleBulkHealthTrends: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, windows: { "7d": {}, "30d": {} } }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const res = await handleBulkHealthTrends(
      req("/api/v1/health/trends"),
      env,
      url("/api/v1/health/trends"),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(d1Called, false);
  });

  test("handleBulkHealthTrends: flag=postgres falls back to D1 when DATA_API fails", async () => {
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const p = "/api/v1/health/trends";
    const res = await handleBulkHealthTrends(req(p), env, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
  });

  test("handleHealthTrends: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, windows: {} }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = `/api/v1/subnets/${NETUID}/health/trends`;
    const res = await handleHealthTrends(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, NETUID);
    assert.equal(d1Called, false);
  });

  test("handleHealthTrends: flag=postgres falls back to D1 when DATA_API fails", async () => {
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const p = `/api/v1/subnets/${NETUID}/health/trends`;
    const res = await handleHealthTrends(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
  });

  test("handleHealthPercentiles: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, surfaces: [] }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = `/api/v1/subnets/${NETUID}/health/percentiles?window=7d`;
    const res = await handleHealthPercentiles(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, NETUID);
    assert.equal(d1Called, false);
  });

  test("handleHealthPercentiles: flag=postgres falls back to D1 when DATA_API fails", async () => {
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const p = `/api/v1/subnets/${NETUID}/health/percentiles?window=7d`;
    const res = await handleHealthPercentiles(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
  });

  test("handleHealthIncidents: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, surfaces: [] }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = `/api/v1/subnets/${NETUID}/health/incidents?window=7d`;
    const res = await handleHealthIncidents(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, NETUID);
    assert.equal(d1Called, false);
  });

  test("handleHealthIncidents: flag=postgres falls back to D1 when DATA_API fails", async () => {
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const p = `/api/v1/subnets/${NETUID}/health/incidents?window=7d`;
    const res = await handleHealthIncidents(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
  });

  test("handleGlobalIncidents: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          summary: { incident_count: 0 },
          surfaces: [],
        }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = "/api/v1/incidents?window=7d";
    const res = await handleGlobalIncidents(req(p), env, url(p));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(d1Called, false);
  });

  test("handleGlobalIncidents: flag=postgres falls back to D1 when DATA_API fails", async () => {
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const p = "/api/v1/incidents?window=7d";
    const res = await handleGlobalIncidents(req(p), env, url(p));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
  });
});
