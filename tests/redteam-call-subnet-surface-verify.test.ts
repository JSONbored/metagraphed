// SN61 (RedTeam) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7074, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN61's two issue-scoped
// registry surfaces (registry/subnets/redteam.json) to the tool's contract,
// so a future edit that regresses their callability (flipping to HEAD,
// marking them auth_required, disabling their probe) is caught here.
//
// Live-verified 2026-07-21:
//   - sn-61-redteam-health: GET https://dashboard.theredteam.io/healthz ->
//     200 text/html "ok" (plain liveness text, not JSON).
//   - sn-61-redteam-openapi: GET
//     https://cdn.jsdelivr.net/gh/RedTeamSubnet/rest-dfp-proxy@main/docs/pages/api-docs/openapi.json
//     -> 200 application/json, ~21 KB OpenAPI 3.1 document (title "Device
//     Fingerprinter Gate").
// The fixtures below mirror those live responses rather than fetching
// them, keeping the test hermetic while still exercising both the text
// (non-JSON) and JSON parse-and-return paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/redteam.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceById(id: string) {
  return registry.surfaces.find((surface: Row) => surface.id === id);
}

const CASES = [
  {
    id: "sn-61-redteam-health",
    url: "https://dashboard.theredteam.io/healthz",
    kind: "subnet-api",
    expect: "any",
    contentType: "text/html",
    body: "ok",
  },
  {
    id: "sn-61-redteam-openapi",
    url: "https://cdn.jsdelivr.net/gh/RedTeamSubnet/rest-dfp-proxy@main/docs/pages/api-docs/openapi.json",
    kind: "openapi",
    expect: "json",
    contentType: "application/json",
    body: { openapi: "3.1.0", info: { title: "Device Fingerprinter Gate" } },
  },
];

for (const { id, url, kind, expect, contentType, body } of CASES) {
  const isJson = contentType === "application/json";

  describe(`SN61 RedTeam call_subnet_surface verification: ${id} (#7074)`, () => {
    const SURFACE = surfaceById(id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${id} is present`);
      assert.equal(SURFACE.kind, kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, expect);
      assert.equal(SURFACE.url, url);
    });

    test("callSubnetSurface returns the real body using the surface's own url + GET", async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const responseBody = isJson ? JSON.stringify(body) : (body as string);
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (reqUrl, init) => {
          requestedUrl = String(reqUrl);
          requestedMethod = init!.method;
          return new Response(responseBody, {
            status: 200,
            headers: { "content-type": contentType },
          });
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, contentType);
      assert.equal(result.truncated, false);
      if (isJson) {
        assert.deepEqual(result.body, body);
      } else {
        assert.equal(result.body, body);
      }
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 61 }],
      };
      const deps = {
        readArtifact: async (_env: Row, path: string) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      const originalFetch = globalThis.fetch;
      const responseBody = isJson ? JSON.stringify(body) : (body as string);
      globalThis.fetch = async (input) => {
        const reqUrl = String(input);
        if (reqUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": contentType },
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
                arguments: { surface_id: id },
              },
            }),
          }),
          mockEnv(),
          deps,
        );
        const result = ((await response.json()) as Row).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, id);
        assert.equal(result.structuredContent.status_code, 200);
        if (isJson) {
          assert.deepEqual(result.structuredContent.body, body);
        } else {
          assert.equal(result.structuredContent.body, body);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}
