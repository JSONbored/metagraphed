import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_HEALTH_INSTRUCTIONS,
  LIST_SUBNET_HEALTH_MCP_TOOL,
  LIST_SUBNET_HEALTH_OUTPUT_SCHEMA,
  loadSubnetHealthList,
  subnetHealthArtifactPath,
  subnetHealthMcpError,
  subnetHealthQueryUrl,
} from "../src/subnet-health-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSubnetHealthList>[0];
type LoadDeps = Parameters<typeof loadSubnetHealthList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const NETUID = 7;
const ARTIFACT = subnetHealthArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: NETUID,
  surfaces: [
    {
      id: "allways-api",
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      status: "ok",
      classification: "live",
    },
    {
      id: "allways-openapi",
      netuid: NETUID,
      kind: "openapi",
      provider: "allways",
      status: "failed",
      classification: "dead",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-health-mcp", () => {
  test("subnetHealthMcpError is shaped for MCP toolError handling", () => {
    const err = subnetHealthMcpError("invalid_params", "bad status");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetHealthQueryUrl validates filters and cursor", () => {
    const url = subnetHealthQueryUrl({
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      status: "ok",
      classification: "live",
      sort: "status",
      order: "asc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("classification"), "live");
    assert.equal(url.searchParams.get("sort"), "status");
    assert.equal(url.searchParams.get("order"), "asc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetHealthQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetHealthQueryUrl({}),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects invalid status and classification", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, status: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, classification: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, provider: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects non-string provider and invalid order", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, provider: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl clamps a non-numeric limit to the default", () => {
    const url = subnetHealthQueryUrl({ netuid: NETUID, limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetHealthQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = subnetHealthQueryUrl({ netuid: NETUID, limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetHealthQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetHealthQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadSubnetHealthList returns filtered rows with pagination meta", async () => {
    const out = await loadSubnetHealthList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, status: "ok" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].status, "ok");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetHealthList filters by classification", async () => {
    const out = await loadSubnetHealthList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, classification: "dead" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].classification, "dead");
  });

  test("loadSubnetHealthList sorts and pages the collection", async () => {
    const out = await loadSubnetHealthList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, sort: "status", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetHealthList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetHealthList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            surfaces: [{ netuid: 0, kind: "docs" }],
          },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.surfaces[0].netuid, 0);
  });

  test("loadSubnetHealthList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
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

  test("loadSubnetHealthList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
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
        /health\/subnets\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetHealthList rejects an invalid list-query transform", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      error: { message: "bad filter" },
    } as unknown as ReturnType<typeof listQuery.applyQueryFilters>);
    try {
      await assert.rejects(
        () =>
          loadSubnetHealthList(
            { env: {}, readArtifact } as unknown as LoadCtx,
            { netuid: NETUID },
          ),
        (err: Row) => err.code === "invalid_params",
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("loadSubnetHealthList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetHealthList(
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
  });

  test("loadSubnetHealthList treats a non-array surfaces key as empty", async () => {
    const out = await loadSubnetHealthList(
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

  test("loadSubnetHealthList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [{ netuid: 9 }, { netuid: 9 }] },
      meta: {},
    } as unknown as ReturnType<typeof listQuery.applyQueryFilters>);
    try {
      const out = await loadSubnetHealthList(
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

  test("loadSubnetHealthList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetHealthList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetHealthList rejects missing netuid", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          { env: {}, readArtifact } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_SUBNET_HEALTH_MCP_TOOL.name, "list_subnet_health");
    assert.match(LIST_SUBNET_HEALTH_INSTRUCTIONS, /list_subnet_health/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_SUBNET_HEALTH_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_subnet_health", () => {
    assert.match(MCP_INSTRUCTIONS, /list_subnet_health/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_subnet_health");
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's per-surface health");
  });
});
