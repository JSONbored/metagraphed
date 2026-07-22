import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_ENDPOINTS_INSTRUCTIONS,
  LIST_SUBNET_ENDPOINTS_MCP_TOOL,
  LIST_SUBNET_ENDPOINTS_OUTPUT_SCHEMA,
  loadSubnetEndpointsList,
  subnetEndpointsArtifactPath,
  subnetEndpointsMcpError,
  subnetEndpointsQueryUrl,
} from "../src/subnet-endpoints-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const NETUID = 7;
const ARTIFACT = subnetEndpointsArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: NETUID,
  endpoints: [
    {
      id: "allways-api",
      netuid: NETUID,
      kind: "subnet-api",
      layer: "bittensor-base",
      provider: "allways",
      status: "ok",
      latency_ms: 120,
      score: 92,
      pool_eligible: true,
    },
    {
      id: "allways-openapi",
      netuid: NETUID,
      kind: "openapi",
      layer: "bittensor-base",
      provider: "allways",
      status: "degraded",
      latency_ms: 450,
      score: 70,
      pool_eligible: false,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-endpoints-mcp", () => {
  test("subnetEndpointsMcpError is shaped for MCP toolError handling", () => {
    const err = subnetEndpointsMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetEndpointsQueryUrl validates filters and cursor", () => {
    const url = subnetEndpointsQueryUrl({
      netuid: NETUID,
      kind: "subnet-api",
      layer: "bittensor-base",
      provider: "allways",
      publication_state: "verified",
      status: "ok",
      pool_eligible: "true",
      min_latency_ms: 50,
      max_latency_ms: 200,
      min_score: 80,
      max_score: 95,
      sort: "latency_ms",
      order: "asc",
      fields: "id,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("layer"), "bittensor-base");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("min_latency_ms"), "50");
    assert.equal(url.searchParams.get("max_score"), "95");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetEndpointsQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({}),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, kind: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects invalid layer", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, layer: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects invalid status", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, status: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, provider: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects non-string provider and invalid order", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, provider: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects non-number min_latency_ms", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, min_latency_ms: "fast" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = subnetEndpointsQueryUrl({ netuid: NETUID, limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetEndpointsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = subnetEndpointsQueryUrl({ netuid: NETUID, limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetEndpointsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetEndpointsQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEndpointsQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetEndpointsQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadSubnetEndpointsList returns filtered rows with pagination meta", async () => {
    const out = await loadSubnetEndpointsList(
      { env: {}, readArtifact },
      { netuid: NETUID, kind: "subnet-api" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].kind, "subnet-api");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetEndpointsList sorts and pages the collection", async () => {
    const out = await loadSubnetEndpointsList(
      { env: {}, readArtifact },
      { netuid: NETUID, sort: "score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetEndpointsList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetEndpointsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            endpoints: [{ netuid: 0, kind: "docs" }],
          },
        }),
      },
    );
    assert.equal(out.endpoints[0].netuid, 0);
  });

  test("loadSubnetEndpointsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetEndpointsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSubnetEndpointsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetEndpointsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          },
          { netuid: NETUID },
        ),
      (err) =>
        err.code === "artifact_timeout" &&
        /endpoints\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetEndpointsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetEndpointsList(
          { env: {}, readArtifact },
          { netuid: NETUID, fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSubnetEndpointsList projects row fields when requested", async () => {
    const out = await loadSubnetEndpointsList(
      { env: {}, readArtifact },
      { netuid: NETUID, fields: "id,kind", limit: 1 },
    );
    assert.deepEqual(out.endpoints[0], {
      id: "allways-api",
      kind: "subnet-api",
    });
  });

  test("loadSubnetEndpointsList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: [{ netuid: 0, kind: "docs" }] },
        }),
      },
      { netuid: 0 },
    );
    assert.equal(out.generated_at, null);
  });

  test("loadSubnetEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadSubnetEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      },
      { netuid: NETUID },
    );
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
  });

  test("loadSubnetEndpointsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { endpoints: [{ netuid: 9 }, { netuid: 9 }] },
      meta: {},
    });
    try {
      const out = await loadSubnetEndpointsList(
        { env: {}, readArtifact },
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

  test("loadSubnetEndpointsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSubnetEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetEndpointsList rejects missing netuid", async () => {
    await assert.rejects(
      () => loadSubnetEndpointsList({ env: {}, readArtifact }, {}),
      (err) => err.code === "invalid_params",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_SUBNET_ENDPOINTS_MCP_TOOL.name, "list_subnet_endpoints");
    assert.match(LIST_SUBNET_ENDPOINTS_INSTRUCTIONS, /list_subnet_endpoints/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_SUBNET_ENDPOINTS_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_subnet_endpoints", () => {
    assert.match(MCP_INSTRUCTIONS, /list_subnet_endpoints/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_subnet_endpoints");
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's endpoint resources");
  });
});
