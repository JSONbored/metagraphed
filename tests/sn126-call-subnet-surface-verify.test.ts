// SN126 (Poker44) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7134, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN126's *real* registry surface config
// (registry/subnets/poker44.json) to the tool's contract, so a future edit
// that regresses its callability (flipping method, marking it auth_required,
// disabling its probe, changing the path) is caught here.
//
// The surface is the public no-auth platform health feed
// (GET https://api.poker44.net/health, JSON, no schema -- a single fixed
// endpoint). Verified live to return HTTP 200 application/json; charset=utf-8
// with `{success:true, data:{status:"healthy", services:{...}}}`. The fixture
// below mirrors that live response's top-level shape rather than fetching it,
// keeping the test hermetic while still exercising charset-suffixed JSON
// parsing against the upstream's actual field set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-126-poker44-health";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/poker44.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live https://api.poker44.net/health response.
const SN126_BODY = {
  success: true,
  data: {
    status: "healthy",
    timestamp: "2026-07-21T03:15:12.539Z",
    uptime: 479367.478391343,
    services: {
      database: { status: "connected", latency: 1 },
      redis: { status: "connected", latency: 0 },
    },
  },
};

function sn126Response() {
  return new Response(JSON.stringify(SN126_BODY), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("SN126 Poker44 call_subnet_surface verification (#7134)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://api.poker44.net/health");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init!.method;
        return sn126Response();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).success, true);
    assert.equal((result.body as Row).data.status, "healthy");
    assert.equal(
      (result.body as Row).data.services.database.status,
      "connected",
    );
    assert.equal((result.body as Row).data.services.redis.status, "connected");
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 126 }],
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
      return sn126Response();
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
              arguments: { surface_id: SURFACE_ID },
            },
          }),
        }),
        {},
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.success, true);
      assert.equal(result.structuredContent.body.data.status, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
