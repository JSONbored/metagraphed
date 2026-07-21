// SN124 (Swarm) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7132, MCP execute Phase 1 follow-up #7014/#7215). Like
// tests/sn92-call-subnet-surface-verify.test.mjs, this pins SN124's *real*
// registry surface config (registry/subnets/swarm.json) to the tool's
// contract so a future edit that regresses callability (flipping to HEAD,
// marking it auth_required, disabling its probe) is caught here.
//
// Live-verified 2026-07-21 against api.swarm124.com:
//   GET /health      -> HTTP 200 application/json {"status":"healthy"}
//   GET /leaderboard -> HTTP 200 application/json {"entries":[…]}
//   HEAD on both     -> 405 (allow: GET), so the probe correctly declares GET.
//
// The third surface the issue listed for verification,
// sn-124-swarm-kings-diagnostics (GET /kings/diagnostics), was found dead:
// the path collides with the backend's `/kings/{lineage_id}` integer route, so
// GET returns HTTP 422 ("Input should be a valid integer … input: diagnostics")
// -- there is no /kings/diagnostics endpoint (the public host exposes /health,
// /leaderboard, /kings/active, /champion, /version; docs/king_of_the_hill.md
// documents no such route). That surface has been removed from swarm.json; the
// guard below pins its absence so it is not re-added.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/swarm.json", import.meta.url)),
    "utf8",
  ),
);
const surfaceById = (id) => registry.surfaces.find((s) => s.id === id);

const HEALTH_ID = "sn-124-swarm-health";
const LEADERBOARD_ID = "sn-124-swarm-leaderboard-api";
const HEALTH = surfaceById(HEALTH_ID);
const LEADERBOARD = surfaceById(LEADERBOARD_ID);

// Faithful subsets of the live response bodies.
const HEALTH_BODY = { status: "healthy" };
const LEADERBOARD_BODY = {
  entries: [
    {
      rank: 1,
      model_id: 707,
      uid: 190,
      family_id: "cf_interceptor",
      benchmark_score: 0.8217095310619192,
      status: "CHAMPION",
      is_champion: true,
    },
  ],
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN124 Swarm call_subnet_surface verification (#7132)", () => {
  test("the dead /kings/diagnostics surface is not present", () => {
    assert.equal(surfaceById("sn-124-swarm-kings-diagnostics"), undefined);
    // No surface should still point at the collision path.
    assert.ok(
      !registry.surfaces.some(
        (s) => s.url === "https://api.swarm124.com/kings/diagnostics",
      ),
    );
  });

  test("the health + leaderboard surfaces are configured to be callable", () => {
    for (const [surface, url] of [
      [HEALTH, "https://api.swarm124.com/health"],
      [LEADERBOARD, "https://api.swarm124.com/leaderboard"],
    ]) {
      assert.ok(surface, `registry surface for ${url} is present`);
      assert.equal(surface.kind, "subnet-api");
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      // HEAD 405 upstream -> the probe must call GET.
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      assert.equal(surface.url, url);
      // Single fixed endpoints -- no machine-readable schema is expected.
      assert.equal(surface.schema_url, undefined);
    }
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    for (const [surface, body, check] of [
      [HEALTH, HEALTH_BODY, (r) => assert.equal(r.body.status, "healthy")],
      [
        LEADERBOARD,
        LEADERBOARD_BODY,
        (r) => assert.equal(r.body.entries[0].uid, 190),
      ],
    ]) {
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
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      check(result);
    }
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...HEALTH, surface_id: HEALTH.id, netuid: 124 }],
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
      return jsonResponse(HEALTH_BODY);
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
              arguments: { surface_id: HEALTH_ID },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, HEALTH_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.status, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
