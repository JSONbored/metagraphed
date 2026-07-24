import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  RPC_ENDPOINTS_ARTIFACT,
  LIST_RPC_ENDPOINTS_INSTRUCTIONS,
  LIST_RPC_ENDPOINTS_MCP_TOOL,
  LIST_RPC_ENDPOINTS_OUTPUT_SCHEMA,
  loadRpcEndpointsList,
  rpcEndpointsMcpError,
  rpcEndpointsQueryUrl,
} from "../src/rpc-endpoints-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadRpcEndpointsList>[0];
type LoadDeps = Parameters<typeof loadRpcEndpointsList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["rpc endpoint catalog"],
  endpoints: [
    {
      id: "dwellir-finney-rpc",
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      provider: "dwellir",
      status: "ok",
      latency_ms: 80,
      score: 95,
      pool_eligible: true,
      publication_state: "verified",
    },
    {
      id: "allnodes-finney-rpc",
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      provider: "allnodes",
      status: "degraded",
      latency_ms: 600,
      score: 40,
      pool_eligible: false,
      publication_state: "verified",
    },
    {
      id: "dwellir-finney-wss",
      kind: "subtensor-wss",
      layer: "bittensor-base",
      provider: "dwellir",
      status: "ok",
      latency_ms: 90,
      score: 93,
      pool_eligible: true,
      publication_state: "verified",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === RPC_ENDPOINTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("rpc-endpoints-mcp", () => {
  test("rpcEndpointsMcpError is shaped for MCP toolError handling", () => {
    const err = rpcEndpointsMcpError("invalid_params", "bad status");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("rpcEndpointsQueryUrl sets all filter and range params", () => {
    const url = rpcEndpointsQueryUrl({
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      netuid: 0,
      pool_eligible: "true",
      provider: "dwellir",
      publication_state: "verified",
      status: "ok",
      min_latency_ms: 50,
      max_latency_ms: 200,
      min_score: 80,
      max_score: 100,
      sort: "latency_ms",
      order: "asc",
      fields: "id,status",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subtensor-rpc");
    assert.equal(url.searchParams.get("layer"), "bittensor-base");
    assert.equal(url.searchParams.get("netuid"), "0");
    assert.equal(url.searchParams.get("pool_eligible"), "true");
    assert.equal(url.searchParams.get("provider"), "dwellir");
    assert.equal(url.searchParams.get("publication_state"), "verified");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("min_latency_ms"), "50");
    assert.equal(url.searchParams.get("max_latency_ms"), "200");
    assert.equal(url.searchParams.get("min_score"), "80");
    assert.equal(url.searchParams.get("max_score"), "100");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("rpcEndpointsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects invalid status", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ status: "healthy" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects negative netuid and fractional cursor", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects non-finite range bound", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ min_latency_ms: Infinity }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcEndpointsList returns all endpoints when unfiltered", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.returned, 3);
    assert.deepEqual(out.notes, ["rpc endpoint catalog"]);
  });

  test("loadRpcEndpointsList filters by kind, provider, and status", async () => {
    const byKind = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { kind: "subtensor-wss" },
    );
    assert.equal(byKind.returned, 1);
    assert.equal(byKind.endpoints[0].id, "dwellir-finney-wss");

    const byProvider = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { provider: "dwellir", status: "ok" },
    );
    assert.equal(byProvider.returned, 2);

    const byStatus = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { status: "degraded" },
    );
    assert.equal(byStatus.returned, 1);
    assert.equal(byStatus.endpoints[0].provider, "allnodes");
  });

  test("loadRpcEndpointsList filters by score range", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { min_score: 90 },
    );
    assert.equal(out.returned, 2);
    assert.ok(out.endpoints.every((e) => (e as Row).score >= 90));
  });

  test("loadRpcEndpointsList sorts and pages the collection", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "latency_ms", order: "asc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.endpoints[0].id, "dwellir-finney-rpc");
    assert.equal(out.next_cursor, 1);
  });

  test("loadRpcEndpointsList skips overlay when readHealthKv absent", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.returned, 3);
  });

  test("loadRpcEndpointsList applies live overlay before filtering", async () => {
    const livePool = {
      last_run_at: "2026-07-01T01:00:00.000Z",
      endpoints: [
        {
          id: "allnodes-finney-rpc",
          status: "ok",
          latency_ms: 100,
          classification: "fast",
        },
      ],
    };
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact,
        readHealthKv: async () => livePool,
      } as unknown as LoadCtx,
      { status: "ok" },
    );
    assert.equal(out.returned, 3);
  });

  test("loadRpcEndpointsList uses an injected readArtifact dep", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: [{ id: "solo" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.endpoints[0].id, "solo");
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
          } as unknown as LoadCtx,
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
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /rpc-endpoints\.json/.test(err.message),
    );
  });

  test("loadRpcEndpointsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList({ env: {}, readArtifact } as unknown as LoadCtx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcEndpointsList projects row fields when requested", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { fields: "id,status", limit: 1 },
    );
    assert.deepEqual(out.endpoints[0], {
      id: "dwellir-finney-rpc",
      status: "ok",
    });
  });

  test("loadRpcEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
  });

  test("loadRpcEndpointsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { endpoints: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadRpcEndpointsList(
        { env: {}, readArtifact } as unknown as LoadCtx,
        {},
      );
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.limit, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadRpcEndpointsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadRpcEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_RPC_ENDPOINTS_MCP_TOOL.name, "list_rpc_endpoints");
    assert.match(LIST_RPC_ENDPOINTS_INSTRUCTIONS, /list_rpc_endpoints/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_RPC_ENDPOINTS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_rpc_endpoints with filters", () => {
    assert.match(MCP_INSTRUCTIONS, /list_rpc_endpoints/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_rpc_endpoints");
    assert.ok(tool);
    assert.equal(tool.title, "List Bittensor RPC endpoints");
    assert.ok(tool.inputSchema.properties.kind);
    assert.ok(tool.inputSchema.properties.status);
    assert.ok(tool.inputSchema.properties.min_latency_ms);
  });
});
