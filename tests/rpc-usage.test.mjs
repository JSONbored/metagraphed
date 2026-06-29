import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { formatRpcUsage } from "../src/health-serving.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// --- formatRpcUsage (pure) --------------------------------------------------

describe("formatRpcUsage", () => {
  test("cold/unmigrated D1 yields a schema-stable zeroed payload", () => {
    const out = formatRpcUsage({ window: "7d", observedAt: null });
    assert.equal(out.schema_version, 1);
    assert.equal(out.source, "rpc-proxy");
    assert.equal(out.window, "7d");
    assert.equal(out.summary.total_requests, 0);
    assert.equal(out.summary.error_rate, null); // no requests → undefined rate
    assert.equal(out.summary.cache_hit_rate, null);
    assert.equal(out.summary.latency_ms.p50, null);
    assert.equal(out.bucket_granularity, null);
    assert.deepEqual(out.buckets, []);
    assert.deepEqual(out.endpoints, []);
    assert.deepEqual(out.networks, []);
  });

  test("computes rates, ranks endpoints, and rounds latency/buckets", () => {
    const out = formatRpcUsage({
      window: "30d",
      bucketGranularity: "6h",
      observedAt: "2026-06-14T00:00:00Z",
      totals: {
        total: 1000,
        ok_count: 950,
        failover_count: 40,
        cache_hits: 250,
        avg_latency_ms: 160.7,
      },
      latency: { p50: 120.4, p95: 480.9 },
      endpointRows: [
        {
          endpoint_id: "fx",
          provider: "onfinality",
          requests: 700,
          ok_count: 690,
          avg_latency_ms: 140.2,
        },
        {
          endpoint_id: "nx",
          provider: null,
          requests: 300,
          ok_count: 260,
          avg_latency_ms: 220.8,
        },
      ],
      networkRows: [
        { network: "finney", requests: 900, ok_count: 870 },
        { network: "test", requests: 100, ok_count: 80 },
      ],
      bucketRows: [
        {
          ts: 1_718_323_200_000,
          requests: 100,
          errors: 3,
          avg_latency_ms: 120.4,
        },
        {
          ts: 1_718_344_800_000,
          requests: undefined,
          errors: undefined,
          avg_latency_ms: null,
        },
        {
          ts: "bad",
          requests: 10,
          errors: 10,
          avg_latency_ms: 999,
        },
      ],
    });
    assert.equal(out.bucket_granularity, "6h");
    assert.equal(out.summary.error_requests, 50);
    assert.equal(out.summary.error_rate, 0.05);
    assert.equal(out.summary.failover_rate, 0.04);
    assert.equal(out.summary.cache_hit_rate, 0.25);
    assert.equal(out.summary.latency_ms.p50, 120);
    assert.equal(out.summary.latency_ms.p95, 481);
    assert.equal(out.summary.latency_ms.avg, 161);
    // Endpoints keep the SQL order (by volume) and are ranked.
    assert.equal(out.endpoints[0].rank, 1);
    assert.equal(out.endpoints[0].endpoint_id, "fx");
    assert.equal(out.endpoints[0].provider, "onfinality");
    assert.equal(out.endpoints[1].rank, 2);
    assert.equal(out.endpoints[1].provider, null);
    assert.equal(out.endpoints[1].error_rate, 0.1333);
    assert.equal(out.endpoints[1].avg_latency_ms, 221);
    assert.equal(out.networks[1].network, "test");
    assert.equal(out.networks[1].error_rate, 0.2);
    assert.deepEqual(out.buckets, [
      {
        ts: 1_718_323_200_000,
        requests: 100,
        errors: 3,
        avg_latency_ms: 120,
      },
      {
        ts: 1_718_344_800_000,
        requests: 0,
        errors: 0,
        avg_latency_ms: null,
      },
    ]);
  });

  test("a sub-perfect rate does not round up to a misleading 1.0", () => {
    // 999_996 of 1_000_000 cache hits = 0.999996, which toFixed(4) would round to
    // a perfect 1.0 ("100% cache hit") even though 4 requests missed. It must
    // clamp just below 1, like the uptime/turnover ratio guards.
    const out = formatRpcUsage({
      totals: {
        total: 1_000_000,
        ok_count: 999_996,
        cache_hits: 999_996,
      },
    });
    assert.equal(out.summary.cache_hit_rate, 0.9999);
    assert.ok(out.summary.cache_hit_rate < 1);
    // error_rate = 4/1_000_000 = 0.000004 → rounds to 0 (well below 1, unaffected).
    assert.equal(out.summary.error_rate, 0);
  });

  test("a genuinely perfect rate still reports exactly 1.0", () => {
    // Every request errored (ok_count 0) → error_rate is a true 1.0, not clamped.
    const out = formatRpcUsage({
      totals: { total: 500, ok_count: 0, cache_hits: 500 },
    });
    assert.equal(out.summary.error_rate, 1);
    assert.equal(out.summary.cache_hit_rate, 1);
  });

  test("a zero-request endpoint/network row reports a null rate (no divide-by-zero)", () => {
    const out = formatRpcUsage({
      totals: { total: 0, ok_count: 0 },
      endpointRows: [{ endpoint_id: "idle", requests: 0, ok_count: 0 }],
      networkRows: [{ network: "finney", requests: 0, ok_count: 0 }],
    });
    assert.equal(out.window, null);
    assert.equal(out.endpoints[0].error_rate, null);
    assert.equal(out.networks[0].error_rate, null);
  });
});

// --- /api/v1/rpc/usage route ------------------------------------------------

async function getJson(url, env) {
  const res = await handleRequest(new Request(url), env, {});
  return { status: res.status, body: await res.json() };
}

describe("/api/v1/rpc/usage route", () => {
  test("cold local D1 returns an empty-but-valid envelope", async () => {
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/rpc/usage",
      createLocalArtifactEnv(),
    );
    assert.equal(status, 200);
    assert.equal(body.data.source, "rpc-proxy");
    assert.equal(body.data.summary.total_requests, 0);
    assert.deepEqual(body.data.endpoints, []);
    assert.deepEqual(body.data.networks, []);
  });

  test("rejects unsupported windows and stray query params", async () => {
    for (const query of ["window=bogus", "window=90d", "cacheBust=x"]) {
      const { status, body } = await getJson(
        `https://api.metagraph.sh/api/v1/rpc/usage?${query}`,
        createLocalArtifactEnv(),
      );
      assert.equal(status, 400);
      assert.equal(body.error.code, "invalid_query");
    }
  });

  test("aggregates volume, latency, endpoints, and networks from D1", async () => {
    // One mock D1 that routes each of the four aggregation queries by SQL shape.
    const usageDb = {
      prepare: (sql) => ({
        bind: () => ({
          async all() {
            if (sql.includes("COUNT(*) AS total")) {
              return {
                results: [
                  {
                    total: 500,
                    ok_count: 480,
                    failover_count: 12,
                    cache_hits: 100,
                    avg_latency_ms: 150,
                  },
                ],
              };
            }
            if (sql.includes("ranked")) {
              return { results: [{ p50: 110, p95: 430 }] };
            }
            if (sql.includes("GROUP BY endpoint_id")) {
              return {
                results: [
                  {
                    endpoint_id: "fx",
                    provider: "onfinality",
                    requests: 500,
                    ok_count: 480,
                    avg_latency_ms: 150,
                  },
                ],
              };
            }
            if (sql.includes("GROUP BY network")) {
              return {
                results: [{ network: "finney", requests: 500, ok_count: 480 }],
              };
            }
            if (sql.includes("GROUP BY ts")) {
              return {
                results: [
                  {
                    ts: 1_718_323_200_000,
                    requests: 120,
                    errors: 5,
                    avg_latency_ms: 155.6,
                  },
                ],
              };
            }
            return { results: [] };
          },
        }),
      }),
    };
    const env = { ...createLocalArtifactEnv(), METAGRAPH_HEALTH_DB: usageDb };
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/rpc/usage?window=30d",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.summary.total_requests, 500);
    assert.equal(body.data.summary.error_requests, 20);
    assert.equal(body.data.summary.latency_ms.p95, 430);
    assert.equal(body.data.endpoints[0].endpoint_id, "fx");
    assert.equal(body.data.networks[0].network, "finney");
    assert.equal(body.data.bucket_granularity, "6h");
    assert.deepEqual(body.data.buckets, [
      {
        ts: 1_718_323_200_000,
        requests: 120,
        errors: 5,
        avg_latency_ms: 156,
      },
    ]);
  });

  test("uses bounded bucket params per window", async () => {
    const calls = [];
    const usageDb = {
      prepare: (sql) => ({
        bind: (...params) => ({
          async all() {
            calls.push({ sql, params });
            return { results: [] };
          },
        }),
      }),
    };
    const env = { ...createLocalArtifactEnv(), METAGRAPH_HEALTH_DB: usageDb };
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/rpc/usage",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.bucket_granularity, "1h");
    const bucketCall = calls.find((call) => call.sql.includes("GROUP BY ts"));
    assert.ok(bucketCall);
    assert.equal(bucketCall.params[0], 60 * 60 * 1000);
    assert.equal(bucketCall.params[1], 60 * 60 * 1000);
    assert.equal(bucketCall.params[3], 7 * 24);
  });

  test("bucket query keeps the most-recent buckets (current bucket not dropped)", async () => {
    // Regression: `since` is unaligned to bucket boundaries, so a full window
    // spans maxBuckets+1 buckets. The LIMIT must keep the NEWEST maxBuckets
    // (inner ORDER BY ts DESC) and re-order ascending for the chart — a bare
    // ascending LIMIT would drop the current (leading-edge) bucket.
    const calls = [];
    const usageDb = {
      prepare: (sql) => ({
        bind: (...params) => ({
          async all() {
            calls.push({ sql, params });
            return { results: [] };
          },
        }),
      }),
    };
    const env = { ...createLocalArtifactEnv(), METAGRAPH_HEALTH_DB: usageDb };
    await getJson("https://api.metagraph.sh/api/v1/rpc/usage", env);
    const sql = calls.find((call) => call.sql.includes("GROUP BY ts")).sql;
    // Inner query takes the newest buckets; outer query restores chronological order.
    assert.match(sql, /ORDER BY ts DESC\s+LIMIT \?/);
    assert.match(sql, /\)\s*ORDER BY ts ASC\s*$/);
  });
});

// --- recordRpcUsage telemetry (via the live proxy) --------------------------

describe("RPC proxy usage telemetry (recordRpcUsage)", () => {
  const pool = {
    pools: [
      {
        id: "finney-rpc",
        endpoints: [
          {
            id: "fx",
            provider: "onfinality",
            pool_eligible: true,
            status: "ok",
            score: 100,
            url: "https://bittensor-finney.api.onfinality.io/public",
          },
        ],
      },
    ],
  };
  // rpc/pools.json is an R2-tier artifact, so the proxy reads it from
  // METAGRAPH_ARCHIVE (R2), not ASSETS.
  const baseEnv = () => ({
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    METAGRAPH_ARCHIVE: {
      async get() {
        return {
          async json() {
            return pool;
          },
        };
      },
    },
  });
  const reqFor = (method, params = []) =>
    new Request("https://metagraph.sh/rpc/v1/finney", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  function withFetch(fetchImpl, run) {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    return Promise.resolve(run()).finally(() => {
      globalThis.fetch = original;
    });
  }

  test("records a served request (endpoint, ok, latency, bypass cache)", async () => {
    const captured = [];
    const db = {
      prepare: (sql) => ({
        bind: (...binds) => ({
          async run() {
            captured.push({ sql, binds });
            return { meta: {} };
          },
        }),
      }),
    };
    const env = { ...baseEnv(), METAGRAPH_HEALTH_DB: db };
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    await withFetch(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          { status: 200 },
        ),
      async () => {
        // system_health is uncacheable → cache "bypass", recorded after failover.
        const res = await handleRequest(reqFor("system_health"), env, ctx);
        assert.equal(res.status, 200);
        await Promise.all(waits);
      },
    );
    assert.equal(captured.length, 1);
    assert.match(captured[0].sql, /INSERT INTO rpc_proxy_events/);
    const [, network, endpointId, , ok, , , , cache] = captured[0].binds;
    assert.equal(network, "finney");
    assert.equal(endpointId, "fx");
    assert.equal(ok, 1);
    assert.equal(cache, "bypass");
  });

  test("a telemetry write that throws never breaks the proxied call", async () => {
    const env = {
      ...baseEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("telemetry binding exploded");
        },
      },
    };
    const ctx = { waitUntil() {} };
    await withFetch(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
        }),
      async () => {
        const res = await handleRequest(reqFor("system_health"), env, ctx);
        assert.equal(res.status, 200);
      },
    );
  });

  test("no telemetry without a ctx.waitUntil (no-op, proxy still serves)", async () => {
    let prepared = false;
    const env = {
      ...baseEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          prepared = true;
          return { bind: () => ({ run: async () => ({}) }) };
        },
      },
    };
    await withFetch(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
        }),
      async () => {
        const res = await handleRequest(reqFor("system_health"), env, {});
        assert.equal(res.status, 200);
      },
    );
    assert.equal(prepared, false);
  });

  test("records a routing failure (no eligible endpoint → 503)", async () => {
    const captured = [];
    const emptyPool = { pools: [{ id: "finney-rpc", endpoints: [] }] };
    const env = {
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return emptyPool;
            },
          };
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare: (sql) => ({
          bind: (...binds) => ({
            async run() {
              captured.push({ sql, binds });
              return { meta: {} };
            },
          }),
        }),
      },
    };
    const waits = [];
    const res = await handleRequest(reqFor("system_health"), env, {
      waitUntil: (p) => waits.push(p),
    });
    assert.equal(res.status, 503);
    await Promise.all(waits);
    assert.equal(captured.length, 1);
    const [, , endpointId, , ok] = captured[0].binds;
    assert.equal(endpointId, null);
    assert.equal(ok, 0);
  });
});
