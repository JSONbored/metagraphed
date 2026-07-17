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
  // D1 fully eliminated (2026-07-17): loadRpcUsage never queries
  // rpc_proxy_events any more, so a Postgres-tier miss always returns the
  // schema-stable empty payload -- this is now the only cold-path shape.
  test("cold miss returns an empty-but-valid envelope", async () => {
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

  // D1 write retired 2026-07-16 (item 7 of the D1->Postgres cleanup):
  // syncRpcUsageEventToPostgres (via env.DATA_API) is the sole writer for
  // rpc_proxy_events now -- confirmed unconditionally called, live since
  // 2026-07-11 per METAGRAPH_RPC_USAGE_SOURCE's own wrangler.jsonc comment.
  test("records a served request (endpoint, ok, latency, bypass cache)", async () => {
    const captured = [];
    const env = {
      ...baseEnv(),
      DATA_API: {
        fetch: async (request) => {
          captured.push(await request.json());
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    };
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
    const event = captured[0];
    assert.equal(event.network, "finney");
    assert.equal(event.endpoint_id, "fx");
    assert.equal(event.ok, true);
    assert.equal(event.cache, "bypass");
  });

  test("a telemetry write that throws never breaks the proxied call", async () => {
    const env = {
      ...baseEnv(),
      DATA_API: {
        fetch: async () => {
          throw new Error("telemetry binding exploded");
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
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
    let fetched = false;
    const env = {
      ...baseEnv(),
      DATA_API: {
        fetch: async () => {
          fetched = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
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
    assert.equal(fetched, false);
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
      DATA_API: {
        fetch: async (request) => {
          captured.push(await request.json());
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    };
    const waits = [];
    const res = await handleRequest(reqFor("system_health"), env, {
      waitUntil: (p) => waits.push(p),
    });
    assert.equal(res.status, 503);
    await Promise.all(waits);
    assert.equal(captured.length, 1);
    const event = captured[0];
    assert.equal(event.endpoint_id, null);
    assert.equal(event.ok, false);
  });
});
