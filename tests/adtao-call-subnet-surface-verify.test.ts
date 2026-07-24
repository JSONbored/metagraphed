// SN21 (AdTAO) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7037, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN21's two issue-scoped
// registry surfaces (registry/subnets/adtao.json) to the tool's contract,
// so a future edit that regresses their callability (flipping to HEAD,
// marking them auth_required, disabling their probe) is caught here.
//
// Both are public no-auth GET JSON endpoints on the official validator
// host. Live-verified 2026-07-21:
//   - sn-21-adtao-validator-openapi: GET
//     https://validator.adtao.io/openapi.json -> 200 application/json,
//     ~15.8 KB OpenAPI 3.1.0 document (title "SN21 Validator").
//   - sn-21-adtao-validator-api: GET https://validator.adtao.io/health ->
//     200 application/json, live service status.
// The fixtures below mirror those live responses rather than fetching
// them, keeping the test hermetic while still exercising the JSON
// parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const registry: Row = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/adtao.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceById(id: string) {
  return registry.surfaces.find((surface: Row) => surface.id === id);
}

const OPENAPI_URL = "https://validator.adtao.io/openapi.json";

const CASES = [
  {
    id: "sn-21-adtao-validator-openapi",
    url: OPENAPI_URL,
    kind: "openapi",
    body: {
      openapi: "3.1.0",
      info: { title: "SN21 Validator", version: "0.1.0" },
    },
  },
  {
    id: "sn-21-adtao-validator-api",
    url: "https://validator.adtao.io/health",
    kind: "subnet-api",
    body: {
      status: "ok",
      service: "sn21-validator",
      current_epoch: "WR-2026-W30-PUB-E1",
      episodes_loaded: 185,
      predictions_received: 0,
      submission_open: true,
    },
  },
];

for (const { id, url, kind, body } of CASES) {
  describe(`SN21 AdTAO call_subnet_surface verification: ${id} (#7037)`, () => {
    const SURFACE = surfaceById(id);

    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${id} is present`);
      assert.equal(SURFACE.kind, kind);
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, url);
      // Both surfaces are documented as "has captured schema" -- describing
      // routes on the shared SN21 validator OpenAPI document.
      assert.equal(SURFACE.schema_url, OPENAPI_URL);
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (reqUrl, init) => {
          requestedUrl = String(reqUrl);
          requestedMethod = init?.method;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assert.deepEqual(result.body, body);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 21 }],
      };
      const deps = {
        readArtifact: async (_env: Row, path: string) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const reqUrl = String(input);
        if (reqUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
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
          {} as unknown as Env,
          deps,
        );
        const result = ((await response.json()) as Row).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, id);
        assert.equal(result.structuredContent.status_code, 200);
        assert.deepEqual(result.structuredContent.body, body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}
