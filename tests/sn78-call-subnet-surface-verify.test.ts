// SN78 (Vocence) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7091, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN78's *real* registry surface configs
// (registry/subnets/vocence.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Live-verified 2026-07-21 (direct GET to the catalogued URLs):
//   sn-78-vocence-subnet-api  GET https://api.vocence.ai/health
//     -> HTTP 200 application/json
//        {"status":"ok","service":"vocence-developer-api"}
//   sn-78-vocence-openapi     GET https://api.vocence.ai/openapi.json
//     -> HTTP 200 application/json (~88 KB) OpenAPI 3.1.0
//        info.title "Vocence Developer API", paths includes /health
// Registry already matched reality -- no registry edit needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 78;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/vocence.json", import.meta.url)),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-78-vocence-subnet-api",
    kind: "subnet-api",
    url: "https://api.vocence.ai/health",
    schemaUrl: undefined,
    // Faithful copy of the live /health body.
    body: { status: "ok", service: "vocence-developer-api" },
    assertBody: (b: Row) => {
      assert.equal(b.status, "ok");
      assert.equal(b.service, "vocence-developer-api");
    },
  },
  {
    id: "sn-78-vocence-openapi",
    kind: "openapi",
    url: "https://api.vocence.ai/openapi.json",
    schemaUrl: "https://api.vocence.ai/openapi.json",
    // Minimal fixture mirroring the live OpenAPI 3.1.0 document's stable
    // identity fields (full live body is ~88 KB -- assert shape, not bytes).
    body: {
      openapi: "3.1.0",
      info: {
        title: "Vocence Developer API",
        version: "1.1.0",
        contact: { name: "Vocence", url: "https://www.vocence.ai/docs/api" },
      },
      paths: {
        "/health": {
          get: {
            summary: "Health",
            operationId: "health_health_get",
            responses: { 200: { description: "Successful Response" } },
          },
        },
      },
    },
    assertBody: (b: Row) => {
      assert.equal(b.openapi, "3.1.0");
      assert.equal(b.info?.title, "Vocence Developer API");
      assert.equal(typeof b.info?.version, "string");
      assert.ok(b.paths?.["/health"]?.get);
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

describe("SN78 Vocence call_subnet_surface verification (#7091)", () => {
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
