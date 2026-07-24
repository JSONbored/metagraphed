// SN107 (Minos) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7118, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN107's *real* no-auth GET JSON
// registry surfaces (registry/subnets/minos.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-107-minos-subnet-api         GET https://api.theminos.ai/health
//     -> {"status":"healthy","version":"2.0.0","mode":"active"}
//   sn-107-taomarketcap-subnet-api  GET https://api.taomarketcap.com/public/v1/subnets/107/
//     -> TaoMarketCap subnet snapshot JSON (netuid 107)
// The MCP JSON-RPC surface (sn-107-minos-mcp) is out of scope for this
// GET/json verification pattern.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const NETUID = 107;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/minos.json", import.meta.url)),
    "utf8",
  ),
);

const SURFACES = [
  {
    id: "sn-107-minos-subnet-api",
    url: "https://api.theminos.ai/health",
    body: { status: "healthy", version: "2.0.0", mode: "active" },
    assertBody: (b: Row) => {
      assert.equal(b.status, "healthy");
      assert.equal(b.mode, "active");
    },
  },
  {
    id: "sn-107-taomarketcap-subnet-api",
    url: "https://api.taomarketcap.com/public/v1/subnets/107/",
    body: {
      id: "107",
      netuid: 107,
      is_active: true,
      latest_snapshot: { id: "8667000-107", netuid: 107 },
    },
    assertBody: (b: Row) => {
      assert.equal(b.netuid, 107);
      assert.equal(b.latest_snapshot.netuid, 107);
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

describe("SN107 Minos call_subnet_surface verification (#7118)", () => {
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
