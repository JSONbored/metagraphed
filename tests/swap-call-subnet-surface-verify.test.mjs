// SN10 (Swap / TAOFi) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7026, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool
// wiring with synthetic surfaces -- this file pins SN10's two issue-scoped
// registry surfaces (registry/subnets/swap.json) to the tool's contract, so
// a future edit that regresses their callability (flipping to HEAD,
// marking them auth_required, wrongly re-enabling a dead one) is caught
// here.
//
// Live-verified 2026-07-21:
//   - sn-10-taofi-openapi: GET https://taofi-doc.web.app/openapi.yaml ->
//     200 text/yaml, ~44 KB OpenAPI document. probe.enabled: true,
//     expect: "any" (correctly not "json" -- the response is YAML, not
//     JSON) already matches this exactly.
//   - sn-10-taofi-api: GET https://taofi-api.web.app/ -> 404 (the host is
//     genuinely down/gone right now). The registry already has
//     probe.enabled: false for this surface -- that already correctly
//     reflects the live broken state, not a config defect to fix. This
//     test pins the surface's own metadata (auth_required, url,
//     schema_url) and the fact that it's deliberately probe-disabled,
//     without asserting a live call succeeds (it doesn't, and shouldn't be
//     expected to).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/swap.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceById(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

describe("SN10 Swap call_subnet_surface verification: sn-10-taofi-openapi (#7026)", () => {
  const SURFACE = surfaceById("sn-10-taofi-openapi");
  const BODY = "openapi: 3.0.3\ninfo:\n  title: TAOFi API\n  version: 1.0.0\n";

  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, "registry surface sn-10-taofi-openapi is present");
    assert.equal(SURFACE.kind, "openapi");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    // The response is YAML, not JSON -- "any" is the correct expect here.
    assert.equal(SURFACE.probe?.expect, "any");
    assert.equal(SURFACE.url, "https://taofi-doc.web.app/openapi.yaml");
    assert.equal(SURFACE.schema_url, SURFACE.url);
  });

  test("callSubnetSurface returns the real YAML body using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return new Response(BODY, {
          status: 200,
          headers: { "content-type": "text/yaml" },
        });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "text/yaml");
    assert.equal(result.truncated, false);
    // Non-JSON content-type -- returned as a raw string, not parsed.
    assert.equal(result.body, BODY);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 10 }],
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
      return new Response(BODY, {
        status: 200,
        headers: { "content-type": "text/yaml" },
      });
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
              arguments: { surface_id: "sn-10-taofi-openapi" },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, "sn-10-taofi-openapi");
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body, BODY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("SN10 Swap call_subnet_surface verification: sn-10-taofi-api (#7026)", () => {
  const SURFACE = surfaceById("sn-10-taofi-api");

  test("the surface is correctly marked probe-disabled, matching its live 404 state", () => {
    assert.ok(SURFACE, "registry surface sn-10-taofi-api is present");
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.url, "https://taofi-api.web.app/");
    // Live-verified 2026-07-21: this host returns 404. probe.enabled being
    // false is the CORRECT state here, not a bug to fix -- this test pins
    // that so a future PR doesn't flip it back to enabled without the host
    // actually coming back up.
    assert.equal(SURFACE.probe?.enabled, false);
  });
});
