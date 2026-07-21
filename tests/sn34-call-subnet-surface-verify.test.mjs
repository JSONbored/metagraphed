// SN34 (BitMind) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7049, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN34's *real* registry surface configs
// (registry/subnets/bitmind.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Live-verified 2026-07-21 (direct GET to the catalogued URLs):
//   sn-34-bitmind-openapi
//     GET https://api.bitmind.ai/openapi.json
//     -> HTTP 200 application/json (~21 KB) OpenAPI 3.1.0
//        info.title "BitMind Detection API"; paths includes /health
//   sn-34-bitmind-subnet-api
//     GET https://api.bitmind.ai/health
//     -> HTTP 200 application/json
//        {"status":"healthy","region":"us-west3","version":"1.0.0"}
// Registry already matched reality -- no registry edit needed. (Both
// surfaces use probe.expect "any"; live bodies are JSON, which "any"
// accepts.)
//
// Note on sn-34-bitmind-openapi: kind "openapi" is not in
// OPERATIONAL_SURFACE_KINDS (src/health-probe-core.mjs), so that surface is
// absent from public/metagraph/operational-surfaces.json and cannot be
// resolved through the call_subnet_surface tool in production. Per #7049, a
// direct request to the URL is equally valid verification for a no-auth GET
// surface, so it is pinned here at the callSubnetSurface module level only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 34;
const SURFACE_ID = "sn-34-bitmind-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/bitmind.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SURFACE = surfaceOf(SURFACE_ID);

// Faithful copy of the live https://api.bitmind.ai/health response body.
const HEALTH_BODY = {
  status: "healthy",
  region: "us-west3",
  version: "1.0.0",
};

describe("SN34 BitMind call_subnet_surface verification (#7049)", () => {
  test(`${SURFACE_ID}: registry surface is callable`, () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "any");
    assert.equal(SURFACE.url, "https://api.bitmind.ai/health");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test(`${SURFACE_ID}: callSubnetSurface returns the real JSON body`, async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return jsonResponse(HEALTH_BODY);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal(result.body.status, "healthy");
    assert.equal(typeof result.body.region, "string");
    assert.equal(result.body.version, "1.0.0");
  });

  test(`${SURFACE_ID}: end-to-end MCP tools/call by surface id`, async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
    };
    const deps = {
      readArtifact: async (_env, path) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return jsonResponse(HEALTH_BODY);
    };
    try {
      const response = await handleMcpRequest(
        new Request("https://metagraph.sh/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call_subnet_surface",
              arguments: { surface_id: SURFACE_ID },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.status, "healthy");
      assert.equal(result.structuredContent.body.version, "1.0.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("sn-34-bitmind-openapi (direct-call only)", () => {
    const OPENAPI = surfaceOf("sn-34-bitmind-openapi");
    const BODY = {
      openapi: "3.1.0",
      info: { title: "BitMind Detection API", version: "1.0.0" },
      paths: {
        "/health": {
          get: {
            summary: "Health Check",
            operationId: "health_check_health_get",
            responses: { 200: { description: "Successful Response" } },
          },
        },
      },
    };

    test("registry surface exists, is no-auth GET, and carries its captured schema", () => {
      assert.ok(OPENAPI, "registry surface sn-34-bitmind-openapi is present");
      assert.equal(OPENAPI.kind, "openapi");
      assert.equal(OPENAPI.auth_required, false);
      assert.equal(OPENAPI.probe?.enabled, true);
      assert.equal(OPENAPI.probe?.method, "GET");
      assert.equal(OPENAPI.probe?.expect, "any");
      assert.equal(OPENAPI.url, "https://api.bitmind.ai/openapi.json");
      assert.equal(OPENAPI.schema_status, "machine-readable");
      assert.equal(OPENAPI.schema_url, "https://api.bitmind.ai/openapi.json");
    });

    test('kind "openapi" is not an operational kind, so this surface is direct-call verified', () => {
      assert.ok(!OPERATIONAL_SURFACE_KINDS.includes("openapi"));
      assert.ok(OPERATIONAL_SURFACE_KINDS.includes("subnet-api"));
    });

    test("callSubnetSurface returns the OpenAPI 3.1.0 document as parsed JSON", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(OPENAPI, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(BODY);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, OPENAPI.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.truncated, false);
      assert.equal(result.body.openapi, "3.1.0");
      assert.equal(result.body.info.title, "BitMind Detection API");
      assert.ok(result.body.paths["/health"]?.get);
    });
  });
});
