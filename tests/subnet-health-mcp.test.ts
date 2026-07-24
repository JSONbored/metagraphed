import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_HEALTH_INSTRUCTIONS,
  LIST_SUBNET_HEALTH_MCP_TOOL,
  LIST_SUBNET_HEALTH_OUTPUT_SCHEMA,
  loadSubnetHealthList,
  subnetHealthMcpError,
  subnetHealthQueryUrl,
} from "../src/subnet-health-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSubnetHealthList>[0];
type LoadDeps = Parameters<typeof loadSubnetHealthList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const NETUID = 7;

const SAMPLE_LIVE = {
  last_run_at: "2026-07-01T00:00:00.000Z",
  surfaces: [
    {
      surface_id: "allways-api",
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      url: "https://allways.example/api",
      status: "ok",
      classification: null,
      latency_ms: 120,
      status_code: 200,
      last_checked: "2026-07-01T00:00:00.000Z",
      last_ok: "2026-07-01T00:00:00.000Z",
    },
    {
      surface_id: "allways-docs",
      netuid: NETUID,
      kind: "docs",
      provider: "allways",
      url: "https://allways.example/docs",
      status: "degraded",
      classification: "content-mismatch",
      latency_ms: 900,
      status_code: 200,
      last_checked: "2026-07-01T00:00:00.000Z",
      last_ok: null,
    },
  ],
};

async function resolveLive(): Promise<Row> {
  return SAMPLE_LIVE as unknown as Row;
}

async function resolveLiveEmpty(): Promise<null> {
  return null;
}

describe("subnet-health-mcp", () => {
  test("subnetHealthMcpError is shaped for MCP toolError handling", () => {
    const err = subnetHealthMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetHealthQueryUrl validates filters and cursor", () => {
    const url = subnetHealthQueryUrl({
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      status: "ok",
      classification: "content-mismatch",
      sort: "latency_ms",
      order: "asc",
      fields: "surface_id,status",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("classification"), "content-mismatch");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
    assert.equal(url.searchParams.get("order"), "asc");
    assert.equal(url.searchParams.get("fields"), "surface_id,status");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetHealthQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetHealthQueryUrl({}),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects a negative netuid", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects invalid status", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, status: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects invalid classification", () => {
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

  test("subnetHealthQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects a non-integer limit", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, limit: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects limit outside 1-100", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, limit: 101 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetHealthQueryUrl rejects a negative cursor", () => {
    assert.throws(
      () => subnetHealthQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetHealthList returns filtered rows by status", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, status: "degraded" },
      { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal((out.surfaces[0] as Row).status, "degraded");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetHealthList returns filtered rows by classification", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, classification: "content-mismatch" },
      { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal((out.surfaces[0] as Row).surface_id, "allways-docs");
  });

  test("loadSubnetHealthList sorts and pages the collection", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, sort: "latency_ms", order: "desc", limit: 1 },
      { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal((out.surfaces[0] as Row).surface_id, "allways-docs");
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetHealthList projects row fields when requested", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, fields: "surface_id,status", limit: 1 },
      { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
    );
    assert.deepEqual(out.surfaces[0], {
      surface_id: "allways-api",
      status: "ok",
    });
  });

  test("loadSubnetHealthList falls back to the unknown snapshot when live data is absent", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID },
      { resolveLiveHealth: resolveLiveEmpty } as unknown as LoadDeps,
    );
    assert.equal(out.netuid, NETUID);
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
    assert.equal(out.health_source, "unavailable");
    assert.deepEqual(out.summary, { status: "unknown", surface_count: 0 });
  });

  test("loadSubnetHealthList falls back to the unknown snapshot for a netuid with no live rows", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: 999 },
      { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
    );
    assert.equal(out.netuid, 999);
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.health_source, "unavailable");
  });

  test("loadSubnetHealthList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          { env: {} } as unknown as LoadCtx,
          { netuid: NETUID, fields: "not_a_column" },
          { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetHealthList rejects missing netuid", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList({ env: {} } as unknown as LoadCtx, {}, {
          resolveLiveHealth: resolveLive,
        } as unknown as LoadDeps),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetHealthList uses the default resolveLiveHealth dependency when none is injected", async () => {
    const out = await loadSubnetHealthList(
      {
        env: {},
        readHealthKv: async () => null,
      } as unknown as LoadCtx,
      { netuid: NETUID },
    );
    assert.equal(out.netuid, NETUID);
    assert.deepEqual(out.surfaces, []);
  });

  test("loadSubnetHealthList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: {
        netuid: NETUID,
        surfaces: [{ surface_id: "x" }, { surface_id: "y" }],
      },
      meta: {},
    });
    try {
      const out = await loadSubnetHealthList(
        { env: {} } as unknown as LoadCtx,
        { netuid: NETUID },
        { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
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

  test("loadSubnetHealthList treats a non-array surfaces key as empty", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { netuid: NETUID, surfaces: null },
      meta: {},
    });
    try {
      const out = await loadSubnetHealthList(
        { env: {} } as unknown as LoadCtx,
        { netuid: NETUID },
        { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
      );
      assert.deepEqual(out.surfaces, []);
      assert.equal(out.total, 0);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadSubnetHealthList falls back to the requested netuid when the transformed row omits it", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [{ surface_id: "x" }] },
      meta: {},
    });
    try {
      const out = await loadSubnetHealthList(
        { env: {} } as unknown as LoadCtx,
        { netuid: NETUID },
        { resolveLiveHealth: resolveLive } as unknown as LoadDeps,
      );
      assert.equal(out.netuid, NETUID);
    } finally {
      spy.mockRestore();
    }
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
    assert.equal(tool.title, "List one subnet's live health records");
  });
});
