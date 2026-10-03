// SN10 (Swap / TAOFi) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7026, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.ts -- which proves the tool
// wiring with synthetic surfaces -- this file pins SN10's two issue-scoped
// registry surfaces (registry/subnets/swap.json) to the tool's contract, so
// a future edit that regresses their callability (flipping to HEAD,
// marking them auth_required, wrongly re-enabling a dead one) is caught
// here.
//
// Recurring GET/HEAD probes stay separate from explicit calls. TaoFi's
// published schema declares eight JSON POST operations; a GET 404 at the
// bare host does not establish their availability. The reviewed-operation
// positives and permissions are covered in subnet-http-admission.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/swap.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceById(id: string) {
  return registry.surfaces.find((surface: Row) => surface.id === id);
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
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init!.method;
        return new Response(BODY, {
          status: 200,
          headers: { "content-type": "text/yaml" },
        });
      }) as typeof fetch,
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
      readArtifact: async (_env: Row, path: string) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
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
    }) as typeof fetch;
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
        mockEnv(),
        deps,
      );
      const result = ((await response.json()) as Row).result;
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

  test("POST-only service keeps recurring read probes disabled", () => {
    assert.ok(SURFACE, "registry surface sn-10-taofi-api is present");
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.url, "https://taofi-api.web.app/");
    // Explicit source-reviewed calls do not enable recurring GET probes.
    assert.equal(SURFACE.probe?.enabled, false);
  });
});
