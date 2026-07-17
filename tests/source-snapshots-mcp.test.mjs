import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  LIST_SOURCE_SNAPSHOTS_INSTRUCTIONS,
  LIST_SOURCE_SNAPSHOTS_MCP_TOOL,
  LIST_SOURCE_SNAPSHOTS_OUTPUT_SCHEMA,
  SOURCE_SNAPSHOTS_ARTIFACT,
  loadSourceSnapshotsList,
  sourceSnapshotsMcpError,
  sourceSnapshotsQueryUrl,
} from "../src/source-snapshots-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  summary: { source_count: 2 },
  sources: [
    {
      id: "native-subnets",
      kind: "native",
      path: "/native/subnets",
      hash: "0xabc",
      record_count: 42,
    },
    {
      id: "chain-rpc",
      kind: "chain",
      path: "/chain/rpc",
      hash: "0xdef",
      record_count: 10,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === SOURCE_SNAPSHOTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("source-snapshots-mcp", () => {
  test("sourceSnapshotsMcpError is shaped for MCP toolError handling", () => {
    const err = sourceSnapshotsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("sourceSnapshotsQueryUrl validates filters and cursor", () => {
    const url = sourceSnapshotsQueryUrl({
      q: "native",
      sort: "record_count",
      order: "desc",
      fields: "id,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("q"), "native");
    assert.equal(url.searchParams.get("sort"), "record_count");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("fields"), "id,kind");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("sourceSnapshotsQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => sourceSnapshotsQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => sourceSnapshotsQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("sourceSnapshotsQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => sourceSnapshotsQueryUrl({ q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => sourceSnapshotsQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("sourceSnapshotsQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => sourceSnapshotsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => sourceSnapshotsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("sourceSnapshotsQueryUrl trims and forwards a fields projection", () => {
    const url = sourceSnapshotsQueryUrl({ fields: " id,kind " });
    assert.equal(url.searchParams.get("fields"), "id,kind");
  });

  test("sourceSnapshotsQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => sourceSnapshotsQueryUrl({ limit: "lots" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("sourceSnapshotsQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => sourceSnapshotsQueryUrl({ limit: 0 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("sourceSnapshotsQueryUrl rejects an out-of-range limit and negative cursor", () => {
    assert.throws(
      () => sourceSnapshotsQueryUrl({ limit: 500 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => sourceSnapshotsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => sourceSnapshotsQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSourceSnapshotsList returns filtered rows with pagination meta", async () => {
    const out = await loadSourceSnapshotsList(
      { env: {}, readArtifact },
      { q: "native" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.sources[0].id, "native-subnets");
  });

  test("loadSourceSnapshotsList sorts and pages the collection", async () => {
    const out = await loadSourceSnapshotsList(
      { env: {}, readArtifact },
      { sort: "record_count", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.sources[0].id, "native-subnets");
    assert.equal(out.next_cursor, 1);
  });

  test("loadSourceSnapshotsList uses an injected readArtifact dep", async () => {
    const out = await loadSourceSnapshotsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { sources: [{ id: "solo" }] },
        }),
      },
    );
    assert.equal(out.sources[0].id, "solo");
  });

  test("loadSourceSnapshotsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSourceSnapshotsList(
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

  test("loadSourceSnapshotsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSourceSnapshotsList(
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
        /source-snapshots\.json/.test(err.message),
    );
  });

  test("loadSourceSnapshotsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSourceSnapshotsList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSourceSnapshotsList projects row fields when requested", async () => {
    const out = await loadSourceSnapshotsList(
      { env: {}, readArtifact },
      { fields: "id,kind", limit: 1 },
    );
    assert.deepEqual(out.sources[0], {
      id: "native-subnets",
      kind: "native",
    });
  });

  test("loadSourceSnapshotsList preserves summary from the artifact", async () => {
    const out = await loadSourceSnapshotsList({ env: {}, readArtifact }, {});
    assert.deepEqual(out.summary, { source_count: 2 });
  });

  test("loadSourceSnapshotsList omits nullable artifact metadata when absent", async () => {
    const out = await loadSourceSnapshotsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { sources: [{ id: "solo" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
    assert.equal(out.summary, null);
  });

  test("loadSourceSnapshotsList treats a non-array sources key as empty", async () => {
    const out = await loadSourceSnapshotsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { sources: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.sources, []);
    assert.equal(out.total, 0);
  });

  test("loadSourceSnapshotsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { sources: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadSourceSnapshotsList({ env: {}, readArtifact }, {});
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

  test("loadSourceSnapshotsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSourceSnapshotsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSourceSnapshotsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSourceSnapshotsList(
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
    assert.equal(LIST_SOURCE_SNAPSHOTS_MCP_TOOL.name, "list_source_snapshots");
    assert.match(LIST_SOURCE_SNAPSHOTS_INSTRUCTIONS, /list_source_snapshots/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_SOURCE_SNAPSHOTS_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_source_snapshots", () => {
    assert.match(MCP_INSTRUCTIONS, /list_source_snapshots/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_source_snapshots");
    assert.ok(tool);
    assert.equal(tool.title, "List source input snapshots");
  });
});
