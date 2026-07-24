import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SEARCH_INSTRUCTIONS,
  LIST_SEARCH_MCP_TOOL,
  LIST_SEARCH_OUTPUT_SCHEMA,
  SEARCH_ARTIFACT,
  loadSearchList,
  searchMcpError,
  searchQueryUrl,
} from "../src/search-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSearchList>[0];
type LoadDeps = Parameters<typeof loadSearchList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["full index"],
  documents: [
    {
      id: "subnet-7",
      type: "subnet",
      netuid: 7,
      slug: "sn-7",
      title: "Subnet Seven",
      tokens: ["seven", "sn"],
    },
    {
      id: "surface-7-openapi",
      type: "surface",
      netuid: 7,
      slug: "sn-7-openapi",
      title: "Seven OpenAPI",
      tokens: ["openapi", "spec"],
    },
    {
      id: "provider-datura",
      type: "provider",
      slug: "datura",
      title: "Datura",
      tokens: ["datura", "gpu"],
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
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
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("searchQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => searchQueryUrl({ q: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("searchQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => searchQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ fields: 42 }),
      (err: Row) => err.code === "invalid_params",
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
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => searchQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSearchList returns filtered rows with pagination meta", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { q: "Datura" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.documents[0].type, "provider");
  });

  test("loadSearchList surfaces surface hits search_subnets would drop", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { q: "OpenAPI" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.documents[0].type, "surface");
  });

  test("loadSearchList keeps token blobs the slim index omits", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { q: "gpu" },
    );
    assert.deepEqual(out.documents[0].tokens, ["datura", "gpu"]);
  });

  test("loadSearchList sorts and pages the collection", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "title", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.documents[0].slug, "sn-7");
    assert.equal(out.next_cursor, 1);
  });

  test("loadSearchList uses an injected readArtifact dep", async () => {
    const out = await loadSearchList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { documents: [{ id: "solo" }] },
        }),
      } as unknown as LoadDeps,
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
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
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
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) =>
        err.code === "artifact_timeout" && /search\.json/.test(err.message),
    );
  });

  test("loadSearchList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSearchList({ env: {}, readArtifact } as unknown as LoadCtx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSearchList projects row fields when requested", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { fields: "id,title", limit: 1 },
    );
    assert.deepEqual(out.documents[0], {
      id: "subnet-7",
      title: "Subnet Seven",
    });
  });

  test("loadSearchList preserves array notes from the artifact", async () => {
    const out = await loadSearchList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {},
    );
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
      } as unknown as LoadCtx,
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
      } as unknown as LoadCtx,
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
      const out = await loadSearchList(
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

  test("loadSearchList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSearchList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSearchList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSearchList(
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
    assert.equal(LIST_SEARCH_MCP_TOOL.name, "list_search");
    assert.match(LIST_SEARCH_INSTRUCTIONS, /list_search/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_SEARCH_OUTPUT_SCHEMA),
    );
  });

  test("tool description contrasts it with search_subnets and list_search_index", () => {
    assert.match(LIST_SEARCH_MCP_TOOL.description, /search_subnets/);
    assert.match(LIST_SEARCH_MCP_TOOL.description, /list_search_index/);
  });

  test("MCP server exports wire list_search", () => {
    assert.match(MCP_INSTRUCTIONS, /list_search\b/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_search");
    assert.ok(tool);
    assert.equal(tool.title, "List search documents");
  });

  // Deliverable: parity test asserting the tool's response matches
  // GET /api/v1/search for equivalent query params. Both the MCP loader and the
  // REST route read the same /metagraph/search.json artifact and run it through
  // applyQueryFilters over the "documents" collection, so an identical blob fed
  // to each must produce the same rows + pagination.
  test("list_search output matches GET /api/v1/search for equivalent params", async () => {
    const restEnv = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get(key: unknown) {
          if (String(key).includes("search.json")) {
            return {
              async json() {
                return SAMPLE_BLOB;
              },
              async text() {
                return JSON.stringify(SAMPLE_BLOB);
              },
            };
          }
          return null;
        },
      },
    });

    const paramSets = [
      { q: "seven" },
      { q: "datura" },
      { sort: "title", order: "desc", limit: 1 },
      { sort: "netuid", order: "asc", limit: 2, cursor: 1 },
      { fields: "id,title", limit: 2 },
      {},
    ];

    for (const params of paramSets) {
      const mcp = await loadSearchList(
        { env: {}, readArtifact } as unknown as LoadCtx,
        params,
      );

      const url = new URL("https://api.metagraph.sh/api/v1/search");
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
      const res = await handleRequest(
        new Request(url),
        restEnv as unknown as Env,
        {},
      );
      assert.equal(res.status, 200, `REST 200 for ${url.search}`);
      const body = await res.json();
      const page = body.meta.pagination;

      assert.deepEqual(
        mcp.documents,
        body.data.documents,
        `documents parity for ${url.search}`,
      );
      assert.equal(mcp.generated_at, body.data.generated_at ?? null);
      assert.equal(mcp.total, page.total);
      assert.equal(mcp.returned, page.returned);
      assert.equal(mcp.limit, page.limit);
      assert.equal(mcp.cursor, page.cursor);
      assert.equal(mcp.next_cursor, page.next_cursor);
      assert.equal(mcp.sort, page.sort);
      assert.equal(mcp.order, page.order);
    }
  });
});
