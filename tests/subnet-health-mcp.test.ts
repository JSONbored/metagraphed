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
  schema_version: 1,
  netuid: NETUID,
  summary: { status: "degraded", surface_count: 2 },
  operational_observed_at: "2026-07-01T00:15:00.000Z",
  health_source: "live-cron-prober",
  surfaces: [
    {
      surface_id: "7:subnet-api:x",
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      status: "ok",
      classification: "live",
      latency_ms: 120,
    },
    {
      surface_id: "7:openapi:y",
      netuid: NETUID,
      kind: "openapi",
      provider: "allways",
      status: "failed",
      classification: "timeout",
      latency_ms: null,
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
      sort: "latency_ms",
      order: "asc",
      fields: "surface_id,status",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("classification"), "live");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
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

  test("loadSubnetHealthList filters by status", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, status: "ok" },
      { readArtifact } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].status, "ok");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetHealthList filters by classification", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, classification: "timeout" },
      { readArtifact } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].classification, "timeout");
  });

  test("loadSubnetHealthList sorts and pages the collection", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, sort: "status", order: "asc", limit: 1 },
      { readArtifact } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetHealthList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            surfaces: [{ netuid: 0, kind: "docs", status: "ok" }],
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
          { env: {} } as unknown as LoadCtx,
          { netuid: NETUID },
          {
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          } as unknown as LoadDeps,
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetHealthList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          { env: {} } as unknown as LoadCtx,
          { netuid: NETUID },
          {
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as LoadDeps,
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /health\/subnets\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetHealthList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          { env: {} } as unknown as LoadCtx,
          { netuid: NETUID, fields: "not_a_column" },
          { readArtifact } as unknown as LoadDeps,
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetHealthList projects row fields when requested", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID, fields: "surface_id,status", limit: 1 },
      { readArtifact } as unknown as LoadDeps,
    );
    assert.deepEqual(out.surfaces[0], {
      surface_id: "7:subnet-api:x",
      status: "ok",
    });
  });

  test("loadSubnetHealthList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: [{ netuid: 0, kind: "docs" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.summary, null);
  });

  test("loadSubnetHealthList treats a non-array surfaces key as empty", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID },
      {
        readArtifact: async () => ({
          ok: true,
          data: { surfaces: null },
        }),
      } as unknown as LoadDeps,
    );
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
  });

  test("loadSubnetHealthList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [{ netuid: 9 }, { netuid: 9 }] },
      meta: {},
    });
    try {
      const out = await loadSubnetHealthList(
        { env: {} } as unknown as LoadCtx,
        { netuid: NETUID },
        { readArtifact } as unknown as LoadDeps,
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
          { env: {} } as unknown as LoadCtx,
          { netuid: NETUID },
          {
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadDeps,
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetHealthList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList(
          { env: {} } as unknown as LoadCtx,
          { netuid: NETUID },
          {
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadDeps,
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetHealthList rejects missing netuid", async () => {
    await assert.rejects(
      () =>
        loadSubnetHealthList({ env: {} } as unknown as LoadCtx, {}, {
          readArtifact,
        } as unknown as LoadDeps),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetHealthList uses live overlay when readArtifact is unset", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID },
      {
        resolveLiveHealth: async () => ({
          last_run_at: "2026-07-01T00:15:00.000Z",
          surfaces: [
            {
              surface_id: "7:subnet-api:x",
              netuid: NETUID,
              kind: "subnet-api",
              provider: "allways",
              status: "ok",
              classification: "live",
              latency_ms: 50,
              last_checked: "2026-07-01T00:15:00.000Z",
              last_ok: "2026-07-01T00:15:00.000Z",
            },
          ],
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].status, "ok");
    assert.equal(out.operational_observed_at, "2026-07-01T00:15:00.000Z");
  });

  test("loadSubnetHealthList honors an injected overlaySubnetHealth dep", async () => {
    const out = await loadSubnetHealthList(
      { env: {} } as unknown as LoadCtx,
      { netuid: NETUID },
      {
        resolveLiveHealth: async () => ({ surfaces: [] }),
        overlaySubnetHealth: () => ({
          netuid: NETUID,
          health_source: "injected",
          surfaces: [
            {
              surface_id: "7:docs:z",
              netuid: NETUID,
              kind: "docs",
              status: "degraded",
              classification: "rate-limited",
            },
          ],
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.health_source, "injected");
    assert.equal(out.surfaces[0].classification, "rate-limited");
  });

  test("loadSubnetHealthList returns unknown card when live store is cold", async () => {
    const out = await loadSubnetHealthList(
      {
        env: {},
        readHealthKv: async () => null,
      } as unknown as LoadCtx,
      { netuid: NETUID },
    );
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
    assert.equal(out.health_source, "unavailable");
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
    assert.equal(tool.title, "List one subnet's health surfaces");
  });
});
