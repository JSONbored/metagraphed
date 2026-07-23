// SN53 (EfficientFrontier) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7066, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN53's *real* no-auth GET JSON registry
// surface (registry/subnets/efficientfrontier.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-53-taomarketcap-subnet-api  GET https://api.taomarketcap.com/public/v1/subnets/53/
//     -> TaoMarketCap subnet snapshot JSON (netuid 53)
// Issue #7066 lists this single surface only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-53-taomarketcap-subnet-api";
const NETUID = 53;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/efficientfrontier.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

const BODY = {
  id: "53",
  netuid: 53,
  is_active: true,
  latest_snapshot: { id: "8668427-53", netuid: 53 },
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN53 EfficientFrontier call_subnet_surface verification (#7066)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(
      SURFACE.url,
      "https://api.taomarketcap.com/public/v1/subnets/53/",
    );
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the TaoMarketCap JSON body via GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init!.method;
        return jsonResponse(BODY);
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).netuid, 53);
    assert.equal((result.body as Row).latest_snapshot.netuid, 53);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
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
      return jsonResponse(BODY);
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
      assert.equal(result.structuredContent.body.netuid, 53);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
