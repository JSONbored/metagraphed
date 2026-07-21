// SN123 (MANTIS) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7058, MCP execute Phase 1 follow-up #7014/#7215; issue #7131).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN123's *real* registry surface
// config (registry/subnets/mantis.json) to the tool's contract, so a future
// edit that regresses either surface's callability (flipping to HEAD, marking
// it auth_required, disabling its probe, moving the url) is caught here.
//
// The two surfaces are the MANTIS network console's own no-auth GET dashboard
// endpoints:
//   sn-123-mantis-dashboard-snap-meta      https://mantis123.com/dashboard/api/snap/meta
//   sn-123-mantis-dashboard-history-incentive
//                                          https://mantis123.com/dashboard/api/history/incentive
// Both single fixed endpoints (no machine-readable schema). Live-verified
// 2026-07-21: snap/meta returns HTTP 200 application/json object self-reporting
// netuid 123 (challenge roster, challenge_weights, emission_rules); incentive
// history returns HTTP 200 application/json array of {block, ts, inc} rows. The
// fixtures below mirror faithful subsets of those live responses rather than
// fetching them, keeping the tests hermetic while still exercising the tool's
// JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 123;
const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/mantis.json", import.meta.url)),
    "utf8",
  ),
);
const surfaceById = (id) =>
  registry.surfaces.find((surface) => surface.id === id);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Clones the SN44 verification shape (metagraphed#7289) for one MANTIS surface:
// pin the registry config, exercise callSubnetSurface directly, then resolve it
// end-to-end through the call_subnet_surface MCP tool by surface id.
function verifySurface({ surfaceId, url, body, assertBody }) {
  const SURFACE = surfaceById(surfaceId);

  describe(`SN123 MANTIS ${surfaceId} call_subnet_surface verification (#7058)`, () => {
    test("the registry surface exists and is configured to be callable", () => {
      assert.ok(SURFACE, `registry surface ${surfaceId} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      assert.equal(SURFACE.auth_required, false);
      assert.equal(SURFACE.probe?.enabled, true);
      // No-auth GET returning JSON.
      assert.equal(SURFACE.probe?.method, "GET");
      assert.equal(SURFACE.probe?.expect, "json");
      assert.equal(SURFACE.url, url);
      // Single fixed endpoint -- no machine-readable schema is expected.
      assert.equal(SURFACE.schema_url, undefined);
    });

    test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(SURFACE, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (fetchUrl, init) => {
          requestedUrl = String(fetchUrl);
          requestedMethod = init.method;
          return jsonResponse(body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, SURFACE.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assertBody(result.body);
    });

    test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
      const catalog = {
        surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
      };
      const deps = {
        readArtifact: async (_env, path) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: catalog }
            : { ok: false, status: 404 },
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const requestUrl = String(input);
        if (requestUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(JSON.stringify({ Status: 0 }), {
            headers: { "content-type": "application/dns-json" },
          });
        }
        return jsonResponse(body);
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
                arguments: { surface_id: surfaceId },
              },
            }),
          }),
          {},
          deps,
        );
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.surface_id, surfaceId);
        assert.equal(result.structuredContent.status_code, 200);
        assertBody(result.structuredContent.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

// snap/meta: a challenge/emission metadata object that self-reports netuid 123.
verifySurface({
  surfaceId: "sn-123-mantis-dashboard-snap-meta",
  url: "https://mantis123.com/dashboard/api/snap/meta",
  body: {
    netuid: 123,
    challenge_weights: { ETH: 1.0, ETHHITFIRST: 1.25, BTCLBFGS: 2.875 },
    total_weight: 42.5,
    emission_rules: { burn_pct: 0.35, young_threshold_blocks: 36000 },
  },
  assertBody: (responseBody) => {
    assert.equal(responseBody.netuid, 123);
    assert.equal(typeof responseBody.challenge_weights, "object");
    assert.equal(typeof responseBody.emission_rules, "object");
  },
});

// history/incentive: a per-block time series of {block, ts, inc} rows, where
// inc is a UID-keyed incentive map (no wallet/hotkey data).
verifySurface({
  surfaceId: "sn-123-mantis-dashboard-history-incentive",
  url: "https://mantis123.com/dashboard/api/history/incentive",
  body: [
    { block: 8581373, ts: 1783572212, inc: { 0: 0.46656, 1: 0.000168 } },
    { block: 8581500, ts: 1783572980, inc: { 0: 0.41205, 1: 0.000205 } },
  ],
  assertBody: (responseBody) => {
    assert.ok(Array.isArray(responseBody));
    assert.equal(typeof responseBody[0].block, "number");
    assert.equal(typeof responseBody[0].inc, "object");
  },
});
