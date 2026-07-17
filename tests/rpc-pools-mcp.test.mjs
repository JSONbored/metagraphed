import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { MCP_TOOLS } from "../src/mcp-server.mjs";

// #6570: list_rpc_pools mirrors GET /api/v1/rpc/pools, which is now listQuery-
// registered. The tool applies the same filter/sort/paginate machinery over the
// (optionally live-overlaid) /metagraph/rpc/pools.json pools array.

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
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

const tool = MCP_TOOLS.find((t) => t.name === "list_rpc_pools");

function ctx(overrides = {}) {
  return {
    env: {},
    readArtifact: async () => ({
      ok: true,
      data: structuredClone(SAMPLE_BLOB),
    }),
    readHealthKv: async () => null,
    ...overrides,
  };
}

describe("list_rpc_pools list-query support (#6570)", () => {
  test("exposes pagination/filter arguments (no longer an empty schema)", () => {
    const props = tool.inputSchema.properties;
    for (const key of ["id", "kind", "sort", "order", "limit", "cursor"]) {
      assert.ok(key in props, `expected inputSchema arg \`${key}\``);
    }
  });

  test("limit + cursor page the pool list with pagination meta", async () => {
    const res = await tool.handler({ limit: 1 }, ctx());
    assert.equal(res.pools.length, 1);
    assert.equal(res.total, 3);
    assert.equal(res.returned, 1);
    assert.equal(res.limit, 1);
    assert.equal(res.next_cursor, 1);
    // top-level artifact fields survive the transform
    assert.equal(res.generated_at, SAMPLE_BLOB.generated_at);
  });

  test("sort + order orders before paging", async () => {
    const res = await tool.handler(
      { sort: "eligible_count", order: "desc" },
      ctx(),
    );
    assert.deepEqual(
      res.pools.map((p) => p.id),
      ["finney-wss", "finney-rpc", "finney-archive"],
    );
    assert.equal(res.sort, "eligible_count");
    assert.equal(res.order, "desc");
  });

  test("kind filter narrows the collection", async () => {
    const res = await tool.handler({ kind: "archive" }, ctx());
    assert.deepEqual(
      res.pools.map((p) => p.id),
      ["finney-archive"],
    );
  });

  test("invalid cursor is rejected (not silently coerced)", async () => {
    await assert.rejects(() => tool.handler({ cursor: -1 }, ctx()), /cursor/);
  });

  test("invalid sort field is rejected", async () => {
    await assert.rejects(
      () => tool.handler({ sort: "not_a_field" }, ctx()),
      /sort/,
    );
  });

  test("an unknown fields projection surfaces as an invalid-params error", async () => {
    await assert.rejects(
      () => tool.handler({ fields: "definitely_not_a_pool_field" }, ctx()),
      /fields/,
    );
  });

  test("a non-list artifact (no pools array) is returned untransformed", async () => {
    const res = await tool.handler(
      { limit: 5 },
      ctx({
        readArtifact: async () => ({
          ok: true,
          data: { generated_at: "2026-07-01T00:00:00.000Z", schema_version: 1 },
        }),
      }),
    );
    assert.equal(res.pools, undefined);
    assert.equal(res.generated_at, "2026-07-01T00:00:00.000Z");
  });

  test("live pool overlay is applied before filtering", async () => {
    const res = await tool.handler(
      { limit: 5 },
      ctx({
        readHealthKv: async () => ({
          endpoints: [],
          last_run_at: "2026-07-01T01:00:00.000Z",
        }),
      }),
    );
    assert.equal(res.source, "live-cron-prober");
    assert.equal(res.operational_observed_at, "2026-07-01T01:00:00.000Z");
    assert.equal(res.pools.length, 3);
  });
});
