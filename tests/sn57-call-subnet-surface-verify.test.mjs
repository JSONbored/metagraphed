// SN57 (Sparket) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7070, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN57's *real* registry surface config
// (registry/subnets/sparket.json) to the tool's contract, so a future edit
// that regresses its callability is caught here.
//
// The surface is the public no-auth Sparket API health feed
// (sn-57-sparket-subnet-api, GET https://sparket.ai/api/v1/health, JSON,
// single fixed endpoint -- no schema). Live-verified 2026-07-21 to return
// HTTP 200 application/json:
//   {"status":"degraded","last_sync_at":"...","sync_lag_seconds":...,
//    "db_connected":true,"version":"0.1.0"}
// Registry already matched reality -- no registry edit needed. The fixture
// below mirrors that live response rather than fetching it, keeping the test
// hermetic while still exercising the JSON parse-and-return path. (status /
// sync_lag_seconds are live operational fields, so assertions pin the stable
// shape plus the observed version, not a particular health status.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-57-sparket-subnet-api";
const NETUID = 57;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/sparket.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

// Faithful copy of the live https://sparket.ai/api/v1/health response body
// observed 2026-07-21 (status was "degraded" due to sync lag).
const BODY = {
  status: "degraded",
  last_sync_at: "2026-04-27T03:32:28.184732Z",
  sync_lag_seconds: 7355255,
  db_connected: true,
  version: "0.1.0",
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN57 Sparket call_subnet_surface verification (#7070)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://sparket.ai/api/v1/health");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return upstreamResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal(typeof result.body.status, "string");
    assert.equal(typeof result.body.last_sync_at, "string");
    assert.equal(typeof result.body.sync_lag_seconds, "number");
    assert.equal(result.body.db_connected, true);
    assert.equal(result.body.version, "0.1.0");
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
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return upstreamResponse();
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
      assert.equal(typeof result.structuredContent.body.status, "string");
      assert.equal(result.structuredContent.body.db_connected, true);
      assert.equal(result.structuredContent.body.version, "0.1.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
