// SN115 (HashiChain) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7126, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN115's *real* registry surface config
// (registry/subnets/hashichain.json) to the tool's contract, so a future edit
// that regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe, moving the URL) is caught here.
//
// The surface is the public no-auth TaoMarketCap SN115 snapshot API
// (GET https://api.taomarketcap.com/public/v1/subnets/115/, JSON, no schema --
// a single fixed endpoint). Live-verified 2026-07-21 to return HTTP 200
// application/json { id, netuid: 115, created_at_block, registered_at,
// is_active, latest_snapshot: { id, netuid, ... }, ... }. The fixture below
// mirrors that live response's shape rather than fetching it, keeping the test
// hermetic. (The snapshot is live chain data, so the test asserts the stable
// shape, not its exact values.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-115-taomarketcap-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/hashichain.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

// A faithful subset of the live https://api.taomarketcap.com/public/v1/subnets/115/
// response body.
const SN115_BODY = {
  id: "115",
  netuid: 115,
  created_at_block: 5683635,
  registered_at: "2025-06-01T06:02:00+00:00",
  is_active: true,
  is_subsidized: false,
  mechanism_count: 1,
  latest_snapshot: {
    id: "8667905-115",
    netuid: 115,
    max_allowed_uids: 256,
    subnet_owner_hotkey: "5EhTo9AXu6JCK2voyEz2ftwFq9cmYR1ACj8qobD67MGZKgTV",
  },
};

function sn115Response() {
  return new Response(JSON.stringify(SN115_BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN115 HashiChain call_subnet_surface verification (#7126)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    // No-auth GET returning JSON (TaoMarketCap rejects HEAD with 405).
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(
      SURFACE.url,
      "https://api.taomarketcap.com/public/v1/subnets/115/",
    );
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return sn115Response();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    // Per-subnet snapshot object -- assert the stable shape, not exact values.
    assert.equal(result.body.netuid, 115);
    assert.equal(typeof result.body.id, "string");
    assert.equal(typeof result.body.is_active, "boolean");
    assert.equal(typeof result.body.latest_snapshot, "object");
    assert.equal(result.body.latest_snapshot.netuid, 115);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 115 }],
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
      // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return sn115Response();
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
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.netuid, 115);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
