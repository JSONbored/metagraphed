import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import * as listQuery from "../workers/list-query.ts";
import {
  RPC_ENDPOINTS_ARTIFACT,
  loadRpcEndpointsList,
  rpcEndpointsMcpError,
  rpcEndpointsQueryUrl,
} from "../src/rpc-endpoints-mcp.ts";
import type { Row } from "./row-type.ts";

type Ctx = Parameters<typeof loadRpcEndpointsList>[0];
type Deps = Parameters<typeof loadRpcEndpointsList>[2];

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  notes: "test",
  summary: { endpoint_count: 3 },
  endpoints: [
    {
      id: "finney-wss",
      kind: "subtensor-wss",
      layer: "bittensor-base",
      provider: "opentensor",
      publication_state: "monitored",
      status: "degraded",
      latency_ms: 200,
      score: 40,
      pool_eligible: true,
      netuid: 0,
    },
    {
      id: "subvortex",
      kind: "subtensor-wss",
      layer: "bittensor-base",
      provider: "subvortex",
      publication_state: "monitored",
      status: "ok",
      latency_ms: 80,
      score: 70,
      pool_eligible: false,
      netuid: 0,
    },
    {
      id: "finney-rpc",
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      provider: "opentensor",
      publication_state: "pool-eligible",
      status: "ok",
      latency_ms: 50,
      score: 90,
      pool_eligible: true,
      netuid: 0,
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === RPC_ENDPOINTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("rpc-endpoints-mcp (#7886)", () => {
  test("rpcEndpointsMcpError is shaped for toolError handling", () => {
    const err = rpcEndpointsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("rpcEndpointsQueryUrl forwards the full REST filter set", () => {
    const url = rpcEndpointsQueryUrl({
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      netuid: 0,
      pool_eligible: true,
      provider: "opentensor",
      publication_state: "monitored",
      status: "ok",
      min_latency_ms: 10,
      max_latency_ms: 100,
      min_score: 50,
      max_score: 100,
      fields: ["id", "latency_ms"],
      sort: "latency_ms",
      order: "asc",
      limit: 10,
      cursor: "0",
    });
    assert.equal(url.searchParams.get("kind"), "subtensor-rpc");
    assert.equal(url.searchParams.get("layer"), "bittensor-base");
    assert.equal(url.searchParams.get("netuid"), "0");
    assert.equal(url.searchParams.get("pool_eligible"), "true");
    assert.equal(url.searchParams.get("provider"), "opentensor");
    assert.equal(url.searchParams.get("publication_state"), "monitored");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("min_latency_ms"), "10");
    assert.equal(url.searchParams.get("max_latency_ms"), "100");
    assert.equal(url.searchParams.get("min_score"), "50");
    assert.equal(url.searchParams.get("max_score"), "100");
    assert.equal(url.searchParams.get("fields"), "id,latency_ms");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
    assert.equal(url.searchParams.get("order"), "asc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "0");
  });

  test("rpcEndpointsQueryUrl accepts a string fields projection and numeric cursor", () => {
    const url = rpcEndpointsQueryUrl({
      fields: " id,score ",
      cursor: 5,
      limit: 2000,
    });
    assert.equal(url.searchParams.get("fields"), "id,score");
    assert.equal(url.searchParams.get("cursor"), "5");
    assert.equal(url.searchParams.get("limit"), "1000");
  });

  test("rpcEndpointsQueryUrl clamps a non-positive limit to the default", () => {
    const url = rpcEndpointsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
    const nanUrl = rpcEndpointsQueryUrl({ limit: Number.NaN });
    assert.equal(nanUrl.searchParams.get("limit"), "50");
    const strUrl = rpcEndpointsQueryUrl({ limit: "lots" });
    assert.equal(strUrl.searchParams.get("limit"), "50");
  });

  test("rpcEndpointsQueryUrl rejects invalid inputs", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ sort: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ pool_eligible: "yes" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ fields: [] }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ cursor: "abc" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ provider: 12 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ min_latency_ms: "slow" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcEndpointsList combines filters and sorts", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as Ctx,
      {
        kind: "subtensor-wss",
        provider: "opentensor",
        pool_eligible: true,
        sort: "latency_ms",
        order: "asc",
      },
    );
    assert.equal(out.total, 1);
    assert.equal(out.endpoints[0].id, "finney-wss");
    assert.equal(out.sort, "latency_ms");
    assert.equal(out.order, "asc");
  });

  test("loadRpcEndpointsList applies the live overlay before filtering", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact,
        readHealthKv: async () => ({
          last_run_at: "2026-07-20T12:00:00.000Z",
          endpoints: [
            {
              id: "finney-wss",
              status: "ok",
              classification: "live",
              latency_ms: 42,
            },
          ],
        }),
      } as unknown as Ctx,
      { max_latency_ms: 50 },
    );
    assert.equal(out.source, "live-cron-prober");
    const overlaid = out.endpoints.find((e) => e.id === "finney-wss");
    assert.ok(overlaid);
    assert.equal(overlaid.latency_ms, 42);
    assert.ok(out.endpoints.every((e) => (e.latency_ms as number) <= 50));
  });

  test("loadRpcEndpointsList keeps static catalog when live merge cannot apply", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact,
        readHealthKv: async () => ({ endpoints: "nope" }),
      } as unknown as Ctx,
      {},
    );
    assert.equal(out.source, null);
    assert.equal(out.endpoints.length, 3);
  });

  test("loadRpcEndpointsList uses an injected readArtifact dep", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as Ctx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: [{ id: "injected", netuid: 0 }] },
        }),
      } as unknown as Deps,
    );
    assert.equal(out.endpoints[0].id, "injected");
  });

  test("loadRpcEndpointsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          } as unknown as Ctx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadRpcEndpointsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as Ctx,
          {},
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /rpc-endpoints\.json/.test(err.message),
    );
  });

  test("loadRpcEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as Ctx,
          {},
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadRpcEndpointsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as Ctx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadRpcEndpointsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList({ env: {}, readArtifact } as unknown as Ctx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcEndpointsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: {
        endpoints: [{ id: "a" }, { id: "b" }],
      },
      meta: undefined,
    });
    try {
      const out = await loadRpcEndpointsList(
        { env: {}, readArtifact } as unknown as Ctx,
        {},
      );
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadRpcEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      } as unknown as Ctx,
      {},
    );
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
  });
});
