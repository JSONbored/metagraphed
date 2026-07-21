// SN7 (Allways) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7023, MCP execute Phase 1 follow-up #7014/#7215), covering the
// 25 registry surfaces #7023 lists beyond the API health endpoint --
// tests/allways-call-subnet-surface-verify.test.mjs already pins
// allways-api-health and is deliberately not duplicated here. Like that file,
// this pins SN7's *real* registry surface config
// (registry/subnets/allways.json) to the tool's contract, so a future edit
// that regresses callability (flipping to HEAD, marking a surface
// auth_required, disabling a probe) is caught here.
//
// Every surface below was live-verified 2026-07-21 with a direct GET against
// its curated URL:
// - the 23 subnet-api surfaces returned HTTP 200 application/json; the
//   fixtures mirror each observed body's shape (top-level object vs array,
//   real field names) rather than exact live values, since the data is live.
//   /swaps/active, /reservations and /reservations/active returned [] that
//   day -- their fixtures pin the array shape.
// - allways-sse (GET https://api.all-ways.io/sse) returned HTTP 200
//   text/event-stream and held the stream open (curl read 25 bytes and hit
//   its own timeout -- correct SSE behavior).
// - allways-swagger (GET https://api.all-ways.io/swagger) returned HTTP 200
//   text/html -- the Swagger UI page, matching its probe expect of html. The
//   openapi kind is not in OPERATIONAL_SURFACE_KINDS, so it is pinned at the
//   registry-config and callSubnetSurface level only and stays out of the
//   mocked operational-surfaces catalog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/allways.json", import.meta.url)),
    "utf8",
  ),
);

// The 23 no-auth GET JSON subnet-api surfaces from #7023's verify list, with
// a shape-faithful subset of each body observed live on 2026-07-21.
const JSON_SURFACES = {
  "allways-protocol-constants": { feeDivisor: 100 },
  "allways-protocol-chain-state": { asOf: 1784651156, slot: 434337512 },
  "allways-network-overview": {
    volumeSol: "85527382841",
    totalSwaps: 695,
    networkSuccessRate: 0.96,
    activeMiners: 26,
    pairMix: [{ pair: "SOL-BTC", pct: 2.8 }],
  },
  "allways-miners": [{ hotkey: "5HW4E2kR", uid: 3, sourceChain: "sol" }],
  "allways-miners-leaderboard": [
    { uid: 189, hotkey: "5EvkLKgQ", crownShare: 0.65, successRate: 0.97 },
  ],
  "allways-miners-reliability": [
    { minerHotkey: "5EvkLKgQ", sourceChain: "sol", completed: 13, total: 14 },
  ],
  "allways-events-latest": [
    { id: "33052", eventType: "QuoteSet", slot: "434337512", logIndex: 0 },
  ],
  "allways-crown": {
    "SOL-BTC": { uid: 81, hotkey: "5HJvAyPN", rate: 0.00096455, since: null },
  },
  "allways-crown-history": [
    { t: 1784644539, endedAt: 1784644686, uid: 81, rate: 0.00096433 },
  ],
  "sn-7-allways-subnet-api": [
    { swapId: "-2675050090441264570", seq: 696, status: "COMPLETED" },
  ],
  "sn-7-allways-history-api": [
    { t: "2026-06-21T00:00:00.000Z", volumeSol: "0", swaps: 0 },
  ],
  "sn-7-allways-history-state-api": [
    { t: "2026-06-21T00:00:00.000Z", activeNodes: 0, inFlight: 0 },
  ],
  "allways-network-stats": {
    totalSwaps: 669,
    totalVolumeSol: "85627382841",
    activeMiners: 26,
    activeSwaps: 0,
  },
  "allways-network-halt-state": { halted: false, asOf: 1784651156 },
  "allways-network-scoring-state": {
    lastScored: 1784648143,
    updatedAt: "2026-07-21T15:35:43.598Z",
  },
  "allways-swaps-active": [],
  "allways-swaps-count": { totalCount: 696 },
  "allways-events": [
    { id: "33052", eventType: "QuoteSet", slot: "434337512", logIndex: 0 },
  ],
  "allways-reservations": [],
  "allways-reservations-active": [],
  "allways-crown-time": {
    windowStart: 1784644544,
    windowEnd: 1784648143,
    windowSecs: 3599,
    holders: [{ uid: 81, crownSecs: 3370 }],
  },
  "allways-crown-rate-history": [{ t: 1784644539, rate: 0.00096433 }],
  "allways-history-rate": [{ t: "2026-06-21T00:00:00.000Z", rate: null }],
};

const SSE_SURFACE_ID = "allways-sse";
const OPENAPI_SURFACE_ID = "allways-swagger";
// First bytes of a text/event-stream response, as the live endpoint holds the
// stream open and the tool returns whatever text arrived before the cap.
const SSE_BODY = ": connected\n\nevent: message\ndata: {}\n\n";
const SWAGGER_HTML = "<!DOCTYPE html>\n<html><head><title>Swagger UI</title>";

function surfaceById(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN7 Allways call_subnet_surface verification beyond health (#7023)", () => {
  test("all 23 JSON subnet-api surfaces are present and configured to be callable", () => {
    for (const id of Object.keys(JSON_SURFACES)) {
      const surface = surfaceById(id);
      assert.ok(surface, `registry surface ${id} is present`);
      assert.equal(surface.kind, "subnet-api", id);
      assert.equal(surface.auth_required, false, id);
      assert.equal(surface.probe?.enabled, true, id);
      assert.equal(surface.probe?.method, "GET", id);
      // /swaps is registered with expect any; every other surface expects json.
      assert.equal(
        surface.probe?.expect,
        id === "sn-7-allways-subnet-api" ? "any" : "json",
        id,
      );
      // Single fixed endpoints -- no machine-readable schema is expected.
      assert.equal(surface.schema_url, undefined, id);
      assert.ok(
        surface.url.startsWith("https://api.all-ways.io/"),
        `${id} stays on the curated API host`,
      );
    }
  });

  test("the SSE surface is present and configured as a callable event stream", () => {
    const surface = surfaceById(SSE_SURFACE_ID);
    assert.ok(surface, `registry surface ${SSE_SURFACE_ID} is present`);
    assert.equal(surface.kind, "sse");
    assert.ok(OPERATIONAL_SURFACE_KINDS.includes(surface.kind));
    assert.equal(surface.auth_required, false);
    assert.equal(surface.probe?.enabled, true);
    assert.equal(surface.probe?.method, "GET");
    assert.equal(surface.probe?.expect, "sse");
    assert.equal(surface.url, "https://api.all-ways.io/sse");
  });

  test("the OpenAPI surface is pinned but stays out of the operational catalog", () => {
    const surface = surfaceById(OPENAPI_SURFACE_ID);
    assert.ok(surface, `registry surface ${OPENAPI_SURFACE_ID} is present`);
    assert.equal(surface.kind, "openapi");
    // Not an operational kind -- direct-call verified only, never resolved
    // through the operational-surfaces catalog.
    assert.equal(OPERATIONAL_SURFACE_KINDS.includes(surface.kind), false);
    assert.equal(surface.auth_required, false);
    // The URL serves the Swagger UI page, and the probe expects exactly that.
    assert.equal(surface.probe?.expect, "html");
    assert.equal(surface.url, "https://api.all-ways.io/swagger");
  });

  test("callSubnetSurface returns each JSON surface's body using its own url + GET", async () => {
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
      // The tool must call the curated URL exactly -- including the
      // ?direction=SOL-BTC query the crown/history surfaces carry.
      assert.equal(requestedUrl, surface.url, id);
      assert.equal(requestedMethod, "GET", id);
      assert.equal(result.status_code, 200, id);
      assert.equal(result.content_type, "application/json", id);
      assert.equal(result.truncated, false, id);
      assert.deepEqual(result.body, body, id);
    }
  });

  test("callSubnetSurface returns the SSE surface's stream prefix as capped text", async () => {
    const surface = surfaceById(SSE_SURFACE_ID);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        new Response(SSE_BODY, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "text/event-stream");
    // text/event-stream classifies as text, so the body comes back as the
    // raw stream prefix rather than parsed JSON.
    assert.equal(result.body, SSE_BODY);
  });

  test("callSubnetSurface returns the Swagger UI page as text for the openapi surface", async () => {
    const surface = surfaceById(OPENAPI_SURFACE_ID);
    const result = await callSubnetSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        new Response(SWAGGER_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "text/html; charset=utf-8");
    assert.equal(result.body, SWAGGER_HTML);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // Operational kinds only (subnet-api + sse) -- the openapi surface does
    // not belong in the operational-surfaces catalog.
    const operationalIds = [...Object.keys(JSON_SURFACES), SSE_SURFACE_ID];
    const catalog = {
      surfaces: operationalIds.map((id) => ({
        ...surfaceById(id),
        surface_id: id,
        netuid: 7,
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
