import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SEARCH_INDEX_INSTRUCTIONS,
  LIST_SEARCH_INDEX_MCP_TOOL,
  LIST_SEARCH_INDEX_OUTPUT_SCHEMA,
  SEARCH_INDEX_ARTIFACT,
  loadSearchIndexList,
  searchIndexMcpError,
  searchIndexQueryUrl,
} from "../src/search-index-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["slim index"],
  documents: [
    {
      id: "subnet-7",
      kind: "subnet",
      netuid: 7,
      slug: "sn-7",
      title: "Subnet Seven",
    },
    {
      id: "provider-datura",
      kind: "provider",
      slug: "datura",
      title: "Datura",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === SEARCH_INDEX_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("search-index-mcp", () => {
  test("searchIndexMcpError is shaped for MCP toolError handling", () => {
    const err = searchIndexMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("searchIndexQueryUrl validates filters and cursor", () => {
    const url = searchIndexQueryUrl({
      q: "subnet",
      sort: "title",
      order: "desc",
      fields: "id,title",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("q"), "subnet");
    assert.equal(url.searchParams.get("sort"), "title");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("fields"), "id,title");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("searchIndexQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => searchIndexQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchIndexQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchIndexQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => searchIndexQueryUrl({ q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchIndexQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchIndexQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => searchIndexQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchIndexQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchIndexQueryUrl trims and forwards a fields projection", () => {
    const url = searchIndexQueryUrl({ fields: " id,title " });
    assert.equal(url.searchParams.get("fields"), "id,title");
  });

  test("searchIndexQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => searchIndexQueryUrl({ limit: "lots" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchIndexQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => searchIndexQueryUrl({ limit: 0 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchIndexQueryUrl rejects an out-of-range limit and negative cursor", () => {
    assert.throws(
      () => searchIndexQueryUrl({ limit: 500 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchIndexQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchIndexQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSearchIndexList returns filtered rows with pagination meta", async () => {
    const out = await loadSearchIndexList(
      { env: {}, readArtifact },
      { q: "Subnet" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.documents[0].netuid, 7);
  });

  test("loadSearchIndexList sorts and pages the collection", async () => {
    const out = await loadSearchIndexList(
      { env: {}, readArtifact },
      { sort: "title", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.documents[0].slug, "sn-7");
    assert.equal(out.next_cursor, 1);
  });

  test("loadSearchIndexList uses an injected readArtifact dep", async () => {
    const out = await loadSearchIndexList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { documents: [{ id: "solo" }] },
        }),
      },
    );
    assert.equal(out.documents[0].id, "solo");
  });

  test("loadSearchIndexList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSearchIndexList(
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

  test("loadSearchIndexList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSearchIndexList(
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
        /search-index\.json/.test(err.message),
    );
  });

  test("loadSearchIndexList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSearchIndexList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSearchIndexList projects row fields when requested", async () => {
    const out = await loadSearchIndexList(
      { env: {}, readArtifact },
      { fields: "id,title", limit: 1 },
    );
    assert.deepEqual(out.documents[0], {
      id: "subnet-7",
      title: "Subnet Seven",
    });
  });

  test("loadSearchIndexList preserves array notes from the artifact", async () => {
    const out = await loadSearchIndexList({ env: {}, readArtifact }, {});
    assert.deepEqual(out.notes, ["slim index"]);
  });

  test("loadSearchIndexList omits nullable artifact metadata when absent", async () => {
    const out = await loadSearchIndexList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { documents: [{ id: "solo" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadSearchIndexList treats a non-array documents key as empty", async () => {
    const out = await loadSearchIndexList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { documents: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.documents, []);
    assert.equal(out.total, 0);
  });

  test("loadSearchIndexList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { documents: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadSearchIndexList({ env: {}, readArtifact }, {});
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

  test("loadSearchIndexList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSearchIndexList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSearchIndexList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSearchIndexList(
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
    assert.equal(LIST_SEARCH_INDEX_MCP_TOOL.name, "list_search_index");
    assert.match(LIST_SEARCH_INDEX_INSTRUCTIONS, /list_search_index/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_SEARCH_INDEX_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_search_index", () => {
    assert.match(MCP_INSTRUCTIONS, /list_search_index/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_search_index");
    assert.ok(tool);
    assert.equal(tool.title, "List search index documents");
  });
});
