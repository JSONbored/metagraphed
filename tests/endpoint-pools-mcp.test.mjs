import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  ENDPOINT_POOLS_ARTIFACT,
  LIST_ENDPOINT_POOLS_INSTRUCTIONS,
  LIST_ENDPOINT_POOLS_MCP_TOOL,
  LIST_ENDPOINT_POOLS_OUTPUT_SCHEMA,
  endpointPoolsMcpError,
  endpointPoolsQueryUrl,
  loadEndpointPoolsList,
} from "../src/endpoint-pools-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: "test",
  pools: [
    {
      id: "finney-rpc",
      kind: "subtensor-rpc",
      eligible_count: 2,
      endpoint_count: 5,
    },
    {
      id: "finney-wss",
      kind: "subtensor-wss",
      eligible_count: 8,
      endpoint_count: 10,
    },
    {
      id: "finney-archive",
      kind: "archive",
      eligible_count: 0,
      endpoint_count: 3,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ENDPOINT_POOLS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("endpoint-pools-mcp", () => {
  test("endpointPoolsMcpError is shaped for MCP toolError handling", () => {
    const err = endpointPoolsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("endpointPoolsQueryUrl validates filters, range bounds, and cursor", () => {
    const url = endpointPoolsQueryUrl({
      id: "finney-rpc",
      kind: "subtensor-rpc",
      min_eligible_count: 2,
      max_eligible_count: 8,
      min_endpoint_count: 4,
      max_endpoint_count: 10,
      sort: "eligible_count",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("id"), "finney-rpc");
    assert.equal(url.searchParams.get("kind"), "subtensor-rpc");
    assert.equal(url.searchParams.get("min_eligible_count"), "2");
    assert.equal(url.searchParams.get("max_eligible_count"), "8");
    assert.equal(url.searchParams.get("min_endpoint_count"), "4");
    assert.equal(url.searchParams.get("max_endpoint_count"), "10");
    assert.equal(url.searchParams.get("sort"), "eligible_count");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("endpointPoolsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ kind: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects empty id", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ id: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects non-string id", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ id: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects non-numeric range bounds", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ min_eligible_count: "lots" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl trims and forwards a fields projection", () => {
    const url = endpointPoolsQueryUrl({ fields: " id,kind " });
    assert.equal(url.searchParams.get("fields"), "id,kind");
  });

  test("endpointPoolsQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ limit: "lots" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ limit: 0 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointPoolsQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => endpointPoolsQueryUrl({ limit: 500 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEndpointPoolsList returns filtered rows with pagination meta", async () => {
    const out = await loadEndpointPoolsList(
      { env: {}, readArtifact },
      { id: "finney-rpc" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.pools[0].id, "finney-rpc");
    assert.equal(out.pools[0].eligible_count, 2);
  });

  test("loadEndpointPoolsList applies range filters", async () => {
    const out = await loadEndpointPoolsList(
      { env: {}, readArtifact },
      { min_eligible_count: 2 },
    );
    assert.equal(out.returned, 2);
    assert.deepEqual(
      out.pools.map((p) => p.id),
      ["finney-rpc", "finney-wss"],
    );
  });

  test("loadEndpointPoolsList sorts and pages the collection", async () => {
    const out = await loadEndpointPoolsList(
      { env: {}, readArtifact },
      { sort: "eligible_count", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.pools[0].id, "finney-wss");
    assert.equal(out.next_cursor, 1);
  });

  test("loadEndpointPoolsList uses an injected readArtifact dep", async () => {
    const out = await loadEndpointPoolsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { pools: [{ id: "test" }] },
        }),
      },
    );
    assert.equal(out.pools[0].id, "test");
  });

  test("loadEndpointPoolsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEndpointPoolsList(
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

  test("loadEndpointPoolsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEndpointPoolsList(
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
        /endpoint-pools\.json/.test(err.message),
    );
  });

  test("loadEndpointPoolsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEndpointPoolsList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEndpointPoolsList rejects contradictory range bounds", async () => {
    await assert.rejects(
      () =>
        loadEndpointPoolsList(
          { env: {}, readArtifact },
          { min_eligible_count: 9, max_eligible_count: 2 },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEndpointPoolsList projects row fields when requested", async () => {
    const out = await loadEndpointPoolsList(
      { env: {}, readArtifact },
      { fields: "id,eligible_count", limit: 1 },
    );
    assert.deepEqual(out.pools[0], {
      id: "finney-rpc",
      eligible_count: 2,
    });
  });

  test("loadEndpointPoolsList preserves array notes from the artifact", async () => {
    const out = await loadEndpointPoolsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: {
            notes: ["advisory only"],
            pools: [{ id: "solo" }],
          },
        }),
      },
      {},
    );
    assert.deepEqual(out.notes, ["advisory only"]);
  });

  test("loadEndpointPoolsList omits nullable artifact metadata when absent", async () => {
    const out = await loadEndpointPoolsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { pools: [{ id: "solo" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadEndpointPoolsList treats a non-array pools key as empty", async () => {
    const out = await loadEndpointPoolsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { pools: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.pools, []);
    assert.equal(out.total, 0);
  });

  test("loadEndpointPoolsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { pools: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadEndpointPoolsList({ env: {}, readArtifact }, {});
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

  test("loadEndpointPoolsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEndpointPoolsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadEndpointPoolsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEndpointPoolsList(
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
    assert.equal(LIST_ENDPOINT_POOLS_MCP_TOOL.name, "list_endpoint_pools");
    assert.match(LIST_ENDPOINT_POOLS_INSTRUCTIONS, /list_endpoint_pools/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_ENDPOINT_POOLS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_endpoint_pools", () => {
    assert.match(MCP_INSTRUCTIONS, /list_endpoint_pools/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_endpoint_pools");
    assert.ok(tool);
    assert.equal(tool.title, "List generalized endpoint pools");
  });
});
