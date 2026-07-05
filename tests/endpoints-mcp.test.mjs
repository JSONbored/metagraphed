import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  ENDPOINTS_ARTIFACT,
  LIST_ENDPOINTS_INSTRUCTIONS,
  LIST_ENDPOINTS_MCP_TOOL,
  LIST_ENDPOINTS_OUTPUT_SCHEMA,
  endpointsMcpError,
  endpointsQueryUrl,
  loadEndpointsList,
} from "../src/endpoints-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  endpoints: [
    {
      netuid: 7,
      kind: "subnet-api",
      layer: "subnet-app",
      provider: "datura",
      publication_state: "monitored",
      status: "ok",
      latency_ms: 120,
      score: 92,
      pool_eligible: false,
    },
    {
      netuid: 7,
      kind: "openapi",
      layer: "docs-provider",
      provider: "chutes",
      publication_state: "verified",
      status: "degraded",
      latency_ms: 450,
      score: 70,
      pool_eligible: false,
    },
    {
      netuid: 12,
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      provider: "datura",
      publication_state: "pool-eligible",
      status: "ok",
      latency_ms: 80,
      score: 95,
      pool_eligible: true,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ENDPOINTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("endpoints-mcp", () => {
  test("endpointsMcpError is shaped for MCP toolError handling", () => {
    const err = endpointsMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("endpointsQueryUrl validates filters and cursor", () => {
    const url = endpointsQueryUrl({
      netuid: 7,
      kind: "subnet-api",
      layer: "subnet-app",
      provider: "datura",
      publication_state: "monitored",
      status: "ok",
      pool_eligible: "false",
      min_latency_ms: 50,
      max_latency_ms: 200,
      min_score: 80,
      max_score: 95,
      sort: "latency_ms",
      order: "asc",
      fields: "netuid,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("layer"), "subnet-app");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("min_latency_ms"), "50");
    assert.equal(url.searchParams.get("max_score"), "95");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("endpointsQueryUrl rejects invalid netuid and kind", () => {
    assert.throws(
      () => endpointsQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ kind: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects invalid layer and status", () => {
    assert.throws(
      () => endpointsQueryUrl({ layer: "bogus" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ status: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => endpointsQueryUrl({ provider: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects non-string provider and invalid order", () => {
    assert.throws(
      () => endpointsQueryUrl({ provider: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects invalid pool_eligible and publication_state", () => {
    assert.throws(
      () => endpointsQueryUrl({ pool_eligible: "yes" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ publication_state: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects non-number min_latency_ms", () => {
    assert.throws(
      () => endpointsQueryUrl({ min_latency_ms: "fast" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => endpointsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = endpointsQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("endpointsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = endpointsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("endpointsQueryUrl rejects a fractional netuid and cursor", () => {
    assert.throws(
      () => endpointsQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => endpointsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl clamps limit above the MCP maximum", () => {
    const url = endpointsQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadEndpointsList returns filtered rows with pagination meta", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact },
      { kind: "openapi" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].provider, "chutes");
  });

  test("loadEndpointsList sorts and pages the collection", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact },
      { sort: "score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.next_cursor, 1);
  });

  test("loadEndpointsList combines filters with AND semantics", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact },
      { netuid: 7, status: "ok" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].provider, "datura");
  });

  test("loadEndpointsList uses an injected readArtifact dep", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            endpoints: [{ netuid: 0, kind: "docs", provider: "solo" }],
          },
        }),
      },
    );
    assert.equal(out.endpoints[0].provider, "solo");
  });

  test("loadEndpointsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
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

  test("loadEndpointsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
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
        err.code === "artifact_timeout" && /endpoints\.json/.test(err.message),
    );
  });

  test("loadEndpointsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEndpointsList projects row fields when requested", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact },
      { netuid: 7, provider: "datura", fields: "netuid,provider" },
    );
    assert.deepEqual(out.endpoints[0], {
      netuid: 7,
      provider: "datura",
    });
  });

  test("loadEndpointsList omits nullable artifact metadata when absent", async () => {
    const out = await loadEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: [{ netuid: 0, kind: "docs" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
  });

  test("loadEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
  });

  test("loadEndpointsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { endpoints: [{ netuid: 1 }, { netuid: 2 }] },
      meta: {},
    });
    try {
      const out = await loadEndpointsList({ env: {}, readArtifact }, {});
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

  test("loadEndpointsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
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
    assert.equal(LIST_ENDPOINTS_MCP_TOOL.name, "list_endpoints");
    assert.match(LIST_ENDPOINTS_INSTRUCTIONS, /list_endpoints/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_ENDPOINTS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_endpoints", () => {
    assert.match(MCP_INSTRUCTIONS, /list_endpoints/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_endpoints");
    assert.ok(tool);
    assert.equal(tool.title, "List monitored endpoint resources");
  });
});
