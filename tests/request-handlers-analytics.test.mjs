// Direct unit tests for workers/request-handlers/analytics.mjs (#1925).
// Imports every exported handler/helper and exercises the D1 read path,
// query-param guards, edge-cache contract, and schema-stable cold-store
// payloads without routing through workers/api.mjs.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  configureAnalytics,
  withEdgeCache,
  handleBulkHealthTrends,
  handleHealthTrends,
  handleHealthPercentiles,
  handleHealthIncidents,
  handleGlobalIncidents,
  handleChainCalls,
  handleChainSigners,
  handleChainTransfers,
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
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import {
  ANALYTICS_WINDOW_PARAM,
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
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
    return [
      {
        netuid: NETUID,
        day: "2026-06-24",
        date: "2026-06-24",
        total: 100,
        ok_count: 98,
        latency_samples: 96,
        p50: 120,
        p95: 400,
      },
      {
        netuid: NETUID,
        day: "2026-06-01",
        date: "2026-06-01",
        total: 50,
        ok_count: 45,
        latency_samples: 48,
        p50: 200,
        p95: 500,
      },
    ];
  }
  if (sql.includes("FROM extrinsics")) {
    if (sql.includes("COUNT(*) AS total") && !sql.includes("GROUP BY")) {
      return [{ total: 10 }];
    }
    if (sql.includes("GROUP BY signer")) {
      return [
        {
          signer: "5FHneW46xGXgs5mUive6eigkdRD2AYN6fy8616ckdp26RGGj",
          tx_count: 3,
          total_fee_tao: 1,
          total_tip_tao: 0,
          extrinsic_count: 3,
          last_tx_block: 100,
        },
      ];
    }
    if (sql.includes("GROUP BY day")) {
      return [
        {
          day: "2026-06-01",
          extrinsic_count: 5,
          total_fee_tao: 2,
          total_tip_tao: 0.5,
        },
      ];
    }
    if (sql.includes("GROUP BY call_module")) {
      return [{ call_module: "Balances", count: 4 }];
    }
    if (sql.includes("ROW_NUMBER() OVER")) {
      return [{ day: "2026-06-01", median_fee_tao: 0.1, median_tip_tao: 0.01 }];
    }
  }
  if (sql.includes("FROM account_events")) {
    if (sql.includes("GROUP BY hotkey")) {
      return [{ address: "5Ffrom", volume_tao: 10, transfer_count: 2 }];
    }
    if (sql.includes("GROUP BY coldkey")) {
      return [{ address: "5Fto", volume_tao: 8, transfer_count: 1 }];
    }
    if (sql.includes("COUNT(*) AS transfer_count")) {
      return [
        {
          transfer_count: 3,
          total_volume_tao: 18,
          unique_senders: 2,
          unique_receivers: 1,
        },
      ];
    }
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
  test("canonicalizes resolved window/limit/sort for chain signers", () => {
    const bare = url("/api/v1/chain/signers");
    const explicit = url(
      "/api/v1/chain/signers?window=7d&sort=tx_count&limit=50",
    );
    const key = canonicalAnalyticsCacheRoute(bare, {
      window: DEFAULT_ANALYTICS_WINDOW,
      extras: { limit: 50, sort: "tx_count" },
    });
    assert.equal(
      key,
      `/api/v1/chain/signers?window=${DEFAULT_ANALYTICS_WINDOW}&limit=50&sort=tx_count`,
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(explicit, {
        window: DEFAULT_ANALYTICS_WINDOW,
        extras: { limit: 50, sort: "tx_count" },
      }),
      key,
    );
  });

  test("includes optional call_module when scoped", () => {
    const requestUrl = url(
      "/api/v1/chain/signers?call_module=Balances&limit=10&window=30d&sort=total_fee_tao",
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(requestUrl, {
        window: "30d",
        extras: {
          limit: 10,
          sort: "total_fee_tao",
          call_module: "Balances",
        },
      }),
      "/api/v1/chain/signers?window=30d&limit=10&sort=total_fee_tao&call_module=Balances",
    );
  });

  test("includes resolved group_by and limit for chain calls", () => {
    const bare = url("/api/v1/chain/calls");
    const explicit = url(
      "/api/v1/chain/calls?window=7d&group_by=module&limit=50",
    );
    const key = canonicalAnalyticsCacheRoute(bare, {
      window: DEFAULT_ANALYTICS_WINDOW,
      extras: { group_by: "module", limit: 50 },
    });
    assert.equal(
      key,
      `/api/v1/chain/calls?window=${DEFAULT_ANALYTICS_WINDOW}&group_by=module&limit=50`,
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(explicit, {
        window: DEFAULT_ANALYTICS_WINDOW,
        extras: { group_by: "module", limit: 50 },
      }),
      key,
    );
  });

  test("includes call_module filter for scoped chain calls", () => {
    const requestUrl = url(
      "/api/v1/chain/calls?call_module=SubtensorModule&limit=10&group_by=module_function&window=30d",
    );

    assert.equal(
      canonicalAnalyticsCacheRoute(requestUrl, {
        window: "30d",
        extras: {
          group_by: "module_function",
          limit: 10,
          call_module: "SubtensorModule",
        },
      }),
      "/api/v1/chain/calls?window=30d&group_by=module_function&limit=10&call_module=SubtensorModule",
    );
  });

  test("canonicalizes default limit for chain transfers and fees", () => {
    assert.equal(
      canonicalAnalyticsCacheRoute(url("/api/v1/chain/transfers"), {
        window: DEFAULT_ANALYTICS_WINDOW,
        extras: { limit: 25 },
      }),
      `/api/v1/chain/transfers?window=${DEFAULT_ANALYTICS_WINDOW}&limit=25`,
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(url("/api/v1/chain/fees"), {
        window: DEFAULT_ANALYTICS_WINDOW,
        extras: { limit: 25 },
      }),
      `/api/v1/chain/fees?window=${DEFAULT_ANALYTICS_WINDOW}&limit=25`,
    );
  });
});

describe("chain analytics handlers", () => {
  test("handleChainSigners serves bare and scoped requests", async () => {
    const queries = [];
    const env = analyticsEnv(queries);
    const bare = await handleChainSigners(
      req("/api/v1/chain/signers"),
      env,
      url("/api/v1/chain/signers"),
      ctx,
    );
    await json(bare);
    const scoped = await handleChainSigners(
      req(
        "/api/v1/chain/signers?call_module=Balances&limit=10&sort=total_fee_tao",
      ),
      env,
      url(
        "/api/v1/chain/signers?call_module=Balances&limit=10&sort=total_fee_tao",
      ),
      ctx,
    );
    const body = await json(scoped);
    assert.equal(body.data.signers.length, 1);
    assert.ok(queries.some((q) => /GROUP BY signer/.test(q.sql)));
  });

  test("handleChainCalls, transfers, and fees return schema-stable payloads", async () => {
    const queries = [];
    const env = analyticsEnv(queries);
    const calls = await json(
      await handleChainCalls(
        req("/api/v1/chain/calls"),
        env,
        url("/api/v1/chain/calls"),
        ctx,
      ),
    );
    assert.equal(calls.data.schema_version, 1);
    const signers = await json(
      await handleChainTransfers(
        req("/api/v1/chain/transfers"),
        env,
        url("/api/v1/chain/transfers"),
        ctx,
      ),
    );
    assert.equal(signers.data.schema_version, 1);
    const fees = await json(
      await handleChainFees(
        req("/api/v1/chain/fees?call_module=Balances"),
        env,
        url("/api/v1/chain/fees?call_module=Balances"),
        ctx,
      ),
    );
    assert.equal(fees.data.schema_version, 1);
    assert.ok(queries.some((q) => /call_module = \?/.test(q.sql)));
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
