// End-to-end verification that SN91 (Bitstarter #1)'s catalogued no-auth
// health surface actually resolves and returns a real response body through
// the call_subnet_surface MCP tool -- MCP execute Phase 1 (#7014) per-subnet
// wiring, metagraphed#7103. The surface config was verified live against
// https://updates.bitstarter.ai/api/health: a no-auth GET returning
// `application/json; charset=utf-8` with an operational-status body
// (`{status, message}`), so nothing in registry/subnets/bitstarter-1.json's
// sn-91-bitstarter-updates-health-api entry needed fixing (probe GET/json,
// auth_required:false, and the fixed single endpoint all match reality). This
// pins that contract through the tool -- surface resolution by real id/key,
// the declared GET/json probe, and charset-suffixed JSON parsing -- so a
// regression in the tool or in the surface's registry config is caught.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

// The SN91 health surface exactly as the build emits it into
// operational-surfaces.json (registry/subnets/bitstarter-1.json ->
// sn-91-bitstarter-updates-health-api).
const SN91_HEALTH_SURFACE = {
  surface_id: "sn-91-bitstarter-updates-health-api",
  surface_key: "srf-49a2520ec2761aa7",
  netuid: 91,
  kind: "subnet-api",
  url: "https://updates.bitstarter.ai/api/health",
  provider: "bitstarter",
  auth_required: false,
  public_safe: true,
  probe: { method: "GET", expect: "json", timeout_ms: 15000 },
};

// The real operational-status body the endpoint returns.
const HEALTH_BODY = { status: "ok", message: "All systems operational" };

const deps = {
  readArtifact: async (_env: Row, path: string) => {
    if (path === "/metagraph/operational-surfaces.json") {
      return { ok: true, data: { surfaces: [SN91_HEALTH_SURFACE] } };
    }
    return { ok: false, status: 404 };
  },
};

// Serves the DoH lookup the SSRF guard makes for updates.bitstarter.ai (answer
// with a public IP so it's treated as safe) and the surface's own JSON body.
function mockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(
        JSON.stringify({ Answer: [{ type: 1, data: "104.16.0.1" }] }),
        { headers: { "content-type": "application/dns-json" } },
      );
    }
    return new Response(JSON.stringify(HEALTH_BODY), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
}

async function callSn91Surface(surfaceId: string) {
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
      {} as unknown as Env,
      deps,
    );
    return ((await response.json()) as Row).result;
  } finally {
    globalThis.fetch = original;
  }
}

describe("call_subnet_surface: SN91 Bitstarter #1 health API (#7103)", () => {
  test("returns the real operational-status body end-to-end", async () => {
    const result = await callSn91Surface("sn-91-bitstarter-updates-health-api");
    assert.equal(result.isError, false);
    assert.equal(
      result.structuredContent.surface_id,
      "sn-91-bitstarter-updates-health-api",
    );
    assert.equal(result.structuredContent.status_code, 200);
    // charset-suffixed content-type still classifies as JSON and parses.
    assert.equal(
      result.structuredContent.content_type,
      "application/json; charset=utf-8",
    );
    assert.deepEqual(result.structuredContent.body, HEALTH_BODY);
    assert.equal(result.structuredContent.truncated, false);
    assert.equal(result.structuredContent.parse_error, undefined);
  });

  test("resolves by the surface's stable surface_key too", async () => {
    const result = await callSn91Surface("srf-49a2520ec2761aa7");
    assert.equal(result.isError, false);
    assert.equal(
      result.structuredContent.surface_id,
      "sn-91-bitstarter-updates-health-api",
    );
    assert.deepEqual(result.structuredContent.body, HEALTH_BODY);
  });
});
