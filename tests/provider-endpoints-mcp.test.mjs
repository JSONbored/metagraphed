import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  LIST_PROVIDER_ENDPOINTS_INSTRUCTIONS,
  LIST_PROVIDER_ENDPOINTS_MCP_TOOL,
  LIST_PROVIDER_ENDPOINTS_OUTPUT_SCHEMA,
  loadProviderEndpointsList,
  providerEndpointsArtifactPath,
  providerEndpointsMcpError,
  providerEndpointsQueryUrl,
} from "../src/provider-endpoints-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: "test",
  endpoints: [
    {
      surface_id: "datura-api",
      kind: "subnet-api",
      layer: "subnet-app",
      netuid: 1,
      status: "ok",
      latency_ms: 120,
      score: 0.9,
      pool_eligible: true,
      publication_state: "monitored",
    },
    {
      surface_id: "datura-rpc",
      kind: "rpc",
      layer: "bittensor-base",
      netuid: 1,
      status: "degraded",
      latency_ms: 400,
      score: 0.4,
      pool_eligible: false,
      publication_state: "monitored",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === providerEndpointsArtifactPath("datura")) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("provider-endpoints-mcp", () => {
  test("providerEndpointsMcpError is shaped for MCP toolError handling", () => {
    const err = providerEndpointsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("providerEndpointsQueryUrl validates filters, range bounds, and cursor", () => {
    const url = providerEndpointsQueryUrl({
      netuid: 1,
      kind: "subnet-api",
      layer: "subnet-app",
      publication_state: "monitored",
      status: "ok",
      pool_eligible: true,
      min_latency_ms: 100,
      max_latency_ms: 500,
      min_score: 0.5,
      max_score: 1,
      sort: "latency_ms",
      order: "asc",
      fields: "surface_id,status",
      limit: 10,
      cursor: 2,
    });
    assert.equal(url.searchParams.get("netuid"), "1");
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("layer"), "subnet-app");
    assert.equal(url.searchParams.get("publication_state"), "monitored");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("pool_eligible"), "true");
    assert.equal(url.searchParams.get("min_latency_ms"), "100");
    assert.equal(url.searchParams.get("max_latency_ms"), "500");
    assert.equal(url.searchParams.get("min_score"), "0.5");
    assert.equal(url.searchParams.get("max_score"), "1");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "2");
  });

  test("providerEndpointsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => providerEndpointsQueryUrl({ kind: "not-a-kind" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("providerEndpointsQueryUrl rejects non-boolean pool_eligible", () => {
    assert.throws(
      () => providerEndpointsQueryUrl({ pool_eligible: "yes" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadProviderEndpointsList requires slug", async () => {
    await assert.rejects(
      () => loadProviderEndpointsList({ env: {}, readArtifact }, {}),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadProviderEndpointsList rejects an invalid slug", async () => {
    await assert.rejects(
      () =>
        loadProviderEndpointsList(
          { env: {}, readArtifact },
          { slug: "../secrets" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadProviderEndpointsList returns filtered endpoint rows", async () => {
    const out = await loadProviderEndpointsList(
      { env: {}, readArtifact },
      { slug: "datura", kind: "subnet-api" },
    );
    assert.equal(out.slug, "datura");
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].surface_id, "datura-api");
  });

  test("loadProviderEndpointsList reports not_found when the artifact is absent", async () => {
    await assert.rejects(
      () =>
        loadProviderEndpointsList({ env: {}, readArtifact }, { slug: "ghost" }),
      (err) => err.code === "not_found",
    );
  });

  test("loadProviderEndpointsList projects row fields when requested", async () => {
    const out = await loadProviderEndpointsList(
      { env: {}, readArtifact },
      { slug: "datura", fields: "surface_id,status", limit: 1 },
    );
    assert.deepEqual(out.endpoints[0], {
      surface_id: "datura-api",
      status: "ok",
    });
  });

  test("loadProviderEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadProviderEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      },
      { slug: "solo" },
    );
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
  });

  test("loadProviderEndpointsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { endpoints: [{ surface_id: "a" }, { surface_id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadProviderEndpointsList(
        { env: {}, readArtifact },
        { slug: "datura" },
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

  test("loadProviderEndpointsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadProviderEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          { slug: "datura" },
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadProviderEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadProviderEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          { slug: "datura" },
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(
      LIST_PROVIDER_ENDPOINTS_MCP_TOOL.name,
      "list_provider_endpoints",
    );
    assert.match(
      LIST_PROVIDER_ENDPOINTS_INSTRUCTIONS,
      /list_provider_endpoints/,
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_PROVIDER_ENDPOINTS_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_provider_endpoints at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.74.0");
    assert.match(MCP_INSTRUCTIONS, /list_provider_endpoints/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_provider_endpoints");
    assert.ok(tool);
    assert.equal(tool.title, "List one provider's endpoint resources");
  });
});
