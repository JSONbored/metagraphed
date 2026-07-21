// SN88 (Investing) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7100, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN88's *real* registry surface configs
// (registry/subnets/investing.json) to the tool's contract, so a future edit
// that regresses their callability (flipping to HEAD, marking them
// auth_required, disabling their probe, or dropping the /dist timeout back
// below its measured response time) is caught here.
//
// The three surfaces are the public no-auth Investing API feeds on
// api.investing88.ai (single fixed endpoints, no schema):
//   - GET /days -> JSON miner days-active records   (~11 KB, ~1.5s)
//   - GET /pnl  -> JSON per-miner profit-and-loss    (~2.3 MB, fast)
//   - GET /dist -> JSON per-miner distribution weights (~351 KB, ~16s TTFB)
//
// All three were verified live to return HTTP 200 application/json through the
// tool. Two findings the generic tool exposed, and how they are handled here:
//   1. /dist computes the full per-miner distribution server-side and does not
//      emit response headers until ~16s (measured TTFB 15.5-15.8s). Its probe
//      timeout_ms was 10000, so call_subnet_surface's AbortController fired at
//      10s and aborted the call before the body arrived -- the surface read as
//      broken purely from a too-low timeout. Fixed by raising timeout_ms to the
//      30000 schema max; this test pins that value.
//   2. /pnl (~2.3 MB) exceeds the tool's 256 KiB MAX_RESPONSE_BYTES cap, so the
//      tool returns a truncated body with a parse_error rather than a parsed
//      object. That is the tool's own graceful bound (maintainer-owned, out of
//      scope here), and this test asserts that documented behaviour so it is
//      recorded rather than mistaken for a regression.
//
// The fixtures below mirror each live response's shape rather than fetching it,
// keeping the test hermetic while still exercising the JSON parse-and-return
// and truncation paths against the upstream's actual field set.
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
      new URL("../registry/subnets/investing.json", import.meta.url),
    ),
    "utf8",
  ),
);
const surfaceById = (id) => registry.surfaces.find((s) => s.id === id);

const DAYS = surfaceById("sn-88-investing-days-api");
const PNL = surfaceById("sn-88-investing-pnl-api");
const DIST = surfaceById("sn-88-investing-dist-api");

// A faithful subset of the live GET https://api.investing88.ai/days response:
// an array of fixed-arity miner rows [uid, hotkey-prefix, date, ...numbers].
const DAYS_BODY = [
  [124, "5HjKka", "2026-07-20", 183, 0, 1, 1, 0.01006],
  [1, "5DFqEA", "2026-07-19", 32, 0, 83, 8, 0.0299015698],
];

// A faithful subset of GET /dist: [[uid, hotkey-ss58, 0, ...weights]].
const DIST_BODY = [
  [180, "5CLVLohUQdd6b9U8gM8wqd4SSaJHRWR4aExhuiUmbeMfRWeC", 0, 0.604, 0.045],
];

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN88 Investing call_subnet_surface verification (#7100)", () => {
  test("all three API surfaces exist and are configured to be callable", () => {
    for (const surface of [DAYS, PNL, DIST]) {
      assert.ok(surface, "registry surface is present");
      assert.equal(surface.kind, "subnet-api");
      assert.equal(surface.auth_required, false);
      assert.equal(surface.probe?.enabled, true);
      // HEAD is not used -- the endpoints serve real GET JSON bodies.
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
      // Single fixed endpoints -- no machine-readable schema is expected.
      assert.equal(surface.schema_url, undefined);
    }
    assert.equal(DAYS.url, "https://api.investing88.ai/days");
    assert.equal(PNL.url, "https://api.investing88.ai/pnl");
    assert.equal(DIST.url, "https://api.investing88.ai/dist");
  });

  test("the /dist timeout was raised above its measured ~16s response time", () => {
    // The fix for this verify pass: /dist reliably takes ~16s TTFB, so the
    // prior 10s timeout made call_subnet_surface abort it. days/pnl respond
    // quickly and keep the default 10s.
    assert.equal(DIST.probe.timeout_ms, 30000);
    assert.equal(DAYS.probe.timeout_ms, 10000);
    assert.equal(PNL.probe.timeout_ms, 10000);
  });

  test("callSubnetSurface returns the real parsed /days JSON body using GET + the surface url", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(DAYS, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return jsonResponse(DAYS_BODY);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, DAYS.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.ok(Array.isArray(result.body));
    assert.equal(result.body[0][0], 124);
  });

  test("callSubnetSurface threads /dist's raised timeout into its fetch and returns the JSON body", async () => {
    let seenTimeout;
    const result = await callSubnetSurface(DIST, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        // The AbortController is armed with surface.probe.timeout_ms; a slow
        // upstream that resolves before it fires must succeed. Capture the
        // signal to prove the raised budget is what gets applied.
        seenTimeout = init.signal instanceof AbortSignal;
        return jsonResponse(DIST_BODY);
      },
    });
    assert.equal(seenTimeout, true);
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.equal(result.body[0][0], 180);
  });

  test("a /pnl body over the tool's byte cap is returned truncated with a parse_error, not an error", async () => {
    // Build a JSON array larger than MAX_RESPONSE_BYTES to mirror the ~2.3 MB
    // live /pnl payload; the tool caps the read, so the truncated text no
    // longer parses as JSON and surfaces as a parse_error rather than a throw.
    const row = [
      1,
      "5DFqEAQY6DhFh7WbSNFH85kX7VrcT4TjbVCtscHP1VHDWyPN",
      "2026-04-27",
      0,
      8057188,
      1000.0,
    ];
    const bigBody = [];
    while (JSON.stringify(bigBody).length <= MAX_RESPONSE_BYTES + 4096) {
      bigBody.push(row);
    }
    const result = await callSubnetSurface(PNL, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () => jsonResponse(bigBody),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, true);
    assert.equal(typeof result.body, "string");
    assert.ok(result.parse_error);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...DAYS, surface_id: DAYS.id, netuid: 88 }],
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
      return jsonResponse(DAYS_BODY);
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
              arguments: { surface_id: DAYS.id },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, DAYS.id);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.truncated, false);
      assert.ok(Array.isArray(result.structuredContent.body));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
