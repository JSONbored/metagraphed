// SN95 (Actual) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7107, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN95's *real* no-auth GET JSON
// registry surfaces (registry/subnets/actual.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-95-actual-health                 GET https://actual.inc/api/health
//     -> {"status":"ok"}
//   sn-95-actual-model-registry-index   GET https://models.actual.inc/index.json
//     -> {schemaVersion, generatedAt, registry, models:[...]}
// HTML website / llms.txt (expect "any") surfaces are out of scope here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 95;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/actual.json", import.meta.url)),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-95-actual-health",
    kind: "subnet-api",
    url: "https://actual.inc/api/health",
    body: { status: "ok" },
    assertBody: (b) => {
      assert.equal(b.status, "ok");
    },
  },
  {
    id: "sn-95-actual-model-registry-index",
    kind: "data-artifact",
    url: "https://models.actual.inc/index.json",
    body: {
      schemaVersion: "actual.modelRegistry.publicIndex.v1",
      generatedAt: "2026-07-21T00:00:00.000Z",
      registry: {},
      models: [{ id: "fixture-model", format: "gguf" }],
    },
    assertBody: (b) => {
      assert.equal(b.schemaVersion, "actual.modelRegistry.publicIndex.v1");
      assert.ok(Array.isArray(b.models));
      assert.ok(b.models.length >= 1);
    },
  },
];

function surfaceOf(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN95 Actual call_subnet_surface verification (#7107)", () => {
  for (const fixture of SURFACES) {
    test(`${fixture.id}: registry surface is callable`, () => {
      const surface = surfaceOf(fixture.id);
      assert.ok(surface, `registry surface ${fixture.id} is present`);
      assert.equal(surface.kind, fixture.kind);
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      assert.equal(surface.url, fixture.url);
      assert.equal(surface.schema_url, undefined);
    });

    test(`${fixture.id}: callSubnetSurface returns the real JSON body`, async () => {
      const surface = surfaceOf(fixture.id);
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(fixture.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.truncated, false);
      fixture.assertBody(result.body);
    });

    test(`${fixture.id}: end-to-end MCP tools/call by surface id`, async () => {
      const surface = surfaceOf(fixture.id);
      const catalog = {
        surfaces: [{ ...surface, surface_id: surface.id, netuid: NETUID }],
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
        return jsonResponse(fixture.body);
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
                arguments: { surface_id: fixture.id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, fixture.id);
        assert.equal(result.structuredContent.status_code, 200);
        fixture.assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
