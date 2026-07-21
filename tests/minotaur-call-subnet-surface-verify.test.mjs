// SN112 (minotaur) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7058, MCP execute Phase 1 follow-up #7014/#7215; issue #7123).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN112's *real* registry surface
// config (registry/subnets/minotaur.json) to the tool's contract, so a future
// edit that regresses either surface's callability (flipping to HEAD, marking
// it auth_required, disabling its probe, moving the url) is caught here.
//
// The two surfaces are the Minotaur app-intents API's own no-auth GET endpoints:
//   sn-112-minotaur-health     https://api.minotaursubnet.com/health
//   sn-112-minotaur-apps-list  https://api.minotaursubnet.com/v1/apps/
// Both single fixed endpoints (no machine-readable schema). Live-verified
// 2026-07-21: /health returns HTTP 200 application/json liveness object
// (status, service "app-intents-api", solver_round_role); /v1/apps/ returns
// HTTP 200 application/json object with an `apps` array of registered app
// records. The fixtures below mirror faithful subsets of those live responses
// rather than fetching them, keeping the tests hermetic while still exercising
// the tool's JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 112;
const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/minotaur.json", import.meta.url),
    ),
    "utf8",
  ),
);
const surfaceById = (id) =>
  registry.surfaces.find((surface) => surface.id === id);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Clones the SN44/SN123 verification shape (metagraphed#7289/#7295) for one
// Minotaur surface: pin the registry config, exercise callSubnetSurface
// directly, then resolve it end-to-end through the call_subnet_surface MCP tool
// by surface id.
function verifySurface({ surfaceId, url, body, assertBody }) {
  const SURFACE = surfaceById(surfaceId);

  describe(`SN112 minotaur ${surfaceId} call_subnet_surface verification (#7058)`, () => {
    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${surfaceId} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // No-auth GET returning JSON.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, url);
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (fetchUrl, init) => {
          requestedUrl = String(fetchUrl);
          requestedMethod = init.method;
          return jsonResponse(body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assertBody(result.body);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
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
        const requestUrl = String(input);
        if (requestUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        return jsonResponse(body);
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
                arguments: { surface_id: surfaceId },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, surfaceId);
        assert.equal(result.structuredContent.status_code, 200);
        assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

// /health: an app-intents-api liveness object.
verifySurface({
  surfaceId: "sn-112-minotaur-health",
  url: "https://api.minotaursubnet.com/health",
  body: {
    status: "ok",
    service: "app-intents-api",
    solver_round_coordinator: "running",
    solver_round_role: "leader",
  },
  assertBody: (responseBody) => {
    assert.equal(responseBody.status, "ok");
    assert.equal(typeof responseBody.service, "string");
  },
});

// /v1/apps/: an object with an `apps` array of registered app records.
verifySurface({
  surfaceId: "sn-112-minotaur-apps-list",
  url: "https://api.minotaursubnet.com/v1/apps/",
  body: {
    apps: [
      {
        app_id: "app_da6c96b84c60",
        name: "DexAggregatorApp",
        version: "1.0.11",
      },
    ],
  },
  assertBody: (responseBody) => {
    assert.ok(Array.isArray(responseBody.apps));
    assert.equal(typeof responseBody.apps[0].app_id, "string");
  },
});
