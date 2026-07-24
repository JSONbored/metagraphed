// SN112 (minotaur) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7123, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN112's *real* registry surface configs
// (registry/subnets/minotaur.json) to the tool's contract, so a future edit
// that regresses their callability is caught here.
//
// Both surfaces are public no-auth GET JSON feeds (single fixed endpoints,
// no schema). Live-verified 2026-07-21:
//   sn-112-minotaur-health    GET https://api.minotaursubnet.com/health
//     -> {"status":"ok","service":"app-intents-api",...}
//   sn-112-minotaur-apps-list GET https://api.minotaursubnet.com/v1/apps/
//     -> {"apps":[{app_id,name,version,...},...]}
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 112;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/minotaur.json", import.meta.url),
    ),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-112-minotaur-health",
    url: "https://api.minotaursubnet.com/health",
    body: {
      status: "ok",
      service: "app-intents-api",
      image_sha: "c9e5fd9",
      benchmark_worker: "disabled",
    },
    assertBody: (b: Row) => {
      assert.equal(b.status, "ok");
      assert.equal(b.service, "app-intents-api");
    },
  },
  {
    id: "sn-112-minotaur-apps-list",
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
    assertBody: (b: Row) => {
      assert.ok(Array.isArray(b.apps));
      assert.equal(b.apps[0].name, "DexAggregatorApp");
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

describe("SN112 minotaur call_subnet_surface verification (#7123)", () => {
  for (const fixture of SURFACES) {
    test(`${fixture.id}: registry surface is callable`, () => {
      const surface = surfaceOf(fixture.id)!;
      assert.ok(surface, `registry surface ${fixture.id} is present`);
      assert.equal(surface.kind, "subnet-api");
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      assert.equal(surface.url, fixture.url);
      assert.equal(surface.schema_url, undefined);
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
