// SN30 (Endure Network) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7058, MCP execute Phase 1 follow-up #7014/#7215; issue
// #7046). Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool
// wiring with synthetic surfaces -- this file pins SN30's *real* registry
// surface config (registry/subnets/endure-network.json) to the tool's contract,
// so a future edit that regresses its callability (flipping to HEAD, marking it
// auth_required, disabling its probe, moving the url) is caught here.
//
// The surface is the public no-auth SN30 indexed subnet feed on TaoMarketCap
// (sn-30-taomarketcap-subnet-api, GET
// https://api.taomarketcap.com/public/v1/subnets/30/, JSON, single fixed
// endpoint -- no schema). Live-verified 2026-07-21 to return HTTP 200
// application/json -- an object self-reporting netuid 30 (id, is_active,
// mechanism_count, latest_snapshot). The fixture below mirrors that live
// response rather than fetching it, keeping the test hermetic while still
// exercising the tool's JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-30-taomarketcap-subnet-api";
const NETUID = 30;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/endure-network.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live SN30 TaoMarketCap subnet feed.
const BODY = {
  id: "30",
  netuid: 30,
  is_active: true,
  mechanism_count: 1,
  latest_snapshot_id: "8667931-30",
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN30 Endure Network call_subnet_surface verification (#7058)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    // No-auth GET returning JSON.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(
      SURFACE.url,
      "https://api.taomarketcap.com/public/v1/subnets/30/",
    );
    // Single fixed endpoint -- no machine-readable schema is expected.
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
        return upstreamResponse();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).netuid, NETUID);
    assert.equal(typeof (result.body as Row).is_active, "boolean");
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
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return upstreamResponse();
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
              arguments: { surface_id: SURFACE_ID },
            },
          }),
        }),
        {} as unknown as Env,
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.netuid, NETUID);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
