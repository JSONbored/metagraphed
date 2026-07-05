import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  LIST_RPC_ENDPOINTS_INSTRUCTIONS,
  LIST_RPC_ENDPOINTS_MCP_TOOL,
  LIST_RPC_ENDPOINTS_OUTPUT_SCHEMA,
  RPC_ENDPOINTS_ARTIFACT,
  loadRpcEndpointsList,
  rpcEndpointsMcpError,
  rpcEndpointsQueryUrl,
} from "../src/rpc-endpoints-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  endpoints: [
    {
      id: "finney-wss",
      url: "wss://rpc.finney.example",
      network: "finney",
      kind: "subtensor-wss",
      layer: "bittensor-base",
      provider: "opentensor",
      status: "ok",
      latency_ms: 120,
      score: 92,
      pool_eligible: true,
    },
    {
      id: "finney-https",
      url: "https://rpc.finney.example",
      network: "finney",
      kind: "subtensor-wss",
      layer: "bittensor-base",
      provider: "opentensor",
      status: "degraded",
      latency_ms: 450,
      score: 70,
      pool_eligible: false,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === RPC_ENDPOINTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("rpc-endpoints-mcp", () => {
  test("rpcEndpointsMcpError is shaped for MCP toolError handling", () => {
    const err = rpcEndpointsMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("rpcEndpointsQueryUrl validates filters and cursor", () => {
    const url = rpcEndpointsQueryUrl({
      kind: "subtensor-wss",
      layer: "bittensor-base",
      provider: "opentensor",
      publication_state: "verified",
      status: "ok",
      pool_eligible: "true",
      min_latency_ms: 50,
      max_latency_ms: 200,
      min_score: 80,
      max_score: 95,
      sort: "latency_ms",
      order: "asc",
      fields: "id,network",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subtensor-wss");
    assert.equal(url.searchParams.get("layer"), "bittensor-base");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("min_latency_ms"), "50");
    assert.equal(url.searchParams.get("max_score"), "95");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("rpcEndpointsQueryUrl forwards an optional netuid filter", () => {
    const url = rpcEndpointsQueryUrl({ netuid: 7, status: "ok" });
    assert.equal(url.searchParams.get("netuid"), "7");
  });

  test("rpcEndpointsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ kind: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects invalid layer", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ layer: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects invalid status", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ status: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ provider: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects non-string provider and invalid order", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ provider: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects non-number min_latency_ms", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ min_latency_ms: "fast" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => rpcEndpointsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = rpcEndpointsQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("rpcEndpointsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = rpcEndpointsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("rpcEndpointsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => rpcEndpointsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("rpcEndpointsQueryUrl clamps limit above the MCP maximum", () => {
    const url = rpcEndpointsQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadRpcEndpointsList returns filtered rows with pagination meta", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact },
      { status: "ok" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].status, "ok");
  });

  test("loadRpcEndpointsList sorts and pages the collection", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact },
      { sort: "score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadRpcEndpointsList uses an injected readArtifact dep", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            endpoints: [{ id: "solo", network: "finney" }],
          },
        }),
      },
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
          },
          {},
        ),
      (err) => err.code === "not_found",
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
          },
          {},
        ),
      (err) =>
        err.code === "artifact_timeout" &&
        /rpc-endpoints\.json/.test(err.message),
    );
  });

  test("loadRpcEndpointsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadRpcEndpointsList projects row fields when requested", async () => {
    const out = await loadRpcEndpointsList(
      { env: {}, readArtifact },
      { fields: "id,network", limit: 1 },
    );
    assert.deepEqual(out.endpoints[0], {
      id: "finney-wss",
      network: "finney",
    });
  });

  test("loadRpcEndpointsList omits nullable artifact metadata when absent", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: [{ id: "solo" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
  });

  test("loadRpcEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadRpcEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      },
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
      const out = await loadRpcEndpointsList({ env: {}, readArtifact }, {});
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
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadRpcEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadRpcEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          {},
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_RPC_ENDPOINTS_MCP_TOOL.name, "list_rpc_endpoints");
    assert.match(LIST_RPC_ENDPOINTS_INSTRUCTIONS, /list_rpc_endpoints/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_RPC_ENDPOINTS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_rpc_endpoints", () => {
    assert.match(MCP_INSTRUCTIONS, /list_rpc_endpoints/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_rpc_endpoints");
    assert.ok(tool);
    assert.equal(tool.title, "List Bittensor RPC endpoints");
  });
});
