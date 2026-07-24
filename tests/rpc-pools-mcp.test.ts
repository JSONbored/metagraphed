import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  RPC_POOLS_ARTIFACT,
  LIST_RPC_POOLS_MCP_TOOL,
  LIST_RPC_POOLS_OUTPUT_SCHEMA,
  rpcPoolsMcpError,
  rpcPoolsQueryUrl,
  loadRpcPoolsList,
} from "../src/rpc-pools-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadRpcPoolsList>[0];
type LoadDeps = Parameters<typeof loadRpcPoolsList>[2];

import { MCP_TOOLS } from "../src/mcp-server.ts";

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

function readArtifact(_env: unknown, path: string) {
  if (path === RPC_POOLS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("rpc-pools-mcp", () => {
  test("rpcPoolsMcpError is shaped for MCP toolError handling", () => {
    const err = rpcPoolsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("rpcPoolsQueryUrl validates filters, range bounds, and cursor", () => {
    const url = rpcPoolsQueryUrl({
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

  test("rpcPoolsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects empty id", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ id: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects non-string id", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ id: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects non-numeric range bounds", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ min_eligible_count: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects a non-integer cursor", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl trims and forwards a fields projection", () => {
    const url = rpcPoolsQueryUrl({ fields: " id,kind " });
    assert.equal(url.searchParams.get("fields"), "id,kind");
  });

  test("rpcPoolsQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ limit: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("rpcPoolsQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => rpcPoolsQueryUrl({ limit: 500 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcPoolsList returns filtered rows with pagination meta", async () => {
    const out = await loadRpcPoolsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { id: "finney-rpc" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.pools[0].id, "finney-rpc");
    assert.equal(out.pools[0].eligible_count, 2);
  });

  test("loadRpcPoolsList applies range filters", async () => {
    const out = await loadRpcPoolsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { min_eligible_count: 2 },
    );
    assert.equal(out.returned, 2);
    assert.deepEqual(
      out.pools.map((p) => p.id),
      ["finney-rpc", "finney-wss"],
    );
  });

  test("loadRpcPoolsList sorts and pages the collection", async () => {
    const out = await loadRpcPoolsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "eligible_count", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.pools[0].id, "finney-wss");
    assert.equal(out.next_cursor, 1);
  });

  test("loadRpcPoolsList applies the live eligibility overlay before filtering", async () => {
    const out = await loadRpcPoolsList(
      {
        env: {},
        readArtifact,
        readHealthKv: async () => ({
          last_run_at: "2026-07-02T00:00:00.000Z",
          endpoints: [],
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.source, "live-cron-prober");
    assert.equal(out.operational_observed_at, "2026-07-02T00:00:00.000Z");
  });

  test("loadRpcPoolsList skips the overlay when no readHealthKv dep is provided", async () => {
    const out = await loadRpcPoolsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.source, null);
  });

  test("loadRpcPoolsList skips the overlay when the live snapshot has no endpoints array", async () => {
    const out = await loadRpcPoolsList(
      {
        env: {},
        readArtifact,
        readHealthKv: async () => ({ last_run_at: "2026-07-02T00:00:00.000Z" }),
      } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.source, null);
  });

  test("loadRpcPoolsList uses an injected readArtifact dep", async () => {
    const out = await loadRpcPoolsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { pools: [{ id: "test" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.pools[0].id, "test");
  });

  test("loadRpcPoolsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadRpcPoolsList(
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

  test("loadRpcPoolsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadRpcPoolsList(
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
        err.code === "artifact_timeout" && /rpc\/pools\.json/.test(err.message),
    );
  });

  test("loadRpcPoolsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadRpcPoolsList({ env: {}, readArtifact } as unknown as LoadCtx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcPoolsList rejects contradictory range bounds", async () => {
    await assert.rejects(
      () =>
        loadRpcPoolsList({ env: {}, readArtifact } as unknown as LoadCtx, {
          min_eligible_count: 9,
          max_eligible_count: 2,
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadRpcPoolsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadRpcPoolsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadRpcPoolsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadRpcPoolsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadRpcPoolsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { pools: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadRpcPoolsList(
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

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_RPC_POOLS_MCP_TOOL.name, "list_rpc_pools");
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_RPC_POOLS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_rpc_pools", () => {
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_rpc_pools");
    assert.ok(tool);
    assert.equal(tool.title, "List Bittensor RPC pools");
  });
});
