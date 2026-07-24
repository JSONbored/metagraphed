import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_SURFACES_INSTRUCTIONS,
  LIST_SUBNET_SURFACES_MCP_TOOL,
  LIST_SUBNET_SURFACES_OUTPUT_SCHEMA,
  loadSubnetSurfacesList,
  subnetSurfacesArtifactPath,
  subnetSurfacesMcpError,
  subnetSurfacesQueryUrl,
} from "../src/subnet-surfaces-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSubnetSurfacesList>[0];
type LoadDeps = Parameters<typeof loadSubnetSurfacesList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const NETUID = 7;
const ARTIFACT = subnetSurfacesArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  netuid: NETUID,
  surfaces: [
    {
      id: "allways-api",
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      name: "Allways API",
    },
    {
      id: "allways-openapi",
      netuid: NETUID,
      kind: "openapi",
      provider: "allways",
      name: "Allways OpenAPI",
    },
    {
      id: "community-docs",
      netuid: NETUID,
      kind: "docs",
      provider: "community-x",
      name: "Community Docs",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-surfaces-mcp", () => {
  test("subnetSurfacesMcpError is shaped for MCP toolError handling", () => {
    const err = subnetSurfacesMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetSurfacesQueryUrl validates filters and cursor", () => {
    const url = subnetSurfacesQueryUrl({
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      id: "allways-api",
      sort: "kind",
      order: "asc",
      fields: "id,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("id"), "allways-api");
    assert.equal(url.searchParams.get("sort"), "kind");
    assert.equal(url.searchParams.get("order"), "asc");
    assert.equal(url.searchParams.get("fields"), "id,kind");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetSurfacesQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({}),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, provider: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl rejects non-string id and invalid order", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, id: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl clamps a non-numeric limit to the default", () => {
    const url = subnetSurfacesQueryUrl({ netuid: NETUID, limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetSurfacesQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = subnetSurfacesQueryUrl({ netuid: NETUID, limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetSurfacesQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetSurfacesQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetSurfacesQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetSurfacesQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadSubnetSurfacesList filters by kind (#7902)", async () => {
    const out = await loadSubnetSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, kind: "subnet-api" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].kind, "subnet-api");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetSurfacesList filters by provider (#7902)", async () => {
    const out = await loadSubnetSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, provider: "community-x" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].provider, "community-x");
    assert.equal(out.surfaces[0].id, "community-docs");
  });

  test("loadSubnetSurfacesList filters by id", async () => {
    const out = await loadSubnetSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, id: "allways-openapi" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].id, "allways-openapi");
  });

  test("loadSubnetSurfacesList sorts and pages the collection", async () => {
    const out = await loadSubnetSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, sort: "id", order: "asc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetSurfacesList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetSurfacesList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            surfaces: [{ netuid: 0, kind: "docs", provider: "x" }],
          },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.surfaces[0].netuid, 0);
  });

  test("loadSubnetSurfacesList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetSurfacesList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetSurfacesList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetSurfacesList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /surfaces\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetSurfacesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetSurfacesList(
          { env: {}, readArtifact } as unknown as LoadCtx,
          { netuid: NETUID, fields: "not_a_column" },
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetSurfacesList projects row fields when requested", async () => {
    const out = await loadSubnetSurfacesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, fields: "id,kind", limit: 1 },
    );
    assert.deepEqual(out.surfaces[0], {
      id: "allways-api",
      kind: "subnet-api",
    });
  });

  test("loadSubnetSurfacesList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetSurfacesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: [{ netuid: 0, kind: "docs" }] },
        }),
      } as unknown as LoadCtx,
      { netuid: 0 },
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
  });

  test("loadSubnetSurfacesList treats a non-array surfaces key as empty", async () => {
    const out = await loadSubnetSurfacesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: null },
        }),
      } as unknown as LoadCtx,
      { netuid: NETUID },
    );
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
  });

  test("loadSubnetSurfacesList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [{ netuid: 9 }, { netuid: 9 }] },
      meta: {},
    });
    try {
      const out = await loadSubnetSurfacesList(
        { env: {}, readArtifact } as unknown as LoadCtx,
        { netuid: NETUID },
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

  test("loadSubnetSurfacesList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetSurfacesList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetSurfacesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetSurfacesList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetSurfacesList rejects missing netuid", async () => {
    await assert.rejects(
      () =>
        loadSubnetSurfacesList(
          { env: {}, readArtifact } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_SUBNET_SURFACES_MCP_TOOL.name, "list_subnet_surfaces");
    assert.match(LIST_SUBNET_SURFACES_INSTRUCTIONS, /list_subnet_surfaces/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_SUBNET_SURFACES_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_subnet_surfaces", () => {
    assert.match(MCP_INSTRUCTIONS, /list_subnet_surfaces/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_subnet_surfaces");
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's curated surfaces");
  });
});
