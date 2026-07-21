// SN96 (Verathos) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7108, MCP execute Phase 1 follow-up #7014/#7215),
// covering the 10 registry surfaces #7108 lists beyond the health endpoint --
// tests/verathos-call-subnet-surface-verify.test.mjs already pins
// sn-96-verathos-health and is deliberately not duplicated here. Like that
// file, this pins SN96's *real* registry surface config
// (registry/subnets/verathos.json) to the tool's contract, so a future edit
// that regresses callability is caught here.
//
// Every surface below was live-verified 2026-07-21 with a direct request
// against its curated URL:
// - 6 subnet-api surfaces returned HTTP 200 application/json; the fixtures
//   mirror each observed body's shape (real top-level field names), not
//   exact live values.
// - Both openapi surfaces answered HEAD with HTTP 200 application/json,
//   matching their registry probes (method HEAD, expect json).
// - Two surfaces exposed real behavior worth pinning:
//   * sn-96-verathos-network-stats returned ~344 KB of JSON
//     (size_download=344287), over the tool's 256 KiB cap -- the body comes
//     back truncated as unparsed text with a parse_error.
//   * sn-96-verathos-subnet-api (/v1/supply/circulating) answered HTTP 503
//     text/plain "supply data warming up" on repeated attempts -- the
//     capacity-dependent flakiness #7108's gap notes already document for
//     this host. The tool does not gate on status, so it faithfully relays
//     the 503 with the raw text body.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  callSubnetSurface,
  MAX_RESPONSE_BYTES,
} from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/verathos.json", import.meta.url),
    ),
    "utf8",
  ),
);

// The 6 no-auth GET JSON subnet-api surfaces from #7108's verify list that
// answered cleanly, with a shape-faithful subset of each body observed live
// on 2026-07-21.
const JSON_SURFACES = {
  "sn-96-verathos-models-api": {
    object: "list",
    data: [
      {
        id: "qwen3.5-9b",
        name: "Qwen3.5-9B",
        architecture: "dense",
        total_params_b: 9.0,
        input_usd_per_1m: 0.08,
      },
    ],
  },
  "sn-96-verathos-supply-info": {
    circulating: 0.0,
    total: 21000000.0,
    max: 21000000.0,
    price_tao: 0.0,
    netuid: 96,
  },
  "sn-96-verathos-protocol-health": { status: "ok", mode: "proxy" },
  "sn-96-verathos-models-status": {
    loaded: true,
    mode: "chain",
    preset_id: "qwen3.6-27b",
    num_layers: 64,
    quant_label: "fp8",
    is_moe: false,
  },
  "sn-96-verathos-capacity-audit-health": {
    status: "ok",
    service: "verathos-validator-proxy",
    capacity_audit: true,
    backend_status: 200,
  },
  "sn-96-verathos-price-quote": {
    model: "qwen2.5-7b-instruct",
    input_tokens: 1000,
    output_tokens: 500,
    verified: false,
    cost_usd: 0.00015,
  },
};

const NETWORK_STATS_ID = "sn-96-verathos-network-stats";
const CIRCULATING_ID = "sn-96-verathos-subnet-api";
const OPENAPI_IDS = [
  "sn-96-verathos-openapi",
  "sn-96-verathos-validator-proxy-openapi",
];

// One element of the live /v1/network/stats miners array, repeated until the
// payload crosses the tool's byte cap the way the ~344 KB live body does.
const NETWORK_STATS_MINER = {
  address: "0xccaf1A04C1e85CBbb36Dbac475dAa13a6353d046",
  ss58_address: "5EbbbnWanPgk1iBptNjBpBSkVC3JFHB5JGsMoAXNFJ5UWsE7",
  uid: 39,
  endpoint: "https://195.26.233.89:4039",
};
// Exact body observed live from /v1/supply/circulating alongside its 503.
const CIRCULATING_BODY = "supply data warming up";

function surfaceById(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN96 Verathos call_subnet_surface verification beyond health (#7108)", () => {
  test("the 8 no-auth GET subnet-api surfaces are present and configured to be callable", () => {
    for (const id of [
      ...Object.keys(JSON_SURFACES),
      NETWORK_STATS_ID,
      CIRCULATING_ID,
    ]) {
      const surface = surfaceById(id);
      assert.ok(surface, `registry surface ${id} is present`);
      assert.equal(surface.kind, "subnet-api", id);
      assert.equal(surface.auth_required, false, id);
      assert.equal(surface.probe?.enabled, true, id);
      assert.equal(surface.probe?.method, "GET", id);
      assert.equal(surface.probe?.expect, "json", id);
    }
  });

  test("both OpenAPI surfaces probe via HEAD and carry their captured schema_url", () => {
    for (const id of OPENAPI_IDS) {
      const surface = surfaceById(id);
      assert.ok(surface, `registry surface ${id} is present`);
      assert.equal(surface.kind, "openapi", id);
      assert.equal(surface.auth_required, false, id);
      assert.equal(surface.probe?.enabled, true, id);
      assert.equal(surface.probe?.method, "HEAD", id);
      assert.equal(surface.probe?.expect, "json", id);
      assert.equal(surface.schema_url, surface.url, id);
    }
  });

  test("callSubnetSurface returns each clean JSON surface's body using its own url + GET", async () => {
    for (const [id, body] of Object.entries(JSON_SURFACES)) {
      const surface = surfaceById(id);
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return jsonResponse(body);
        },
      });
      assert.equal(result.ok, true, id);
      assert.equal(requestedUrl, surface.url, id);
      assert.equal(requestedMethod, "GET", id);
      assert.equal(result.status_code, 200, id);
      assert.equal(result.content_type, "application/json", id);
      assert.equal(result.truncated, false, id);
      assert.deepEqual(result.body, body, id);
    }
  });

  test("callSubnetSurface answers HEAD for both OpenAPI surfaces with an empty body", async () => {
    for (const id of OPENAPI_IDS) {
      const surface = surfaceById(id);
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (_url, init) => {
          requestedMethod = init.method;
          // Live HEAD answered 200 application/json with no body.
          return new Response(null, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(requestedMethod, "HEAD", id);
      assert.equal(result.ok, true, id);
      assert.equal(result.status_code, 200, id);
      assert.equal(result.content_type, "application/json", id);
      assert.equal(result.body, "", id);
    }
  });

  test("callSubnetSurface truncates the oversized /v1/network/stats body", async () => {
    const surface = surfaceById(NETWORK_STATS_ID);
    const miners = [];
    while (JSON.stringify({ miners }).length <= MAX_RESPONSE_BYTES) {
      miners.push(NETWORK_STATS_MINER);
    }
    const oversized = JSON.stringify({ miners });
    assert.ok(oversized.length > MAX_RESPONSE_BYTES);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        new Response(oversized, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    // Live body was ~344 KB -- over MAX_RESPONSE_BYTES -- so the real
    // surface currently comes back truncated: unparsed text plus a
    // parse_error.
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, true);
    assert.equal(typeof result.body, "string");
    assert.ok(result.parse_error);
  });

  test("callSubnetSurface relays /v1/supply/circulating's capacity 503 as text", async () => {
    const surface = surfaceById(CIRCULATING_ID);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        // Live: HTTP 503 text/plain "supply data warming up" on repeated
        // attempts -- the capacity-dependent state #7108's gap notes
        // document for this host.
        new Response(CIRCULATING_BODY, {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    });
    // The tool does not gate on status -- it faithfully relays the 503 and
    // the plain-text body so an agent can see the upstream state.
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 503);
    assert.equal(result.content_type, "text/plain; charset=utf-8");
    assert.equal(result.body, CIRCULATING_BODY);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // Operational subnet-api surfaces only -- the openapi kind stays out of
    // the operational-surfaces catalog.
    const catalog = {
      surfaces: Object.keys(JSON_SURFACES).map((id) => ({
        ...surfaceById(id),
        surface_id: id,
        netuid: 96,
      })),
    };
    const deps = {
      readArtifact: async (_env, path) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const originalFetch = globalThis.fetch;
    try {
      for (const [id, body] of Object.entries(JSON_SURFACES)) {
        globalThis.fetch = async (input) => {
          const url = String(input);
          if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
            return new Response(JSON.stringify({ Status: 0 }), {
              headers: { "content-type": "application/dns-json" },
            });
          }
          return jsonResponse(body);
        };
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
                arguments: { surface_id: id },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false, id);
        assert.equal(result.structuredContent.surface_id, id, id);
        assert.equal(result.structuredContent.status_code, 200, id);
        assert.deepEqual(result.structuredContent.body, body, id);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
