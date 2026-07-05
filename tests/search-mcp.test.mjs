import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  LIST_SEARCH_INSTRUCTIONS,
  LIST_SEARCH_MCP_TOOL,
  LIST_SEARCH_OUTPUT_SCHEMA,
  SEARCH_ARTIFACT,
  loadSearchList,
  searchMcpError,
  searchQueryUrl,
} from "../src/search-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["full index"],
  documents: [
    {
      id: "subnet-7",
      kind: "subnet",
      netuid: 7,
      slug: "sn-7",
      title: "Subnet Seven",
      tokens: ["subnet", "seven"],
    },
    {
      id: "provider-datura",
      kind: "provider",
      slug: "datura",
      title: "Datura",
      tokens: ["datura", "data"],
    },
  ],
};

function readArtifact(_env, path) {
  if (path === SEARCH_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("search-mcp", () => {
  test("searchMcpError is shaped for MCP toolError handling", () => {
    const err = searchMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("searchQueryUrl validates filters and cursor", () => {
    const url = searchQueryUrl({
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

  test("searchQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => searchQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => searchQueryUrl({ q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => searchQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("searchQueryUrl trims and forwards a fields projection", () => {
    const url = searchQueryUrl({ fields: " id,title " });
    assert.equal(url.searchParams.get("fields"), "id,title");
  });

  test("searchQueryUrl clamps a non-numeric limit to the default", () => {
    const url = searchQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("searchQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = searchQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("searchQueryUrl clamps limit and rejects negative cursor", () => {
    assert.equal(
      searchQueryUrl({ limit: 500 }).searchParams.get("limit"),
      "100",
    );
    assert.throws(
      () => searchQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSearchList returns filtered rows with pagination meta", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact },
      { q: "Subnet" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.documents[0].netuid, 7);
    assert.deepEqual(out.documents[0].tokens, ["subnet", "seven"]);
  });

  test("loadSearchList sorts and pages the collection", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact },
      { sort: "title", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.documents[0].slug, "sn-7");
    assert.equal(out.next_cursor, 1);
  });

  test("loadSearchList uses an injected readArtifact dep", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { documents: [{ id: "solo", tokens: ["solo"] }] },
        }),
      },
    );
    assert.equal(out.documents[0].id, "solo");
  });

  test("loadSearchList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSearchList(
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

  test("loadSearchList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSearchList(
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
        err.code === "artifact_timeout" && /search\.json/.test(err.message),
    );
  });

  test("loadSearchList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSearchList({ env: {}, readArtifact }, { fields: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSearchList projects row fields when requested", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact },
      { fields: "id,title", limit: 1 },
    );
    assert.deepEqual(out.documents[0], {
      id: "subnet-7",
      title: "Subnet Seven",
    });
  });

  test("loadSearchList preserves array notes from the artifact", async () => {
    const out = await loadSearchList({ env: {}, readArtifact }, {});
    assert.deepEqual(out.notes, ["full index"]);
  });

  test("loadSearchList omits nullable artifact metadata when absent", async () => {
    const out = await loadSearchList(
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

  test("loadSearchList treats a non-array documents key as empty", async () => {
    const out = await loadSearchList(
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

  test("loadSearchList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { documents: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadSearchList({ env: {}, readArtifact }, {});
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

  test("loadSearchList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSearchList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSearchList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSearchList(
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
    assert.equal(LIST_SEARCH_MCP_TOOL.name, "list_search");
    assert.match(LIST_SEARCH_INSTRUCTIONS, /list_search/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_SEARCH_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_search", () => {
    assert.match(MCP_INSTRUCTIONS, /list_search/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_search");
    assert.ok(tool);
    assert.equal(tool.title, "List search documents");
  });
});
