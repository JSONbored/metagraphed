import assert from "node:assert/strict";
import { archiveEnv } from "./helpers/cold-tier-env.ts";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The analytics store is Postgres now (#10179), reached through
// `new Client(...)` inside src/read-store.ts. A route test cannot inject into
// that -- the caller is `handleRequest(request, env, ctx)` -- so the module is
// the seam; see tests/helpers/pg-mock.ts for why, and for why the controller is
// built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { handleRequest } from "../workers/api.ts";
import { envelopeResponse } from "../workers/responses.ts";
import { EXPOSED_RESPONSE_HEADERS_VALUE } from "../workers/http.ts";
import {
  DEGRADED_HEADER,
  DEGRADED_TIER_UNAVAILABLE,
  markDataApiTierFallbackResponse,
  withEdgeCache,
} from "../workers/request-handlers/analytics.ts";
import {
  handleBlocksSummary,
  handleSubnetStakeFlow,
} from "../workers/request-handlers/entities.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import {
  KV_EXPLORER_DIRECTORIES_CURRENT,
  explorerDirectoriesSnapshotKey,
} from "../src/kv-keys.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";
import { resetObservedThroughCache } from "../src/lakehouse-observed-through.ts";
import { resetSurfacesMemo } from "../src/revenue-load.ts";
import { mockEnv, type Row } from "./row-type.ts";

// Edge-cache coverage for the store-backed analytics routes (audit #6). These four
// handlers (per-subnet health trends / percentiles / incidents + the bulk-trends
// route) used to re-run a full-window D1 aggregation on EVERY request; they are
// now wrapped in withEdgeCache, which mirrors the existing live-overlay
// collection cache (Cloudflare Cache API keyed on contract_version + the cron
// snapshot's last_run_at). These tests assert the cache is correct AND
// transparent: same body, keyed on what changes the data, never caching errors.

const LAST_RUN_AT = "2026-06-18T00:00:00.000Z";

// One row backs every shape the analytics SQL returns (the shared ok-latency CTE
// carries both uptime and latency stats; incidents reuse the same row).
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

// Local artifact env + a query-recording store + a KV control plane that serves
// the snapshot stamp. `queries` records every {sql, params} so a test can assert
// whether the store was touched at all (the whole point of the cache).
//
// The recorded `sql` is POSTGRES text -- `$1, $2`, not `?` -- because that is
// what reaches the driver now. rowsForSql matches on table and CTE names, which
// the rewrite leaves alone, so it needs no change; a suite asserting a
// placeholder here would need `/= \$\d/`.
//
// ARMING IS SIDE-EFFECTING: there is one `pg` double per FILE, so building an
// env installs this env's recorder and answers over whatever the previous one
// left. Each test builds its env before it issues a request, which is what
// keeps that safe.
function analyticsEnv(
  queries: Row[],
  {
    lastRunAt = LAST_RUN_AT,
    storeError = null,
  }: { lastRunAt?: string | null; storeError?: Error | null } = {},
) {
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  // Answered from inside the subscription, which the double calls BEFORE it
  // consults `rows`/`answers` -- the only way one double can answer each
  // statement differently. `failNext` is re-armed per query for the same
  // reason: it is consumed by the query it fails, and the error cases here
  // issue several.
  pg.control.onQuery = (q) => {
    queries.push({ sql: q.text, params: q.values });
    if (storeError) {
      pg.control.failNext = storeError;
      return;
    }
    pg.control.rows = rowsForSql(q.text);
  };
  return {
    ...createLocalArtifactEnv(),
    ...pgMockEnv(),
    METAGRAPH_CONTROL: {
      async get(key: string) {
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
// existing edge-cache test stub in worker-runtime.test.ts).
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
      } as unknown as Row;
    },
  };
}

// D1 fully eliminated (2026-07-17): percentiles/incidents/trends/bulk-trends/
// #10190: these routes' tier flag reads "d1"/"retired" and is absent from
// FORWARDABLE_TIER_FLAGS, so the DATA_API call this used to count never happened
// in production. The upstream the edge cache actually protects is the STORE, so
// that is what is counted now -- through the pg module double's onQuery hook.
//
// The MISS/HIT invariants are unchanged and still meaningful: a store-served
// payload with real rows is cacheable (isFallback false), an empty one is not,
// which is the same distinction the tier hit/miss used to draw.
function storeUpstreamEnv(
  calls: unknown[],
  {
    // Enough of a row for every reader that shares this helper: the incidents
    // and trajectory routes format timestamps out of it, and a row without one
    // fails as `Invalid time value` rather than as an empty result.
    rows = [
      {
        netuid: 7,
        surface: "api",
        samples: 10,
        healthy_samples: 10,
        day: LAST_RUN_AT.slice(0, 10),
        // formatTrajectory keys its points on snapshot_date and shifts dates off
        // it -- a row without one throws `Invalid time value` rather than
        // yielding an empty trajectory.
        snapshot_date: LAST_RUN_AT.slice(0, 10),
        completeness_score: 1,
        observed_at: Date.parse(LAST_RUN_AT),
        last_checked: Date.parse(LAST_RUN_AT),
        first_seen: Date.parse(LAST_RUN_AT),
        last_seen: Date.parse(LAST_RUN_AT),
      },
    ] as Row[],
    lastRunAt = LAST_RUN_AT as string | null,
  } = {},
) {
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  pg.control.rows = rows;
  pg.control.onQuery = () => calls.push(1);
  return {
    ...createLocalArtifactEnv(),
    ...pgMockEnv(),
    METAGRAPH_CONTROL: {
      async get(key: string) {
        if (key === "health:meta") {
          return lastRunAt ? { last_run_at: lastRunAt } : null;
        }
        return null;
      },
    },
  };
}

// Rebuild the exact cache key the worker computes, so the invariant assertions
// don't hard-code a brittle literal and survive a contract-version bump.
function expectedKey(keyParts: string, pathname: string, search = "") {
  return `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
    CONTRACT_VERSION,
  )}/${encodeURIComponent(LAST_RUN_AT)}/${keyParts}${pathname}${search}`;
}

const ctx = { waitUntil: (promise: Promise<unknown>) => promise };

// The real Workers `caches` global is declared as `declare const caches:
// CacheStorage` (ambient, not a `globalThis` property), so tests that
// install/restore a stub must go through a cast -- mirrors the same pattern
// in workers/request-handlers/analytics.ts's own handler code.
const globalWithCaches = globalThis as unknown as { caches: Row | undefined };

let originalCaches: Row | undefined;
afterEach(() => {
  globalWithCaches.caches = originalCaches;
});

// This file COUNTS artifact reads, so it has to own every memo that can hide
// one. The decode watermark is module-level and reset only between test FILES,
// so whichever test in this file resolved it first paid its R2 GET and the rest
// read a warm memo -- making an absolute read count depend on test ORDER rather
// than on the behaviour under test. Resetting per test makes the counts mean
// what they say. (Found when `observed_through` started stamping the tier's
// horizon on every account_events-derived response, which resolves it.)
beforeEach(() => {
  resetDecodeWatermarkCache();
  resetObservedThroughCache();
  // The revenue-coverage fold memoizes the surfaces artifact for five minutes,
  // and registerModuleStateReset fires between test FILES, not between tests.
  resetSurfacesMemo();
});

describe("analytics edge cache", () => {
  test("INVARIANT: cache key includes contract_version + snapshot stamp + netuid + window", async () => {
    // D1 fully eliminated (2026-07-17): percentiles always marks a Postgres-tier
    // MISS a store fallback (never cached), so only a Postgres-tier HIT exercises
    // this key-shape invariant now.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);

    // Per-subnet percentiles (netuid + window both vary the key).
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d",
      ),
      mockEnv(env) as unknown as Env,
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

  // #5554: HEAD probes on the analytics routes must be normalized through the
  // GET cache key so a HEAD-probe burst is served from the warm cache instead
  // of re-running the aggregation every call (matching the 12 sibling routes).
  // Before the fix these routes passed the raw HEAD request + a zero-arg
  // builder to withEdgeCache, so `cache` resolved to null and every HEAD
  // bypassed the cache and re-ran the tier call.
  test("REGRESSION #5554: a HEAD request hits the warm edge cache without re-querying the Postgres tier", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);
    const target =
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d";

    // Warm the cache with a GET — a cold cache must call DATA_API and store one entry.
    const getRes = await handleRequest(
      new Request(target),
      env as unknown as Env,
      ctx,
    );
    assert.equal(getRes.status, 200);
    assert.equal(cache.putKeys.length, 1);
    const callsAfterGet = calls.length;
    assert.ok(callsAfterGet > 0, "cold GET should call the Postgres tier");

    // A HEAD probe against the warm entry must be served from cache: no new
    // DATA_API call, no re-put, a bodyless 200.
    const headRes = await handleRequest(
      new Request(target, { method: "HEAD" }),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), "", "HEAD carries no body");
    assert.equal(
      calls.length,
      callsAfterGet,
      "HEAD cache hit must not re-run the Postgres tier call",
    );
    assert.equal(cache.putKeys.length, 1, "HEAD hit must not re-put");
  });

  test("a conditional GET against a warm cache entry honors If-None-Match with a 304", async () => {
    // withEdgeCache's cache-hit path re-checks If-None-Match against the
    // cached response's own weak ETag (mirrors envelopeResponse's conditional
    // handling) so a polling agent still gets a 304 from a warm cache, not a
    // fresh 200 body every poll.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);
    const target =
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d";

    const warm = await handleRequest(
      new Request(target),
      env as unknown as Env,
      ctx,
    );
    assert.equal(warm.status, 200);
    const etag = warm.headers.get("etag");
    assert.ok(etag, "cached response advertises an etag");
    const callsAfterWarm = calls.length;

    const conditional = await handleRequest(
      new Request(target, { headers: { "if-none-match": etag } }),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    assert.equal(
      calls.length,
      callsAfterWarm,
      "a cache-hit 304 must not re-run the Postgres tier call",
    );

    // A non-matching validator still gets the full cached 200 body.
    const mismatch = await handleRequest(
      new Request(target, { headers: { "if-none-match": '"stale"' } }),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(mismatch.status, 200);
  });

  test("every answer says which side of the cache produced it", async () => {
    // #10312: a `caches.default` hit returns the STORED response verbatim, so
    // before this a caller could not tell a 120ms cache hit from a 15s
    // lakehouse read -- they differ only in a duration nobody records.
    // `scripts/check-operation-latency.ts` was scoring the difference as the
    // operation getting faster: measured 2026-08-19, /api/v1/blocks/{ref}
    // drew [6034, 93, 91] and was reported as a fixed read.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = storeUpstreamEnv([]);
    const target =
      "https://api.metagraph.sh/api/v1/subnets/9/health/percentiles?window=30d";

    const miss = await handleRequest(
      new Request(target),
      env as unknown as Env,
      ctx,
    );
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get("x-metagraph-cache"), "miss");
    assert.ok(await miss.text(), "a miss still carries its body");

    const hit = await handleRequest(
      new Request(target),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-metagraph-cache"), "hit");

    // The 304 path is stamped too: it is served off the cached entry, and a
    // polling agent that only ever gets 304s would otherwise never see one.
    const conditional = await handleRequest(
      new Request(target, {
        headers: { "if-none-match": hit.headers.get("etag")! },
      }),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get("x-metagraph-cache"), "hit");

    // And the label reaches a browser, or it is a header nobody can read.
    assert.ok(
      EXPOSED_RESPONSE_HEADERS_VALUE.includes("x-metagraph-cache"),
      "the cache label is exposed cross-origin",
    );
  });

  test("INVARIANT: a different window and a different netuid key separately", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);

    for (const url of [
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d",
      "https://api.metagraph.sh/api/v1/subnets/9/health/percentiles?window=7d",
    ]) {
      await handleRequest(new Request(url), env as unknown as Env, ctx);
      await Promise.resolve();
    }
    // Three distinct (netuid, window) combinations → three distinct entries.
    assert.equal(cache.store.size, 3);
    assert.equal(cache.putKeys.length, 3);
    assert.equal(new Set(cache.putKeys).size, 3);
  });

  test("concentration history canonicalizes equivalent window query strings before caching", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);
    const variants = [
      "https://api.metagraph.sh/api/v1/subnets/7/concentration/history?window=90d",
      "https://api.metagraph.sh/api/v1/subnets/7/concentration/history?window=90d&",
      "https://api.metagraph.sh/api/v1/subnets/7/concentration/history?window=90d&&",
    ];

    const first = await handleRequest(
      new Request(variants[0]),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    for (const variant of variants.slice(1)) {
      const hit = await handleRequest(
        new Request(variant),
        env as unknown as Env,
        ctx,
      );
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);
    const variants = [
      "https://api.metagraph.sh/api/v1/subnets/7/performance/history?window=90d",
      "https://api.metagraph.sh/api/v1/subnets/7/performance/history?window=90d&",
      "https://api.metagraph.sh/api/v1/subnets/7/performance/history?window=90d&&",
    ];

    const first = await handleRequest(
      new Request(variants[0]),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    for (const variant of variants.slice(1)) {
      const hit = await handleRequest(
        new Request(variant),
        env as unknown as Env,
        ctx,
      );
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);
    const variants = [
      "https://api.metagraph.sh/api/v1/subnets/7/yield/history?window=90d",
      "https://api.metagraph.sh/api/v1/subnets/7/yield/history?window=90d&",
      "https://api.metagraph.sh/api/v1/subnets/7/yield/history?window=90d&&",
    ];

    const first = await handleRequest(
      new Request(variants[0]),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    for (const variant of variants.slice(1)) {
      const hit = await handleRequest(
        new Request(variant),
        env as unknown as Env,
        ctx,
      );
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    // No ?window — should resolve to the 30d default and cache at ?window=30d.
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/turnover"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    // Explicit ?window=30d is the canonical form — must be a cache HIT (no new store read).
    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/turnover?window=30d",
      ),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    // #10190: the tier this counted is retired; the subnet stake-flow
    // PROJECTION is the upstream the cache protects, so its reads are what the
    // MISS/HIT counts below measure.
    const archive = archiveEnv({
      schema_version: 1,
      windows: {
        "30d": {
          rows: [
            {
              netuid: 7,
              event_kind: "StakeAdded",
              total_tao: 0,
              events: 0,
              newest_observed: LAST_RUN_AT,
            },
          ],
        },
      },
    });
    const env = { ...analyticsEnv([]), ...archive };

    // No ?window — should resolve to the 30d default and cache at ?window=30d.
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/stake-flow"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const callsAfterMiss = archive.keys.length;
    // TWO: the stake-flow artifact, and the decode watermark behind
    // `observed_through` -- this route is account_events-derived, so its meta
    // states how far that tier has observed. Pinned exactly rather than
    // loosened, so a THIRD read still fails here; the beforeEach above is what
    // makes the number independent of test order.
    assert.equal(callsAfterMiss, 2);

    // Explicit ?window=30d is the canonical form — must be a cache HIT (no DATA_API).
    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=30d",
      ),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      archive.keys.length,
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

  // #11422: the owner-cut route reads account_events over a 30-day window --
  // the same read its /stake-flow sibling makes -- and was the only one of them
  // dispatched without this wrapper. Measured against production 2026-08-18,
  // /subnets/64/stake-flow answered in 0.28s on every request while
  // /subnets/64/owner-cut paid 2.4-7.9s of R2 SQL on every one.
  test("subnet owner-cut routes through the worker and caches on the bare path", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/owner-cut"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.deepEqual(cache.putKeys, [
      expectedKey("subnet-owner-cut", "/api/v1/subnets/7/owner-cut"),
    ]);
    assert.equal(cache.store.size, 1);
  });

  test("a warm owner-cut entry cannot launder an unknown parameter into a 200", async () => {
    // The key is the PATHNAME alone, because this route takes no query
    // parameters at all -- #10925 removed the `?window=` it could not honour,
    // and ATTRIBUTION_WINDOW_DAYS is a fixed property of the surface. Keying on
    // `${pathname}${search}` instead would let any link carrying a tracking
    // parameter turn a 0.28s hit into a multi-second R2 SQL miss, unboundedly.
    //
    // That collapse is only safe because parameter validation runs BEFORE the
    // cache lookup: an unknown parameter still 400s against a warm entry rather
    // than being answered from it. If that order ever inverts, this route would
    // start returning 200 to requests it is supposed to reject -- so assert the
    // rejection, not just the entry count.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    const miss = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/owner-cut"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(miss.status, 200);
    assert.equal(cache.store.size, 1);

    const rejected = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/owner-cut?utm_source=x",
      ),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(rejected.status, 400);
    assert.equal(
      cache.store.size,
      1,
      "a rejected request must not seed a second entry",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey("subnet-owner-cut", "/api/v1/subnets/7/owner-cut"),
    ]);
  });

  test("chain revenue-coverage caches under the canonical window", async () => {
    // A whole-network fold -- 129 subnets joined from the economics blob, the
    // observation table and the surfaces artifact -- that ran on every request.
    // Measured against production 2026-08-18 it answered in 0.69s and 1.10s on
    // two consecutive requests, i.e. it was not caching at all.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/revenue-coverage"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(cache.putKeys, [
      expectedKey(
        "chain-revenue-coverage",
        "/api/v1/chain/revenue-coverage",
        "?window=1d",
      ),
    ]);

    // The omitted window and its explicit default are the SAME answer, so they
    // must share the slot rather than folding 129 subnets a second time.
    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/revenue-coverage?window=1d",
      ),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(cache.store.size, 1);
  });

  test("subnet weights routes through the worker and caches at the default window", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetWeights, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/weights"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetServing, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/serving"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetPrometheus, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/prometheus"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetStakeMoves, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/stake-moves"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetStakeTransfers, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/stake-transfers"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetRegistrations, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/registrations"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetAxonRemovals, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/axon-removals"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);

    // No ?window — the worker dispatches to handleSubnetDeregistrations, which resolves the
    // 7d default and caches under the canonical ?window=7d key.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/deregistrations"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    // No ?window — resolves to the 7d default and caches at ?window=7d.
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/activity"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    // Explicit ?window=7d is the canonical form — must be a cache HIT (no new store read).
    const hit = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/activity?window=7d"),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    for (const url of [
      "https://api.metagraph.sh/api/v1/chain/activity?window=7d",
      "https://api.metagraph.sh/api/v1/chain/activity?window=30d",
    ]) {
      await handleRequest(new Request(url), env as unknown as Env, ctx);
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    // Explicit ?window=30d is the canonical form — cache MISS, populates.
    const first = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/turnover?window=30d",
      ),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    // Omitted window resolves to the same 30d key — must be a HIT (no D1).
    const hit = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/turnover"),
      mockEnv(env) as unknown as Env,
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

  test("HIT: a pre-populated cache serves the cached body WITHOUT re-calling the Postgres tier", async () => {
    // D1 fully eliminated (2026-07-17): incidents always marks a Postgres-tier
    // MISS a store fallback (never cached), so only a Postgres-tier HIT can prove
    // the cached body is served without a second upstream call.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);
    const url =
      "https://api.metagraph.sh/api/v1/subnets/7/health/incidents?window=7d";

    // First request is a MISS: it calls the Postgres tier and populates the cache.
    const first = await handleRequest(
      new Request(url),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    const firstBody = await first.text();
    assert.equal(first.status, 200);
    assert.ok(calls.length > 0, "the cold MISS must call the Postgres tier");

    // Second request is a HIT: served from cache, DATA_API untouched.
    const callCountAfterMiss = calls.length;
    const second = await handleRequest(
      new Request(url),
      env as unknown as Env,
      ctx,
    );
    assert.equal(second.status, 200);
    assert.equal(
      await second.text(),
      firstBody,
      "the cached body is byte-identical",
    );
    assert.equal(
      calls.length,
      callCountAfterMiss,
      "a cache HIT must not issue any Postgres-tier call",
    );
  });

  test("HIT: a warm cache honours conditional requests with a 304", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);
    const url = "https://api.metagraph.sh/api/v1/health/trends";

    const first = await handleRequest(
      new Request(url),
      env as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    const etag = first.headers.get("etag");
    assert.equal(first.status, 200);
    const queryCountAfterMiss = queries.length;

    const conditional = await handleRequest(
      new Request(url, { headers: { "if-none-match": etag } }),
      mockEnv(env) as unknown as Env,
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

  test("MISS: an empty cache calls the Postgres tier once and issues a cache.put via waitUntil", async () => {
    // D1 fully eliminated (2026-07-17): bulk-trends always marks a
    // Postgres-tier MISS a store fallback (never cached), so only a Postgres-tier
    // HIT still schedules a cache write.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);

    let putAt: Promise<unknown> | null = null;
    const putCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        putAt = promise;
        return promise;
      },
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/health/trends"),
      mockEnv(env) as unknown as Env,
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
    assert.equal(cached!.status, 200);
    assert.equal(calls.length, 1, "the MISS must call the Postgres tier once");
  });

  test("NO-CACHE-ON-ERROR: a 400 (bad window) is never cached", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=bogus",
      ),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries, { lastRunAt: null });

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/incidents?window=7d",
      ),
      mockEnv(env) as unknown as Env,
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
    // This isolates the WeakSet response marker from the independent store fallback
    // generation guard: a handler must mark the awaited Response object, not the
    // Promise that produces it, or withEdgeCache cannot recognize the fallback.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = new Request("https://api.metagraph.sh/api/v1/test");

    const res = await withEdgeCache(
      request,
      ctx,
      mockEnv(env),
      "unit",
      async () => {
        const response = await envelopeResponse(
          request,
          {
            data: { degraded: true },
            meta: { generated_at: LAST_RUN_AT },
          },
          "short",
        );
        return markDataApiTierFallbackResponse(response);
      },
    );
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
  // *Promise* from envelopeResponse into markDataApiTierFallbackResponse. withEdgeCache
  // then saw the awaited Response (a different object) and cached the stub.
  test("NO-CACHE-ON-ERROR: handleSubnetStakeFlow stub is marked and not edge-cached (#6012)", async () => {
    originalCaches = globalWithCaches.caches;
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
      mockEnv(env),
      "subnet-stake-flow",
      () => handleSubnetStakeFlow(request, env as unknown as Env, 7, routeUrl),
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv([]);
    const request = new Request(
      "https://api.metagraph.sh/api/v1/blocks/summary",
    );
    const routeUrl = new URL(request.url);

    const res = await withEdgeCache(
      request,
      ctx,
      mockEnv(env),
      "blocks-summary",
      () => handleBlocksSummary(request, env as unknown as Env, routeUrl),
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
    originalCaches = globalWithCaches.caches;
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
      mockEnv(env),
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
      mockEnv(env),
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const dataApiMethods: string[] = [];
    const env = {
      ...analyticsEnv([]),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        async fetch(request: Request) {
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

    const first = await handleRequest(request, env as unknown as Env, ctx);
    await Promise.resolve();
    const second = await handleRequest(request, env as unknown as Env, ctx);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(await first.text(), "");
    assert.equal(await second.text(), "");
    assert.deepEqual(dataApiMethods, ["GET"]);
    assert.equal(cache.matchCalls, 2);
  });

  test("/api/v1/validators/operators caches on the completed neuron pass", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const paths: string[] = [];
    const stamp = Date.parse("2026-08-29T00:00:00.000Z");
    const directory = {
      schema_version: 1,
      captured_at: "2026-08-29T00:00:00.000Z",
      block_number: 8_950_000,
      validator_count: 0,
      operator_count: 0,
      operators: [],
    };
    const materialization = {
      schema_version: 1,
      captured_at: stamp,
      validators: directory,
      accounts: {
        schema_version: 1,
        captured_at: directory.captured_at,
        block_number: directory.block_number,
        account_count: 0,
        limit: 20,
        priced_registered_stake_tao: 0,
        rankings: { stake: [], emission: [], reach: [] },
      },
    };
    const env = {
      ...analyticsEnv([]),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      METAGRAPH_CONTROL: {
        async get(key: string) {
          if (key === KV_EXPLORER_DIRECTORIES_CURRENT) {
            return { schema_version: 1, captured_at: stamp };
          }
          if (key === explorerDirectoriesSnapshotKey(stamp)) {
            return materialization;
          }
          return null;
        },
      },
      DATA_API: {
        async fetch(request: Request) {
          const pathname = new URL(request.url).pathname;
          paths.push(pathname);
          return pathname === "/api/v1/internal/neurons-snapshot-stamp"
            ? Response.json({ captured_at: stamp })
            : Response.json(directory);
        },
      },
    };
    const request = new Request(
      "https://api.metagraph.sh/api/v1/validators/operators",
    );

    const first = await handleRequest(request, env as unknown as Env, ctx);
    await Promise.resolve();
    const second = await handleRequest(request, env as unknown as Env, ctx);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual((await first.json()).data, directory);
    assert.deepEqual((await second.json()).data, directory);
    assert.deepEqual(paths, []);
    assert.deepEqual(cache.putKeys, [
      `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
        CONTRACT_VERSION,
      )}/${stamp}/validator-operator-directory/api/v1/validators/operators`,
    ]);
    assert.equal(cache.matchCalls, 2);
  });

  test("/api/v1/accounts/directory caches on the completed neuron pass", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const paths: string[] = [];
    const stamp = Date.parse("2026-08-29T00:00:00.000Z");
    const directory = {
      schema_version: 1,
      captured_at: "2026-08-29T00:00:00.000Z",
      block_number: 8_950_000,
      account_count: 0,
      limit: 20,
      priced_registered_stake_tao: 0,
      rankings: { stake: [], emission: [], reach: [] },
    };
    const materialization = {
      schema_version: 1,
      captured_at: stamp,
      accounts: directory,
      validators: {
        schema_version: 1,
        captured_at: directory.captured_at,
        block_number: directory.block_number,
        validator_count: 0,
        operator_count: 0,
        operators: [],
      },
    };
    const env = {
      ...analyticsEnv([]),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      METAGRAPH_CONTROL: {
        async get(key: string) {
          if (key === KV_EXPLORER_DIRECTORIES_CURRENT) {
            return { schema_version: 1, captured_at: stamp };
          }
          if (key === explorerDirectoriesSnapshotKey(stamp)) {
            return materialization;
          }
          return null;
        },
      },
      DATA_API: {
        async fetch(request: Request) {
          const pathname = new URL(request.url).pathname;
          paths.push(pathname);
          return pathname === "/api/v1/internal/neurons-snapshot-stamp"
            ? Response.json({ captured_at: stamp })
            : Response.json(directory);
        },
      },
    };
    const request = new Request(
      "https://api.metagraph.sh/api/v1/accounts/directory",
    );

    const first = await handleRequest(request, env as unknown as Env, ctx);
    await Promise.resolve();
    const second = await handleRequest(request, env as unknown as Env, ctx);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual((await first.json()).data, directory);
    assert.deepEqual((await second.json()).data, directory);
    assert.deepEqual(paths, []);
    assert.deepEqual(cache.putKeys, [
      `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
        CONTRACT_VERSION,
      )}/${stamp}/account-holder-directory/api/v1/accounts/directory`,
    ]);
    assert.equal(cache.matchCalls, 2);
  });

  test("NO-CACHE-ON-ERROR: a store failure with a snapshot stamp is served but not cached", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries, {
      storeError: new Error("store unavailable"),
    });

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      ),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "a store-fallback response must not poison the edge cache",
    );
    assert.equal(cache.store.size, 0);
  });

  test("NO-CACHE-ON-ERROR: store fallback on the five additional edge-cached routes is not cached", async () => {
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
    originalCaches = globalWithCaches.caches;
    for (const r of routes) {
      const cache = mockCaches();
      cache.install();
      const queries: Row[] = [];
      const env = analyticsEnv(queries, {
        storeError: new Error("store unavailable"),
      });
      const url = `https://api.metagraph.sh${r.path}${r.search}`;

      const res = await handleRequest(
        new Request(url),
        env as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      assert.equal(res.status, 200, `${r.path}: fallback is still 200`);
      assert.deepEqual(
        cache.putKeys,
        [],
        `${r.path}: a store fallback must not poison the edge cache`,
      );
      assert.equal(cache.store.size, 0, `${r.path}: cache stays empty`);
    }
  });

  test("a store-served leaderboards payload IS cached", async () => {
    // The other half of the resurrection (#9146): before it, every
    // leaderboards response was barred from the edge cache unconditionally
    // because its operational boards were always empty. With a reachable store
    // the response is a real read and must cache like any other.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/registry/leaderboards"),
      mockEnv(analyticsEnv(queries)) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.ok(
      queries.some((q) => String(q.sql).includes("FROM surface_status")),
      "the leaderboards route must actually read the store",
    );
    assert.equal(
      cache.putKeys.length,
      1,
      "a store-served leaderboards payload is cacheable",
    );
  });

  test("NO-CACHE-ON-ERROR: an unbound store with a warm snapshot stamp is not cached", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    // No HYPERDRIVE at all -- readStore answers `undefined`, so every board is
    // cold. Deliberately NOT pgMockEnv: "unbound" is the case under test.
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key: string) {
          return key === "health:meta" ? { last_run_at: LAST_RUN_AT } : null;
        },
      },
    };

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/registry/leaderboards"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(
      cache.putKeys,
      [],
      "an unbound-store cold fallback must not seed the edge cache",
    );
    assert.equal(cache.store.size, 0);
  });

  test("transparency: the cached body equals the uncached body for the same handler", async () => {
    // Same request, once with the cache stubbed and once without — the served
    // body must be byte-identical (the cache adds nothing to the payload).
    originalCaches = globalWithCaches.caches;
    const url =
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d";

    // Uncached: no globalWithCaches.caches -> withEdgeCache falls through to
    // the store.
    globalWithCaches.caches = undefined;
    const uncached = await handleRequest(
      new Request(url),
      analyticsEnv([]) as unknown as Env,
      ctx,
    );
    const uncachedBody = await uncached.text();

    // Cached MISS path.
    const cache = mockCaches();
    cache.install();
    const cachedMiss = await handleRequest(
      new Request(url),
      analyticsEnv([]) as unknown as Env,
      ctx,
    );
    const cachedBody = await cachedMiss.text();

    assert.equal(cachedBody, uncachedBody);
  });

  test("subnet-history ?window variants share a single cache entry (canonical key)", async () => {
    const queries: Row[] = [];
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/history";

    // First request with explicit default window — caches under ?window=30d.
    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=30d`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    const queriesAfterFirst = queries.length;

    // Trailing-amp variant must be a cache HIT (same canonical key).
    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=30d&`),
      mockEnv(env) as unknown as Env,
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
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "no ?window hits cache of ?window=30d",
    );
  });

  test("economics-trends ?window variants share a single cache entry (canonical key)", async () => {
    const queries: Row[] = [];
    const cache = mockCaches();
    cache.install();
    const env = analyticsEnv(queries);
    const base = "/api/v1/economics/trends";

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=30d`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    const queriesAfterFirst = queries.length;

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "no ?window hits cache of ?window=30d",
    );
  });

  test("health percentiles: bare path populates cache; explicit ?window=7d is a HIT", async () => {
    // D1 fully eliminated (2026-07-17): a Postgres-tier MISS is always marked a
    // store fallback (never cached), so this canonical-key invariant only survives
    // on a Postgres-tier HIT.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);
    const base = "/api/v1/subnets/7/health/percentiles";

    const miss = await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(miss.status, 200);
    const callsAfterMiss = calls.length;

    const hit = await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      calls.length,
      callsAfterMiss,
      "explicit ?window=7d must be a cache HIT after bare request",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey("percentiles", base, "?window=7d"),
    ]);
  });

  test("health percentiles: explicit ?window=7d populates cache; bare path is a HIT", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/health/percentiles";

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    const queriesAfterFirst = queries.length;

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "bare path must be a cache HIT after explicit ?window=7d",
    );
  });

  test("health incidents: bare path populates cache; explicit ?window=7d is a HIT", async () => {
    // D1 fully eliminated (2026-07-17): a Postgres-tier MISS is always marked a
    // store fallback (never cached), so this canonical-key invariant only survives
    // on a Postgres-tier HIT.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const calls: unknown[] = [];
    const env = storeUpstreamEnv(calls);
    const base = "/api/v1/subnets/7/health/incidents";

    const miss = await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(miss.status, 200);
    const callsAfterMiss = calls.length;

    const hit = await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(hit.status, 200);
    assert.equal(
      calls.length,
      callsAfterMiss,
      "explicit ?window=7d must be a cache HIT after bare request",
    );
    assert.deepEqual(cache.putKeys, [
      expectedKey("incidents", base, "?window=7d"),
    ]);
  });

  test("health incidents: explicit ?window=7d populates cache; bare path is a HIT", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);
    const base = "/api/v1/subnets/7/health/incidents";

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}?window=7d`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    const queriesAfterFirst = queries.length;

    await handleRequest(
      new Request(`https://api.metagraph.sh${base}`),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    assert.equal(
      queries.length,
      queriesAfterFirst,
      "bare path must be a cache HIT after explicit ?window=7d",
    );
  });

  test("the 3 additional deterministic routes are now edge-cached (MISS→put under their key, HIT→no further Postgres-tier call)", async () => {
    // These routes (global incidents, per-subnet trajectory, per-subnet uptime)
    // were edgeCache=0 — they re-ran their D1 aggregation on every request. Now
    // wrapped in withEdgeCache at the call site, keyed on the same
    // contract_version + last_run_at + pathname + search. D1 fully eliminated
    // (2026-07-17): a Postgres-tier MISS is always marked a store fallback (never
    // cached), so only a Postgres-tier HIT still gets cached here.
    //
    // The 4th route this test used to cover, registry leaderboards, never had
    // Postgres-tier wiring to begin with (its health/rpc/growth/reliability
    // boards are permanently empty now) and handleLeaderboards unconditionally
    // marks its response a store fallback -- it is categorically never
    // edge-cacheable anymore, covered instead by "NO-CACHE-ON-ERROR: D1
    // fallback on the five additional edge-cached routes is not cached" below.
    const routes = [
      {
        keyParts: "global-incidents",
        path: "/api/v1/incidents",
        search: "?window=7d",
        flag: "METAGRAPH_HEALTH_SOURCE",
      },
      {
        keyParts: "trajectory",
        path: "/api/v1/subnets/7/trajectory",
        search: "",
        // NO TIER (#10190): METAGRAPH_SUBNET_SNAPSHOTS_SOURCE is retired and
        // absent from FORWARDABLE_TIER_FLAGS, so this route is cacheable on a
        // LIVE STORE hit rather than a tier hit -- which is what it has actually
        // been doing. `store: true` gives it the pg mock plus a Hyperdrive
        // binding, since handleTrajectory marks an unbound read a fallback and a
        // fallback is deliberately never cached.
        store: true,
      },
      {
        keyParts: "uptime",
        path: "/api/v1/subnets/7/uptime",
        search: "?window=90d",
        flag: "METAGRAPH_HEALTH_SOURCE",
      },
    ];
    originalCaches = globalWithCaches.caches;
    for (const r of routes) {
      const cache = mockCaches();
      cache.install();
      const calls: unknown[] = [];
      const env = storeUpstreamEnv(calls);
      const url = `https://api.metagraph.sh${r.path}${r.search}`;

      // MISS: calls the Postgres tier and caches under the route's key.
      const miss = await handleRequest(
        new Request(url),
        env as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      assert.equal(miss.status, 200, `${r.keyParts}: MISS is 200`);
      assert.ok(
        cache.putKeys.includes(expectedKey(r.keyParts, r.path, r.search)),
        `${r.keyParts}: cached under its expected key`,
      );
      const callsAfterMiss = calls.length;
      const matchesAfterMiss = cache.matchCalls;

      // HIT: served from cache. For the tier routes that means no further
      // DATA_API call; for the store route there is no tier to count, so the
      // claim is the one that still means something -- the cache answered.
      const hit = await handleRequest(
        new Request(url),
        env as unknown as Env,
        ctx,
      );
      assert.equal(hit.status, 200, `${r.keyParts}: HIT is 200`);
      assert.equal(
        calls.length,
        callsAfterMiss,
        `${r.keyParts}: a HIT issues no further upstream call`,
      );
      assert.ok(
        cache.matchCalls > matchesAfterMiss,
        `${r.keyParts}: the HIT went through the cache`,
      );
    }
  });

  test("subnet movers CSV requests use a distinct cache key", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/movers?sort=emission",
        { headers: { accept: "text/csv" } },
      ),
      mockEnv(env) as unknown as Env,
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
// workers/request-handlers/analytics.ts. Every one of them read a D1 table
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    let neuronCapturedAt = 1_700_000_000_000;
    // A REACHABLE store that would answer a captured_at-keyed stamp query if
    // anything still asked one. No such query appearing across both passes
    // below is part of the regression proof (#4909 moved the stamp off this
    // signal), and it only proves anything because the store IS bound here --
    // an unbound one would answer nothing whatever the routes asked.
    const env = {
      ...createLocalArtifactEnv(),
      ...pgMockEnv(),
      METAGRAPH_CONTROL: {
        async get(key: string) {
          return key === "health:meta" ? { last_run_at: LAST_RUN_AT } : null;
        },
      },
    };
    pg.control.queries.length = 0;
    pg.control.failNext = null;
    pg.control.onQuery = (q) => {
      queries.push({ sql: q.text, params: q.values });
      pg.control.rows = [{ captured_at: neuronCapturedAt }];
    };

    for (const { path } of FORMERLY_NEURONS_TIER_SUBNET_ROUTES) {
      await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env as unknown as Env,
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
        env as unknown as Env,
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
    assert.deepEqual(
      queries.filter((q) => String(q.sql).includes("captured_at")),
      [],
      "the captured_at stamp query is gone entirely (#4909, #5358)",
    );
  });

  test("a NEW health-cron last_run_at DOES bust the cache for all 5 formerly-neurons-tier per-subnet routes", async () => {
    for (const { keyParts, path } of FORMERLY_NEURONS_TIER_SUBNET_ROUTES) {
      originalCaches = globalWithCaches.caches;
      const cache = mockCaches();
      cache.install();
      const url = `https://api.metagraph.sh${path}`;

      await handleRequest(
        new Request(url),
        analyticsEnv([], { lastRunAt: LAST_RUN_AT }) as unknown as Env,
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
        analyticsEnv([], { lastRunAt: NEW_LAST_RUN_AT }) as unknown as Env,
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

      globalWithCaches.caches = originalCaches;
    }
  });

  test("global validators canonicalizes equivalent query variants before caching, with ZERO D1 queries on the HIT", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/validators?limit=1"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();
    assert.equal(first.status, 200);
    const queriesAfterMiss = queries.length;

    const hit = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/validators?limit=01&sort=subnet_count",
      ),
      mockEnv(env) as unknown as Env,
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
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const queries: Row[] = [];
    const env = analyticsEnv(queries);

    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/validators?bogus=1"),
      mockEnv(env) as unknown as Env,
      ctx,
    );
    await Promise.resolve();

    assert.equal(res.status, 400);
    assert.equal(queries.length, 0, "invalid queries must not touch D1");
    assert.deepEqual(cache.putKeys, []);
    assert.equal(cache.store.size, 0);
  });

  test("health percentiles still bust on health last_run_at (unaffected sibling route)", async () => {
    // D1 fully eliminated (2026-07-17): a Postgres-tier MISS is always marked a
    // store fallback (never cached), so only a Postgres-tier HIT still seeds a
    // cache entry keyed on the shared health-cron last_run_at stamp.
    originalCaches = globalWithCaches.caches;
    const cache = mockCaches();
    cache.install();
    const env = storeUpstreamEnv([]);

    await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=7d",
      ),
      mockEnv(env) as unknown as Env,
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

// #9110: a data-tier miss returns a schema-stable EMPTY payload. Until this
// header existed, that was indistinguishable from a measured zero -- observed
// live, /api/v1/chain/calls?window=30d served `total_extrinsics: 0` in the same
// minute ?window=7d served 1,347,135, and 5,118,674 on the next attempt.
//
// Both directions matter. A degraded response that is not labelled is the bug.
// A healthy response that IS labelled is a false alarm that trains consumers to
// ignore the header, which is the same bug one step later.
describe("degraded-tier labelling (#9110)", () => {
  test("a tier miss is labelled on every analytics route that can degrade", async () => {
    // No DATA_API bound, tier flags on -> tryDataApiTier degrades on each.
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "data-api",
      METAGRAPH_HEALTH_SOURCE: "data-api",
    } as unknown as Env;
    const routes = [
      "/api/v1/chain/calls?window=30d",
      "/api/v1/chain/signers?window=7d",
      // Back in this list, and this time for a reason that holds at the
      // DEPLOYED flag value rather than only under the forced one above.
      //
      // It was here originally because of an inline `=== "postgres"` tier
      // branch, which #10186 deleted as dead -- and removing the route from
      // this sweep then exposed that an empty chain-fees payload had been
      // going out UNLABELLED in production for months, since the labelled path
      // only ever ran inside tryDataApiTier and a "retired" flag never
      // reaches it. #10189 gave the projection tier's own decline the same
      // label, so the route degrades honestly again.
      "/api/v1/chain/fees?window=7d",
      "/api/v1/chain/transfers?window=7d",
      "/api/v1/chain/activity?window=7d",
      "/api/v1/chain/stake-flow?window=7d",
      "/api/v1/chain/weights?window=7d",
      "/api/v1/chain/registrations?window=7d",
      "/api/v1/health/trends",
    ];
    const unlabelled: string[] = [];
    for (const route of routes) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${route}`),
        env,
        {},
      );
      assert.equal(res.status, 200, `${route}: expected a 200 empty payload`);
      if (res.headers.get(DEGRADED_HEADER) !== DEGRADED_TIER_UNAVAILABLE) {
        unlabelled.push(route);
      }
    }
    assert.deepEqual(
      unlabelled,
      [],
      `these served an empty payload from a tier miss without saying so: ${unlabelled.join(", ")}`,
    );
  });

  // #10189 REGRESSION PIN, and the one that matters: NO flag is forced here.
  //
  // The sweep above sets METAGRAPH_*_SOURCE to "postgres" so tryDataApiTier
  // degrades on demand. Useful, but it exercises a configuration production
  // has not been in since #9193 -- and that is exactly why this gap hid. At
  // the DEPLOYED value the live tier never runs, the projection tier declines,
  // and the route serves a schema-stable empty. Measured 2026-08-08 before the
  // fix: 9 of these 12 answered `ok: true` with zeros and NO header.
  //
  // Enumerated rather than spot-checked, so route 13 cannot join quietly.
  const PROJECTION_ROUTES = [
    "/api/v1/chain/fees?window=7d",
    "/api/v1/chain/activity?window=7d",
    "/api/v1/chain/calls?window=30d",
    "/api/v1/chain/signers?window=7d",
    "/api/v1/chain/transfers?window=7d",
    "/api/v1/chain/transfer-pairs?window=7d",
    "/api/v1/chain/stake-flow?window=7d",
    "/api/v1/chain/registrations?window=7d",
    "/api/v1/chain/deregistrations?window=7d",
    "/api/v1/chain/stake-moves?window=7d",
    "/api/v1/chain/stake-transfers?window=7d",
    "/api/v1/chain/weights?window=7d",
  ];

  test("every projection route labels its empty answer at the DEPLOYED flag value", async () => {
    const env = createLocalArtifactEnv() as unknown as Env;
    const unlabelled: string[] = [];
    for (const route of PROJECTION_ROUTES) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${route}`),
        env,
        {},
      );
      assert.equal(res.status, 200, `${route}: expected a 200 empty payload`);
      if (res.headers.get(DEGRADED_HEADER) !== DEGRADED_TIER_UNAVAILABLE) {
        unlabelled.push(route);
      }
    }
    assert.deepEqual(
      unlabelled,
      [],
      `served an unmeasured empty without saying so: ${unlabelled.join(", ")}`,
    );
  });

  test("a pallet-scoped chain-fees request is labelled too — it is never precomputed", async () => {
    // loadChainFeesFromArtifact declines any call_module scope outright, so
    // this reaches the same "no tier answered" state by a different door.
    // Serving zeros for `call_module=Balances` unlabelled would assert that
    // pallet paid no fees, which is a different claim entirely.
    const env = createLocalArtifactEnv() as unknown as Env;
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/fees?window=7d&call_module=Balances",
      ),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(DEGRADED_HEADER), DEGRADED_TIER_UNAVAILABLE);
  });

  test("a real tier HIT is NOT labelled", async () => {
    // A projection that answers, so nothing degrades. This is the direction
    // that keeps the header meaningful: if a healthy response carried it too,
    // consumers would learn to ignore it. (#10190: the tier this used to drive
    // is retired, so the #9146 projection is the measured read.)
    const env = {
      ...createLocalArtifactEnv(),
      ...archiveEnv({
        schema_version: 1,
        windows: {
          "7d": {
            newest_observed: LAST_RUN_AT,
            total: 1_347_135,
            groups: {
              module: [{ call_module: "SubtensorModule", count: 603_215 }],
            },
          },
        },
      }),
    } as unknown as Env;
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/calls?window=7d"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(
      body.data.total_extrinsics,
      1_347_135,
      "the projection's own total must be what is served",
    );
    assert.equal(
      res.headers.get(DEGRADED_HEADER),
      null,
      "a measured response must not claim to be degraded",
    );
  });

  test("the header is exposed cross-origin", () => {
    // An unexposed header does not reach a browser client, which defeats the
    // entire point of labelling.
    assert.match(
      EXPOSED_RESPONSE_HEADERS_VALUE,
      new RegExp(DEGRADED_HEADER),
      "x-metagraph-degraded must be in access-control-expose-headers",
    );
  });

  test("marking is idempotent and tags the returned object", () => {
    const once = markDataApiTierFallbackResponse(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    const twice = markDataApiTierFallbackResponse(once);
    assert.equal(once.headers.get(DEGRADED_HEADER), DEGRADED_TIER_UNAVAILABLE);
    // withEdgeCache checks the WeakSet on the object it receives back, so the
    // header is set IN PLACE and the same object comes out -- twice over.
    assert.equal(twice, once);
  });

  test("an immutable-headers response is copied rather than throwing", () => {
    // A response read back out of the edge cache has immutable headers. That
    // path does not reach the marker today, but a degraded response must never
    // become a 500 because the label could not be attached -- so the fallback
    // copies instead of letting the TypeError escape.
    const immutable = Response.redirect("https://api.metagraph.sh/x", 302);
    assert.throws(() => immutable.headers.set("x-probe", "1"), TypeError);
    const marked = markDataApiTierFallbackResponse(immutable);
    assert.notEqual(marked, immutable, "an immutable response must be copied");
    assert.equal(
      marked.headers.get(DEGRADED_HEADER),
      DEGRADED_TIER_UNAVAILABLE,
    );
    assert.equal(marked.status, immutable.status);
  });
});
