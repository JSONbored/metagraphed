import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SURFACES_INSTRUCTIONS,
  LIST_SURFACES_MCP_TOOL,
  LIST_SURFACES_OUTPUT_SCHEMA,
  SURFACES_ARTIFACT,
  loadSurfacesList,
  surfacesMcpError,
  surfacesQueryUrl,
} from "../src/surfaces-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSurfacesList>[0];
type LoadDeps = Parameters<typeof loadSurfacesList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  surfaces: [
    {
      id: "sn7-openapi",
      netuid: 7,
      kind: "openapi",
      provider: "datura",
      name: "SN7 OpenAPI",
    },
    {
      id: "sn7-api",
      netuid: 7,
      kind: "subnet-api",
      provider: "chutes",
      name: "SN7 API",
    },
    {
      id: "sn12-openapi",
      netuid: 12,
      kind: "openapi",
      provider: "datura",
      name: "SN12 OpenAPI",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === SURFACES_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("surfaces-mcp", () => {
  test("surfacesMcpError is shaped for MCP toolError handling", () => {
    const err = surfacesMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("surfacesQueryUrl validates filters and cursor", () => {
    const url = surfacesQueryUrl({
      netuid: 7,
      kind: "openapi",
      provider: "datura",
      sort: "name",
      order: "asc",
      fields: "id,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("provider"), "datura");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("surfacesQueryUrl rejects empty provider and invalid kind", () => {
    assert.throws(
      () => surfacesQueryUrl({ provider: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => surfacesQueryUrl({ kind: "not-a-kind" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects invalid sort and order", () => {
    assert.throws(
      () => surfacesQueryUrl({ sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => surfacesQueryUrl({ order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects non-string provider and empty fields", () => {
    assert.throws(
      () => surfacesQueryUrl({ provider: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => surfacesQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => surfacesQueryUrl({ fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl trims and forwards a fields projection", () => {
    const url = surfacesQueryUrl({ fields: " id,kind " });
    assert.equal(url.searchParams.get("fields"), "id,kind");
  });

  test("surfacesQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => surfacesQueryUrl({ limit: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => surfacesQueryUrl({ limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => surfacesQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => surfacesQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => surfacesQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("surfacesQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => surfacesQueryUrl({ limit: 500 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSurfacesList returns filtered rows with pagination meta", async () => {
    const out = await loadSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: 12 },
    );
    assert.equal(out.returned, 1);
    assert.equal((out.surfaces[0] as Row).provider, "datura");
  });

  test("loadSurfacesList sorts and pages the collection", async () => {
    const out = await loadSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "name", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSurfacesList combines filters with AND semantics", async () => {
    const out = await loadSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: 7, provider: "datura" },
    );
    assert.equal(out.returned, 1);
    assert.equal((out.surfaces[0] as Row).kind, "openapi");
  });

  test("loadSurfacesList uses an injected readArtifact dep", async () => {
    const out = await loadSurfacesList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: [{ netuid: 0, kind: "docs" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal((out.surfaces[0] as Row).netuid, 0);
  });

  test("loadSurfacesList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSurfacesList(
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

  test("loadSurfacesList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSurfacesList(
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
        err.code === "artifact_timeout" && /surfaces\.json/.test(err.message),
    );
  });

  test("loadSurfacesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSurfacesList({ env: {}, readArtifact } as unknown as LoadCtx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSurfacesList projects row fields when requested", async () => {
    const out = await loadSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: 7, kind: "openapi", fields: "id,kind" },
    );
    assert.deepEqual(out.surfaces[0], {
      id: "sn7-openapi",
      kind: "openapi",
    });
  });

  test("loadSurfacesList omits nullable artifact metadata when absent", async () => {
    const out = await loadSurfacesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: [{ netuid: 0, kind: "docs" }] },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
  });

  test("loadSurfacesList treats a non-array surfaces key as empty", async () => {
    const out = await loadSurfacesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: null },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
  });

  test("loadSurfacesList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [{ netuid: 1 }, { netuid: 2 }] },
      meta: {},
    });
    try {
      const out = await loadSurfacesList(
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

  test("loadSurfacesList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSurfacesList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSurfacesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSurfacesList(
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
    assert.equal(LIST_SURFACES_MCP_TOOL.name, "list_surfaces");
    assert.match(LIST_SURFACES_INSTRUCTIONS, /list_surfaces/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_SURFACES_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_surfaces", () => {
    assert.match(MCP_INSTRUCTIONS, /list_surfaces/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_surfaces");
    assert.ok(tool);
    assert.equal(tool.title, "List curated public surfaces");
  });
});
