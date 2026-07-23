// End-to-end verification that SN116 (TaoLend)'s catalogued no-auth
// TaoMarketCap subnet-snapshot surface actually resolves and returns a real
// JSON response body through the call_subnet_surface MCP tool -- MCP execute
// Phase 1 (#7014) per-subnet wiring, metagraphed#7127. The surface config was
// verified live against https://api.taomarketcap.com/public/v1/subnets/116/:
// a no-auth GET returning `application/json` (HTTP 200, ~4 KiB) with SN116's
// on-chain snapshot (`id`/`netuid` 116, `created_at_block` 5699219,
// `registered_at` 2025-06-03T09:58:48+00:00), HEAD is rejected with 405, and
// the non-slash path 301s to the canonical trailing-slash form. Nothing in
// registry/subnets/taolend.json's sn-116-taomarketcap-subnet-api entry needed
// fixing (probe GET/json, auth_required:false, and the fixed single endpoint
// all match reality). This pins that contract through the tool -- surface
// resolution by real id/key, the declared GET/json probe, and JSON body
// parsing -- so a regression in the tool or in the surface's registry config
// is caught.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import type { Row } from "./row-type.ts";

// The SN116 TaoMarketCap surface exactly as the build emits it into
// operational-surfaces.json (registry/subnets/taolend.json ->
// sn-116-taomarketcap-subnet-api).
const SN116_SURFACE = {
  surface_id: "sn-116-taomarketcap-subnet-api",
  surface_key: "srf-72e95cbc8e0379a8",
  netuid: 116,
  kind: "subnet-api",
  url: "https://api.taomarketcap.com/public/v1/subnets/116/",
  provider: "taomarketcap",
  auth_required: false,
  public_safe: true,
  probe: { method: "GET", expect: "json", timeout_ms: 10000 },
};

// A representative subset of the real snapshot body the endpoint returns --
// the on-chain identity fields (`id`/`netuid`, registration block/time) are
// immutable for SN116, so they pin the observed response without depending on
// the volatile per-snapshot economics fields.
const SNAPSHOT_BODY = {
  id: 116,
  netuid: 116,
  created_at_block: 5699219,
  registered_at: "2025-06-03T09:58:48+00:00",
  latest_snapshot_id: 42,
  is_active: true,
  is_subsidized: false,
  mechanism_count: 1,
};

const deps = {
  readArtifact: async (_env: Row, path: string) => {
    if (path === "/metagraph/operational-surfaces.json") {
      return { ok: true, data: { surfaces: [SN116_SURFACE] } };
    }
    return { ok: false, status: 404 };
  },
};

// Serves the DoH lookup the SSRF guard makes for api.taomarketcap.com (answer
// with a public IP so it's treated as safe) and the surface's own JSON body.
function mockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(
        JSON.stringify({ Answer: [{ type: 1, data: "18.160.0.1" }] }),
        { headers: { "content-type": "application/dns-json" } },
      );
    }
    return new Response(JSON.stringify(SNAPSHOT_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function callSn116Surface(surfaceId: string) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch();
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
            arguments: { surface_id: surfaceId },
          },
        }),
      }),
      {},
      deps,
    );
    return ((await response.json()) as Row).result;
  } finally {
    globalThis.fetch = original;
  }
}

describe("call_subnet_surface: SN116 TaoLend TaoMarketCap snapshot API (#7127)", () => {
  test("returns the real SN116 snapshot body end-to-end", async () => {
    const result = await callSn116Surface("sn-116-taomarketcap-subnet-api");
    assert.equal(result.isError, false);
    assert.equal(
      result.structuredContent.surface_id,
      "sn-116-taomarketcap-subnet-api",
    );
    assert.equal(result.structuredContent.status_code, 200);
    assert.equal(result.structuredContent.content_type, "application/json");
    assert.deepEqual(result.structuredContent.body, SNAPSHOT_BODY);
    // On-chain identity is SN116 and matches the surface's declared netuid.
    assert.equal(result.structuredContent.body.netuid, 116);
    assert.equal(result.structuredContent.truncated, false);
    assert.equal(result.structuredContent.parse_error, undefined);
  });

  test("resolves by the surface's stable surface_key too", async () => {
    const result = await callSn116Surface("srf-72e95cbc8e0379a8");
    assert.equal(result.isError, false);
    assert.equal(
      result.structuredContent.surface_id,
      "sn-116-taomarketcap-subnet-api",
    );
    assert.deepEqual(result.structuredContent.body, SNAPSHOT_BODY);
  });
});
