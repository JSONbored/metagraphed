import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { formatRpcUsage } from "../src/health-serving.ts";
import type { Row } from "./row-type.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// --- formatRpcUsage (pure) --------------------------------------------------

describe("formatRpcUsage", () => {
  test("cold/unmigrated D1 yields a schema-stable zeroed payload", () => {
    const out = formatRpcUsage({ window: "7d", observedAt: null }) as Row;
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
    }) as Row;
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
    }) as Row;
    assert.equal(out.window, null);
    assert.equal(out.endpoints[0].error_rate, null);
    assert.equal(out.networks[0].error_rate, null);
  });
});

// --- /api/v1/rpc/usage route ------------------------------------------------

async function getJson(url: string, env: Row) {
  const res = await handleRequest(new Request(url), env as unknown as Env, {});
  return { status: res.status, body: (await res.json()) as Row };
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
  const reqFor = (method: string, params: unknown[] = []) =>
    new Request("https://metagraph.sh/rpc/v1/finney", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  function withFetch(fetchImpl: typeof fetch, run: () => unknown) {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    return Promise.resolve(run()).finally(() => {
      globalThis.fetch = original;
    });
  }

  // #9228: the write target is a Workers Analytics Engine dataset. This
  // double records the data points the writer emitted; the slot LAYOUT those
  // points use is asserted positionally in tests/rpc-usage-capture.test.ts.
  function captureDataset() {
    const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] =
      [];
    return {
      points,
      writeDataPoint(point: {
        blobs: string[];
        doubles: number[];
        indexes: string[];
      }) {
        points.push(point);
      },
    };
  }

  test("records a served request (endpoint, ok, latency, bypass cache)", async () => {
    const dataset = captureDataset();
    const env = { ...baseEnv(), RPC_USAGE_ANALYTICS: dataset };
    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          { status: 200 },
        )) as unknown as typeof fetch,
      async () => {
        // system_health is uncacheable -> cache "bypass", recorded after failover.
        const res = await handleRequest(
          reqFor("system_health"),
          env as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
      },
    );
    assert.equal(dataset.points.length, 1);
    const point = dataset.points[0]!;
    // pool, network, endpoint_id, provider, cache -- see RPC_USAGE_BLOBS.
    assert.deepEqual(point.blobs, [
      "public",
      "finney",
      "fx",
      "onfinality",
      "bypass",
    ]);
    // ok, attempts, latency, status.
    assert.equal(point.doubles[0], 1);
    assert.equal(point.doubles[3], 200);
    assert.ok(point.doubles[2] >= 0);
    assert.deepEqual(point.indexes, ["public/finney/fx"]);
  });

  test("the write is off the request path entirely -- no ctx.waitUntil needed", async () => {
    // The structural half of the latency guarantee: writeDataPoint is
    // non-blocking, so there is no deferred promise for a request to wait on.
    // A ctx-less invocation must still capture, which is the difference from
    // every previous implementation of this writer.
    const dataset = captureDataset();
    const waits: Promise<unknown>[] = [];
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
        })) as unknown as typeof fetch,
      async () => {
        const res = await handleRequest(
          reqFor("system_health"),
          { ...baseEnv(), RPC_USAGE_ANALYTICS: dataset } as unknown as Env,
          { waitUntil: (p: Promise<unknown>) => waits.push(p) },
        );
        assert.equal(res.status, 200);
      },
    );
    assert.equal(dataset.points.length, 1);
    assert.equal(waits.length, 0, "telemetry must not extend the request");
  });

  test("a telemetry write that throws never breaks the proxied call", async () => {
    const env = {
      ...baseEnv(),
      RPC_USAGE_ANALYTICS: {
        writeDataPoint() {
          throw new Error("dataset unavailable");
        },
      },
    };
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
        })) as unknown as typeof fetch,
      async () => {
        const res = await handleRequest(
          reqFor("system_health"),
          env as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
      },
    );
  });

  test("no dataset binding is a no-op, and the proxy still serves", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
        })) as unknown as typeof fetch,
      async () => {
        const res = await handleRequest(
          reqFor("system_health"),
          baseEnv() as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
      },
    );
  });

  test("records a routing failure (no eligible endpoint -> 503)", async () => {
    const dataset = captureDataset();
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
      RPC_USAGE_ANALYTICS: dataset,
    };
    const res = await handleRequest(
      reqFor("system_health"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 503);
    assert.equal(dataset.points.length, 1);
    const point = dataset.points[0]!;
    // "" is the no-endpoint sentinel; a GROUP BY needs a value to bucket.
    assert.equal(point.blobs[2], "");
    assert.equal(point.blobs[3], "");
    assert.equal(point.doubles[0], 0, "not ok");
    assert.equal(point.doubles[3], 503);
    assert.deepEqual(point.indexes, ["public/finney/none"]);
  });
});
