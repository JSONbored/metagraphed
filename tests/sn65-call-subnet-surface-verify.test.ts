// SN65 (TAO Private Network) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7078, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN65's *real* registry surface configs
// (registry/subnets/tao-private-network.json) to the tool's contract, so a
// future edit that regresses their callability is caught here.
//
// Live-verified 2026-07-21 (direct GET to the catalogued URLs):
//   sn-65-taofu-labs-subnet-api  GET https://api.taoprivatenetwork.com/api/v1/health
//     -> HTTP 200 application/json {"message":"OK!"}
//   sn-65-tpn-version            GET https://api.taoprivatenetwork.com/api/v1/version
//     -> HTTP 200 application/json {"version":"1.1.0","api":"v1"}
//   sn-65-taofu-labs-openapi     GET https://api.taoprivatenetwork.com/api-docs/openapi.json
//     -> HTTP 200 application/json (~32 KB) OpenAPI 3.0.0
//        info.title "TPN API", info.version "1.1.0", 13 paths
// Registry already matched reality -- no registry edit needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 65;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/tao-private-network.json", import.meta.url),
    ),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-65-taofu-labs-subnet-api",
    kind: "subnet-api",
    url: "https://api.taoprivatenetwork.com/api/v1/health",
    schemaUrl: undefined,
    body: { message: "OK!" },
    assertBody: (b: Row) => {
      assert.equal(b.message, "OK!");
    },
  },
  {
    id: "sn-65-tpn-version",
    kind: "subnet-api",
    url: "https://api.taoprivatenetwork.com/api/v1/version",
    schemaUrl: undefined,
    body: { version: "1.1.0", api: "v1" },
    assertBody: (b: Row) => {
      assert.equal(b.version, "1.1.0");
      assert.equal(b.api, "v1");
    },
  },
  {
    id: "sn-65-taofu-labs-openapi",
    kind: "openapi",
    url: "https://api.taoprivatenetwork.com/api-docs/openapi.json",
    schemaUrl: "https://api.taoprivatenetwork.com/api-docs/openapi.json",
    // Minimal fixture mirroring the live OpenAPI 3.0.0 document's stable
    // identity fields (full live body is ~32 KB -- assert shape, not bytes).
    body: {
      openapi: "3.0.0",
      info: { title: "TPN API", version: "1.1.0" },
      paths: {
        "/health": {
          get: {
            summary: "Health check",
            responses: { 200: { description: "OK" } },
          },
        },
        "/version": {
          get: {
            summary: "API version",
            responses: { 200: { description: "OK" } },
          },
        },
      },
    },
    assertBody: (b: Row) => {
      assert.equal(b.openapi, "3.0.0");
      assert.equal(b.info?.title, "TPN API");
      assert.equal(b.info?.version, "1.1.0");
      assert.ok(b.paths?.["/health"]?.get);
      assert.ok(b.paths?.["/version"]?.get);
    },
  },
];

function surfaceOf(id: string) {
  return registry.surfaces.find((surface: Row) => surface.id === id);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN65 TAO Private Network call_subnet_surface verification (#7078)", () => {
  for (const fixture of SURFACES) {
    test(`${fixture.id}: registry surface is callable`, () => {
      const surface = surfaceOf(fixture.id)!;
      assert.ok(surface, `registry surface ${fixture.id} is present`);
      assert.equal(surface.kind, fixture.kind);
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      assert.equal(surface.url, fixture.url);
      assert.equal(surface.schema_url, fixture.schemaUrl);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body`, async () => {
      const surface = surfaceOf(fixture.id)!;
      let requestedUrl: string | undefined;
      let requestedMethod: string | undefined;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          requestedUrl = String(url);
          requestedMethod = init!.method;
          return jsonResponse(fixture.body);
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body as Row);
    });

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const surface = surfaceOf(fixture.id)!;
      const catalog = {
        surfaces: [{ ...surface, surface_id: surface.id, netuid: NETUID }],
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
        return jsonResponse(fixture.body);
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
                arguments: { surface_id: fixture.id },
              },
            }),
          }),
          mockEnv(),
          deps,
        );
        const result = ((await response.json()) as Row).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, fixture.id);
        assert.equal(result.structuredContent.status_code, 200);
        fixture.assertBody(result.structuredContent.body as Row);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
