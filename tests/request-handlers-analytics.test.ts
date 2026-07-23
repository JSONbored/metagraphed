// Direct unit tests for workers/request-handlers/analytics.mjs (#1925).
// Imports every exported handler/helper and exercises the query-param
// guards, edge-cache contract, and schema-stable cold-store payloads
// without routing through workers/api.mjs.

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
  handleChainActivity,
  handleChainCalls,
  handleChainSigners,
  handleChainFees,
  validateQueryParams,
  analyticsWindow,
  markD1FallbackResponse,
  analyticsQueryError,
  canonicalAnalyticsCacheRoute,
  canonicalHealthWindowCachePath,
  handleChainStakeFlow,
  handleChainWeights,
  handleChainWeightSetters,
  handleChainServing,
} from "../workers/request-handlers/analytics.ts";
import { CHAIN_STAKE_FLOW_LIMIT_DEFAULT } from "../src/chain-stake-flow.ts";
import { CHAIN_WEIGHTS_LIMIT_DEFAULT } from "../src/chain-weights.ts";
import { CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT } from "../src/chain-weight-setters.ts";
import { CHAIN_SERVING_LIMIT_DEFAULT } from "../src/chain-serving.ts";
import { tryPostgresTier } from "../workers/postgres-tier.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import {
  ANALYTICS_WINDOW_PARAM,
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  DAY_MS,
} from "../workers/config.ts";
import { jsonBody, type AnyFn, type Row } from "./row-type.ts";

// This suite's env mocks are built once via dbWith()/analyticsEnv()/emptyEnv()
// below and then, in many test bodies, further poked with a `__healthMeta`
// back door (read by the readHealthMetaKv shim wired in via configureAnalytics
// just below) that real Env never declares. TestEnv is the real, strict Env
// (so every mock stays a valid `env: Env` handler argument) plus that one
// test-only escape hatch, plus the mock-only `METAGRAPH_HEALTH_DB` D1 handle
// dbWith()/analyticsEnv() always populate -- a vestige of the pre-D1-
// elimination mock shape (analytics.ts itself never reads this binding name;
// see its own "D1 fully eliminated" header comment), kept only so tests can
// still prove a Postgres-tier hit never falls through to a D1 read.
type TestEnv = Env & { __healthMeta?: unknown; METAGRAPH_HEALTH_DB: Row };

// `caches` is `declare const caches: CacheStorage` -- a module-scope const,
// not a `globalThis` property -- so stubbing/restoring it for a test needs
// this cast (matches workers/request-handlers/analytics.ts's own precedent).
const globalWithCaches = globalThis as unknown as { caches: Row | undefined };

configureAnalytics({
  readHealthMetaKv: async (env) => {
    const row = env as unknown as Row;
    if (typeof row.__healthMeta !== "undefined") return row.__healthMeta;
    if (env.METAGRAPH_CONTROL?.get) {
      return env.METAGRAPH_CONTROL.get("health:meta", { type: "json" });
    }
    return null;
  },
});

const NETUID = 7;
const LAST_RUN_AT = "2026-06-18T00:00:00.000Z";
const ctx = { waitUntil: (promise: Promise<unknown>) => promise };

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

function url(path: string): URL {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res: Response): Promise<Row> {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await jsonBody(res);
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res: Response, status = 400): Promise<Row> {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = await jsonBody(res);
  assert.equal(body.ok, false);
  return body;
}

function emptyEnv(): TestEnv {
  return {} as unknown as TestEnv;
}

// One row backs every shape the analytics SQL returns (shared ok-latency CTE,
// SLA aggregates, gap-island incidents, bulk daily uptime).
function rowsForSql(sql: string) {
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
}: {
  rows?: unknown[] | null;
  rowsFn?: (sql: string) => unknown[];
  d1Error?: unknown;
  captures?: { sql: string[]; params: unknown[][] } | null;
} = {}): { env: TestEnv; captures: { sql: string[]; params: unknown[][] } } {
  const cap: { sql: string[]; params: unknown[][] } = captures || {
    sql: [],
    params: [],
  };
  const record = (sql: string, params: unknown[]) => {
    cap.sql.push(sql);
    cap.params.push(params);
  };
  const resolveRows = (sql: string) => {
    if (rows !== null) return rows;
    return rowsFn(sql);
  };
  return {
    env: {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind(...params: unknown[]) {
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
        async get(key: string) {
          if (key === "health:meta") {
            return { last_run_at: LAST_RUN_AT };
          }
          return null;
        },
      },
    } as unknown as TestEnv,
    captures: cap,
  };
}

function analyticsEnv(
  queries: { sql: string; params: unknown[] }[],
  {
    lastRunAt = LAST_RUN_AT,
    d1Error = null,
    healthMeta = undefined,
  }: {
    lastRunAt?: string | null;
    d1Error?: unknown;
    healthMeta?: unknown;
  } = {},
): TestEnv {
  const env: Row = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
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
      async get(key: string) {
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
  return env as unknown as TestEnv;
}

function mockCaches() {
  const store = new Map<string, Response>();
  const putKeys: string[] = [];
  let matchCalls = 0;
  return {
    store,
    putKeys,
    get matchCalls() {
      return matchCalls;
    },
    install() {
      globalWithCaches.caches = {
        default: {
          async match(request: Request) {
            matchCalls += 1;
            const cached = store.get(request.url);
            return cached ? cached.clone() : undefined;
          },
          async put(request: Request, response: Response) {
            putKeys.push(request.url);
            store.set(request.url, response.clone());
          },
        },
      };
    },
  };
}

function expectedKey(keyParts: string, pathname: string, search = "") {
  return `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
    CONTRACT_VERSION,
  )}/${encodeURIComponent(LAST_RUN_AT)}/${keyParts}${pathname}${search}`;
}

let originalCaches: Row | undefined;
afterEach(() => {
  globalWithCaches.caches = originalCaches;
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
    const err = validateQueryParams(u, [])!;
    assert.equal(err.parameter, "bogus");
    assert.match(err.message, /not supported/);
  });

  test("rejects the first unsupported param when several are present", () => {
    const u = url("/x?alpha=1&beta=2");
    const err = validateQueryParams(u, ["window"])!;
    assert.equal(err.parameter, "alpha");
  });

  test("rejects a duplicate allowed param", () => {
    const u = url("/x?window=7d&window=30d");
    const err = validateQueryParams(u, ["window"])!;
    assert.equal(err.parameter, "window");
    assert.match(err.message, /only be provided once/);
  });

  test("rejects duplicate unsupported params on the first occurrence in iteration", () => {
    const u = url("/x?foo=1&foo=2");
    const err = validateQueryParams(u, [])!;
    assert.equal(err.parameter, "foo");
  });

  test("allows empty-string values for allowed params", () => {
    const u = url("/x?window=");
    assert.equal(validateQueryParams(u, ["window"]), null);
  });

  test("rejects params not in the allow-list even when value is empty", () => {
    const u = url("/x?cursor=");
    const err = validateQueryParams(u, ["window"])!;
    assert.equal(err.parameter, "cursor");
  });

  test("handles params with special characters in the key", () => {
    const u = url("/x?weird%5Bkey%5D=1");
    const err = validateQueryParams(u, [])!;
    assert.equal(err.parameter, "weird[key]");
  });

  test("accepts window-only allow-list for percentiles-style routes", () => {
    const u = url(`/x?${ANALYTICS_WINDOW_PARAM}=30d`);
    assert.equal(validateQueryParams(u, [ANALYTICS_WINDOW_PARAM]), null);
  });

  test("rejects netuid query param on routes that take none", () => {
    const u = url("/x?netuid=7");
    const err = validateQueryParams(u, [])!;
    assert.equal(err.parameter, "netuid");
  });
});

// #6356: end-to-end proof through the handlers themselves -- a bare request and
// an explicit request for the handler's own documented default must land on ONE
// edge-cache entry. Previously only `window` was resolved into the key, so these
// two hashed apart while serving byte-identical bodies.
describe("analytics edge-cache keys fold in resolved defaults (#6356)", () => {
  let originalCaches: Row | undefined;

  afterEach(() => {
    if (originalCaches === undefined) globalWithCaches.caches = undefined;
    else globalWithCaches.caches = originalCaches;
    originalCaches = undefined;
  });

  const ROUTES = [
    {
      name: "chain/stake-flow",
      handler: handleChainStakeFlow,
      path: "/api/v1/chain/stake-flow",
      limit: CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
    },
    {
      name: "chain/weights",
      handler: handleChainWeights,
      path: "/api/v1/chain/weights",
      limit: CHAIN_WEIGHTS_LIMIT_DEFAULT,
    },
    {
      name: "chain/weights/setters",
      handler: handleChainWeightSetters,
      path: "/api/v1/chain/weights/setters",
      limit: CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
    },
    {
      name: "chain/serving",
      handler: handleChainServing,
      path: "/api/v1/chain/serving",
      limit: CHAIN_SERVING_LIMIT_DEFAULT,
    },
  ];

  async function cacheKeyFor(handler: AnyFn, path: string) {
    const cache = mockCaches();
    cache.install();
    const { env } = dbWith({ rows: [] });
    const res = await handler(req(path), env, url(path), ctx);
    assert.equal(res.status, 200);
    await Promise.resolve();
    assert.equal(cache.putKeys.length, 1, `${path} must seed one cache entry`);
    return cache.putKeys[0];
  }

  for (const route of ROUTES) {
    test(`${route.name}: a bare request and ?limit=<default> share one entry`, async () => {
      originalCaches = globalWithCaches.caches;
      const bare = await cacheKeyFor(route.handler, route.path);
      const explicit = await cacheKeyFor(
        route.handler,
        `${route.path}?limit=${route.limit}`,
      );
      assert.equal(bare, explicit);
      // The resolved default is actually in the key, not merely absent from both.
      assert.match(bare, new RegExp(`limit=${route.limit}(&|$)`));
      assert.match(bare, new RegExp(`window=${DEFAULT_ANALYTICS_WINDOW}(&|$)`));
    });
  }

  // The CSV variant keys separately (same aggregation, different serialization),
  // and must fold in the resolved default exactly the same way.
  for (const route of ROUTES) {
    test(`${route.name}: the CSV key also carries the resolved default`, async () => {
      originalCaches = globalWithCaches.caches;
      const bare = await cacheKeyFor(route.handler, `${route.path}?format=csv`);
      const explicit = await cacheKeyFor(
        route.handler,
        `${route.path}?limit=${route.limit}&format=csv`,
      );
      assert.equal(bare, explicit);
      assert.match(bare, new RegExp(`limit=${route.limit}(&|$)`));
      assert.match(bare, /format=csv$/);
      // JSON and CSV must not collide on one entry.
      const json = await cacheKeyFor(route.handler, route.path);
      assert.notEqual(bare, json);
    });
  }

  test("an explicit non-default limit still keys separately", async () => {
    originalCaches = globalWithCaches.caches;
    const bare = await cacheKeyFor(handleChainServing, "/api/v1/chain/serving");
    const wider = await cacheKeyFor(
      handleChainServing,
      "/api/v1/chain/serving?limit=5",
    );
    assert.notEqual(bare, wider);
  });
});

describe("canonicalAnalyticsCacheRoute", () => {
  // The helper now takes each param's already-resolved value (#6356) rather than
  // re-deriving it from the raw URL, so the key reflects what the handler
  // actually served. Call sites read via url.searchParams.get(), which decodes,
  // so percent-encoding still normalizes -- exercised below.
  const signersResolved = (requestUrl: URL, overrides = {}) => ({
    window: "30d",
    limit: 10,
    call_module: requestUrl.searchParams.get("call_module"),
    sort: "total_fee_tao",
    ...overrides,
  });

  test("normalizes decoded query values for cache keys", () => {
    const plain = url(
      "/api/v1/chain/signers?call_module=Balances&limit=10&window=30d&sort=total_fee_tao",
    );
    const encoded = url(
      "/api/v1/chain/signers?limit=10&call_module=%42alances&sort=total_fee_tao&window=30d",
    );

    assert.equal(
      canonicalAnalyticsCacheRoute(plain, signersResolved(plain)),
      "/api/v1/chain/signers?window=30d&limit=10&call_module=Balances&sort=total_fee_tao",
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(encoded, signersResolved(encoded)),
      canonicalAnalyticsCacheRoute(plain, signersResolved(plain)),
    );
  });

  test("normalizes a missing window to the default window", () => {
    const bare = url("/api/v1/chain/transfers?limit=25");
    const explicit = url(`/api/v1/chain/transfers?window=7d&limit=25`);
    assert.equal(
      canonicalAnalyticsCacheRoute(bare, { limit: 25 }),
      `/api/v1/chain/transfers?window=${DEFAULT_ANALYTICS_WINDOW}&limit=25`,
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(explicit, {
        window: DEFAULT_ANALYTICS_WINDOW,
        limit: 25,
      }),
      canonicalAnalyticsCacheRoute(bare, { limit: 25 }),
    );
  });

  test("includes the chain calls grouping and module filter in canonical order", () => {
    const requestUrl = url(
      "/api/v1/chain/calls?call_module=SubtensorModule&limit=10&group_by=module_function&window=30d",
    );

    assert.equal(
      canonicalAnalyticsCacheRoute(requestUrl, {
        window: "30d",
        group_by: "module_function",
        limit: 10,
        call_module: requestUrl.searchParams.get("call_module"),
      }),
      "/api/v1/chain/calls?window=30d&group_by=module_function&limit=10&call_module=SubtensorModule",
    );
  });

  // #6356: only `window` used to be defaulted into the key. Every other param
  // entered it solely when the caller spelled it out, so a bare request and an
  // explicit request for the handler's OWN documented default produced identical
  // bodies under two different cache entries -- exactly the duplicate
  // aggregation withEdgeCache exists to avoid.
  test("a bare request and an explicit default limit share one cache entry", () => {
    const bare = url("/api/v1/chain/signers");
    const explicit = url("/api/v1/chain/signers?limit=50");
    // 50 is handleChainSigners' documented default: both requests serve it.
    const resolved = { window: DEFAULT_ANALYTICS_WINDOW, limit: 50 };
    assert.equal(
      canonicalAnalyticsCacheRoute(bare, resolved),
      canonicalAnalyticsCacheRoute(explicit, resolved),
    );
    assert.equal(
      canonicalAnalyticsCacheRoute(bare, resolved),
      `/api/v1/chain/signers?window=${DEFAULT_ANALYTICS_WINDOW}&limit=50`,
    );
  });

  test("a defaulted sort / group_by is keyed too, not just window", () => {
    const bare = url("/api/v1/chain/calls");
    assert.equal(
      canonicalAnalyticsCacheRoute(bare, {
        window: DEFAULT_ANALYTICS_WINDOW,
        group_by: "module",
        limit: 50,
      }),
      `/api/v1/chain/calls?window=${DEFAULT_ANALYTICS_WINDOW}&group_by=module&limit=50`,
    );
  });

  test("a genuinely absent optional filter stays out of the key", () => {
    // call_module has no default: unset must not become an empty-string param,
    // or every bare request would key differently from itself.
    const bare = url("/api/v1/chain/signers");
    assert.equal(
      canonicalAnalyticsCacheRoute(bare, {
        window: DEFAULT_ANALYTICS_WINDOW,
        limit: 50,
        call_module: bare.searchParams.get("call_module"),
        sort: "tx_count",
      }),
      `/api/v1/chain/signers?window=${DEFAULT_ANALYTICS_WINDOW}&limit=50&sort=tx_count`,
    );
  });

  test("a real filter still separates entries (the fix is not over-broad)", () => {
    const filtered = url("/api/v1/chain/signers?call_module=Balances");
    const bare = url("/api/v1/chain/signers");
    assert.notEqual(
      canonicalAnalyticsCacheRoute(filtered, {
        window: DEFAULT_ANALYTICS_WINDOW,
        limit: 50,
        call_module: filtered.searchParams.get("call_module"),
      }),
      canonicalAnalyticsCacheRoute(bare, {
        window: DEFAULT_ANALYTICS_WINDOW,
        limit: 50,
        call_module: bare.searchParams.get("call_module"),
      }),
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
    const out = analyticsWindow(url("/x")) as unknown as Row;
    assert.equal(out.label, "7d");
    assert.equal(out.days, ANALYTICS_WINDOWS["7d"]);
    assert.equal(out.error, undefined);
  });

  test("accepts explicit 7d window", () => {
    const out = analyticsWindow(url("/x?window=7d")) as unknown as Row;
    assert.equal(out.label, "7d");
    assert.equal(out.days, 7);
  });

  test("accepts explicit 30d window", () => {
    const out = analyticsWindow(url("/x?window=30d")) as unknown as Row;
    assert.equal(out.label, "30d");
    assert.equal(out.days, 30);
  });

  test("rejects an invalid window value", () => {
    const out = analyticsWindow(url("/x?window=bogus")) as unknown as Row;
    assert.ok(out.error);
    assert.equal(out.error.parameter, ANALYTICS_WINDOW_PARAM);
    assert.match(out.error.message, /not a valid window/);
    assert.match(out.error.message, /7d/);
    assert.match(out.error.message, /30d/);
  });

  test("rejects unsupported extra query params", () => {
    const out = analyticsWindow(url("/x?window=7d&limit=10")) as unknown as Row;
    assert.ok(out.error);
    assert.equal(out.error.parameter, "limit");
  });

  test("rejects duplicate window params", () => {
    const out = analyticsWindow(
      url("/x?window=7d&window=30d"),
    ) as unknown as Row;
    assert.ok(out.error);
    assert.equal(out.error.parameter, "window");
  });

  test("rejects empty window string as invalid", () => {
    const out = analyticsWindow(url("/x?window=")) as unknown as Row;
    assert.ok(out.error);
    assert.equal(out.error.parameter, ANALYTICS_WINDOW_PARAM);
  });

  test("rejects numeric window without suffix", () => {
    const out = analyticsWindow(url("/x?window=7")) as unknown as Row;
    assert.ok(out.error);
  });

  test("rejects 90d window (not in ANALYTICS_WINDOWS)", () => {
    const out = analyticsWindow(url("/x?window=90d")) as unknown as Row;
    assert.ok(out.error);
    assert.match(out.error.message, /90d/);
  });

  test("rejects case-sensitive window labels", () => {
    const out = analyticsWindow(url("/x?window=7D")) as unknown as Row;
    assert.ok(out.error);
  });

  test("returns days matching the configured ANALYTICS_WINDOWS map", () => {
    for (const [label, days] of Object.entries(ANALYTICS_WINDOWS)) {
      const out = analyticsWindow(url(`/x?window=${label}`)) as unknown as Row;
      assert.equal(out.label, label);
      assert.equal(out.days, days);
    }
  });

  test("does not include error field on success", () => {
    const out = analyticsWindow(url("/x?window=30d")) as unknown as Row;
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
    const res = analyticsQueryError(validationError!);
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "cursor");
  });
});

// d1All / hasD1FallbackRows / d1Runner were deleted (2026-07-17, D1 fully
// eliminated) -- every handler now goes straight to a schema-stable empty
// payload on a Postgres-tier miss, never a live D1 read, so the D1 read
// path + its fallback-row bookkeeping had zero remaining callers.

describe("markD1FallbackResponse", () => {
  test("markD1FallbackResponse tags a Response object", () => {
    const response = new Response("{}");
    const tagged = markD1FallbackResponse(response);
    assert.equal(tagged, response);
  });
});

// ---- C) withEdgeCache -------------------------------------------------------

describe("withEdgeCache", () => {
  test("MISS: runs buildResponse and caches 200 when snapshot stamp is warm", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    // Loose Row[] (not the stricter {sql,params}[] the other edge-cache tests
    // use) because this test also pushes a bare `{handler: "build"}` marker
    // below to record that the buildResponse callback ran, alongside the
    // {sql,params} entries analyticsEnv's own D1 mock pushes.
    const queries: Row[] = [];
    const env = analyticsEnv(
      queries as unknown as Parameters<typeof analyticsEnv>[0],
    );
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
    originalCaches = globalWithCaches.caches;
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
    const body = await jsonBody(res);
    assert.equal(body.cached, true);
  });

  test("304: honours If-None-Match against cached etag", async () => {
    originalCaches = globalWithCaches.caches;
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
    originalCaches = globalWithCaches.caches;
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
    originalCaches = globalWithCaches.caches;
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
    originalCaches = globalWithCaches.caches;
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

  // The d1FallbackGeneration-based sibling of this test was deleted
  // (2026-07-17, D1 fully eliminated) -- the same "a fallback fired mid-
  // buildResponse -> never cache" property is now covered below via the
  // still-active Postgres-tier generation counter.
  test("does not cache when Postgres-tier fallback generation changes during buildResponse", async () => {
    originalCaches = globalWithCaches.caches;
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
          { METAGRAPH_BLOCKS_SOURCE: "postgres" } as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
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
    originalCaches = globalWithCaches.caches;
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
    originalCaches = globalWithCaches.caches;
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
    globalWithCaches.caches = undefined;
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

  test("meta block carries bulk trends artifact path", async () => {
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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

  test("edge cache MISS then HIT avoids a second DATA_API call", async () => {
    // D1 fully eliminated (2026-07-17): a Postgres-tier miss now falls straight
    // through to an empty payload that's ALWAYS marked a D1 fallback, so it can
    // never be cached (mirrors withEdgeCache's own D1_FALLBACK_RESPONSES guard).
    // The only path that still gets cached is a Postgres-tier HIT, so that's
    // what this now exercises -- was a D1-mock MISS/HIT pair.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    let dataApiCalls = 0;
    env.DATA_API = {
      fetch: async () => {
        dataApiCalls += 1;
        return Response.json({
          schema_version: 1,
          windows: { "7d": {}, "30d": {} },
        });
      },
    } as unknown as Fetcher;
    const path = "/api/v1/health/trends";

    await handleBulkHealthTrends(req(path), env, url(path), ctx);
    await Promise.resolve();
    assert.equal(dataApiCalls, 1, "the cold MISS must call DATA_API once");

    await handleBulkHealthTrends(req(path), env, url(path), ctx);
    assert.equal(
      dataApiCalls,
      1,
      "the warm HIT must be served from cache, not DATA_API",
    );
  });

  test("accepts request with no query string", async () => {
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
    const env = { ...emptyEnv(), __healthMeta: { last_run_at: null } };
    const body = await json(
      await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath)),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.deepEqual(body.data.windows["7d"].surfaces, []);
    assert.deepEqual(body.data.windows["30d"].surfaces, []);
  });

  test("meta references per-subnet trends artifact", async () => {
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
    const { env } = dbWith({ d1Error: new Error("fail") });
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthTrends(req(trendsPath), env, NETUID, url(trendsPath)),
    );
    assert.deepEqual(body.data.windows["7d"].surfaces, []);
  });

  test("edge cache HIT avoids D1 on second request", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: { sql: string; params: unknown[] }[] = [];
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
    globalWithCaches.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthPercentiles(req(base), env, NETUID, url(base)),
    );
    assert.equal(body.data.window, "7d");
  });

  test("cold D1 returns empty surfaces", async () => {
    globalWithCaches.caches = undefined;
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

  test("meta uses percentiles artifact path", async () => {
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    // D1 fully eliminated (2026-07-17): a Postgres-tier miss is ALWAYS marked a
    // D1 fallback now (no live D1 read left to distinguish "had rows" from
    // "cold"), so it can never be cached -- only a Postgres-tier HIT is.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, surfaces: [] }),
    } as unknown as Fetcher;
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
    globalWithCaches.caches = undefined;
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

  test("meta references incidents artifact path", async () => {
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const body = await json(
      await handleHealthIncidents(req(base), env, NETUID, url(base)),
    );
    assert.equal(body.data.window, "7d");
  });

  test("edge cache HIT skips D1 on repeat request", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: { sql: string; params: unknown[] }[] = [];
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
      req(`${base}?window=7d&bogus=1`),
      emptyEnv(),
      url(`${base}?window=7d&bogus=1`),
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
    // handleGlobalIncidents (unlike its sibling health handlers) never wraps
    // itself in withEdgeCache, so it takes no ctx param -- confirm it still
    // resolves cleanly when called without one.
    const { env } = dbWith();
    env.__healthMeta = { last_run_at: LAST_RUN_AT };
    const res = await handleGlobalIncidents(
      req(`${base}?window=7d`),
      env,
      url(`${base}?window=7d`),
    );
    assert.equal(res.status, 200);
  });

  // #6571: the window-scoped ledger now pages/sorts/filters like the sibling
  // endpoint-incidents route. Non-empty surfaces come from the Postgres tier (the
  // D1 fallback ledger is always empty now), so these stub DATA_API with a payload
  // in the exact shape formatGlobalIncidents emits.
  function withSurfaces(surfaces: Row[]) {
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "7d",
          observed_at: LAST_RUN_AT,
          source: "live-cron-prober",
          summary: {
            incident_count: surfaces.length,
            affected_surface_count: surfaces.length,
          },
          surfaces,
        }),
    } as unknown as Fetcher;
    return env;
  }

  const SURFACE_ROWS = [
    { netuid: 7, surface_id: "a", incident_count: 1, downtime_ms: 300 },
    { netuid: 7, surface_id: "b", incident_count: 3, downtime_ms: 100 },
    { netuid: 12, surface_id: "c", incident_count: 2, downtime_ms: 900 },
  ];

  test("paginates the surfaces ledger and advertises a Link header", async () => {
    const p = `${base}?window=7d&limit=1`;
    const res = await handleGlobalIncidents(
      req(p),
      withSurfaces(SURFACE_ROWS),
      url(p),
    );
    const body = await json(res);
    assert.equal(body.data.surfaces.length, 1);
    assert.equal(body.meta.pagination.collection, "surfaces");
    assert.equal(body.meta.pagination.total, 3);
    assert.equal(body.meta.pagination.limit, 1);
    assert.equal(body.meta.pagination.next_cursor, 1);
    const link = res.headers.get("link")!;
    assert.ok(link.includes('rel="next"'));
    // window is pinned onto every page link, never dropped back to the 7d default.
    assert.ok(link.includes("window=7d"));
  });

  test("sort + order reorder the surfaces list", async () => {
    const p = `${base}?window=7d&sort=downtime_ms&order=desc`;
    const body = await json(
      await handleGlobalIncidents(req(p), withSurfaces(SURFACE_ROWS), url(p)),
    );
    assert.deepEqual(
      body.data.surfaces.map((s: Row) => s.surface_id),
      ["c", "a", "b"],
    );
    assert.equal(body.meta.pagination.sort, "downtime_ms");
    assert.equal(body.meta.pagination.order, "desc");
  });

  test("netuid filter narrows the surfaces list", async () => {
    const p = `${base}?window=7d&netuid=12`;
    const body = await json(
      await handleGlobalIncidents(req(p), withSurfaces(SURFACE_ROWS), url(p)),
    );
    assert.deepEqual(
      body.data.surfaces.map((s: Row) => s.netuid),
      [12],
    );
    assert.equal(body.meta.pagination.total, 1);
  });

  test("rejects an out-of-range limit like the sibling list routes", async () => {
    const p = `${base}?window=7d&limit=abc`;
    const body = await errorJson(
      await handleGlobalIncidents(req(p), withSurfaces(SURFACE_ROWS), url(p)),
    );
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "limit");
  });

  test("unpaged request omits the Link header", async () => {
    const p = `${base}?window=7d`;
    const res = await handleGlobalIncidents(
      req(p),
      withSurfaces(SURFACE_ROWS),
      url(p),
    );
    await json(res);
    assert.equal(res.headers.get("link"), null);
  });
});

// ---- Cross-handler invariants ------------------------------------------------

describe("analytics handler invariants", () => {
  test("all successful handler responses include ok: true envelope", async () => {
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    globalWithCaches.caches = undefined;
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
    originalCaches = globalWithCaches.caches;
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
      // #4909/#6013: extrinsics'/blocks' D1 write path is retired, so
      // chain-activity no longer queries D1 at all (D1 fully eliminated,
      // 2026-07-16) -- there is no "degraded D1" scenario to mark as
      // fallback anymore.
      skipDegradedD1: true,
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
      // #4909/#6013: extrinsics' D1 write path is retired, so chain-fees no
      // longer queries D1 at all (D1 fully eliminated, 2026-07-16) -- there
      // is no "degraded D1" scenario to mark as fallback anymore.
      skipDegradedD1: true,
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
        originalCaches = globalWithCaches.caches;
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
    originalCaches = globalWithCaches.caches;
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
    // #6356: the key now carries the handler's RESOLVED limit/sort, not just the
    // params the caller happened to spell out -- so this bare request shares an
    // entry with an explicit ?limit=50&sort=tx_count instead of fragmenting.
    assert.deepEqual(cache.putKeys, [
      "https://edge-cache.metagraph.sh/analytics/2026-07-03.2/2026-06-18T00%3A00%3A00.000Z/chain-signers/api/v1/chain/signers?window=7d&limit=50&sort=tx_count&format=csv",
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
    originalCaches = globalWithCaches.caches;
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
// unit-tested in workers/postgres-tier.ts's own tests, so these just prove
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
    } as unknown as Fetcher;

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
      env.DATA_API = {
        fetch: async () => Response.json(pgBody),
      } as unknown as Fetcher;
      env.METAGRAPH_HEALTH_DB.prepare = () => {
        d1Called = true;
        throw new Error(
          "D1 must not be queried when Postgres serves the request",
        );
      };
      const p = `${path}?window=7d`;
      const res = await handler(req(p), env, url(p), ctx);
      assert.equal(res.status, 200);
      const body = await jsonBody(res);
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
      } as unknown as Fetcher;
      const p = `${path}?window=7d`;
      const res = await handler(req(p), env, url(p), ctx);
      assert.equal(res.status, 200);
      const body = await jsonBody(res);
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
    } as unknown as Fetcher;
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
    const body = await jsonBody(res);
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
    } as unknown as Fetcher;
    const p = "/api/v1/health/trends";
    const res = await handleBulkHealthTrends(req(p), env, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.data.schema_version, 1);
  });

  test("handleHealthTrends: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, windows: {} }),
    } as unknown as Fetcher;
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = `/api/v1/subnets/${NETUID}/health/trends`;
    const res = await handleHealthTrends(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
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
    } as unknown as Fetcher;
    const p = `/api/v1/subnets/${NETUID}/health/trends`;
    const res = await handleHealthTrends(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.data.schema_version, 1);
  });

  test("handleHealthPercentiles: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, surfaces: [] }),
    } as unknown as Fetcher;
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = `/api/v1/subnets/${NETUID}/health/percentiles?window=7d`;
    const res = await handleHealthPercentiles(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
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
    } as unknown as Fetcher;
    const p = `/api/v1/subnets/${NETUID}/health/percentiles?window=7d`;
    const res = await handleHealthPercentiles(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.data.schema_version, 1);
  });

  test("handleHealthIncidents: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const { env } = dbWith({ rows: [] });
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, netuid: NETUID, surfaces: [] }),
    } as unknown as Fetcher;
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = `/api/v1/subnets/${NETUID}/health/incidents?window=7d`;
    const res = await handleHealthIncidents(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
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
    } as unknown as Fetcher;
    const p = `/api/v1/subnets/${NETUID}/health/incidents?window=7d`;
    const res = await handleHealthIncidents(req(p), env, NETUID, url(p), ctx);
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
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
    } as unknown as Fetcher;
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const p = "/api/v1/incidents?window=7d";
    const res = await handleGlobalIncidents(req(p), env, url(p));
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
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
    } as unknown as Fetcher;
    const p = "/api/v1/incidents?window=7d";
    const res = await handleGlobalIncidents(req(p), env, url(p));
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.data.schema_version, 1);
  });
});
