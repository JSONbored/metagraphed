// SN94 (SN94) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7106, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.ts -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN94's *real* registry surface config
// (registry/subnets/cathedral.json) to the tool's contract, so a future edit that
// changes its availability class without updating this pin is caught here.
//
// The 2026-11-15 infra#873 availability sweep retired this surface from the
// callable set (p2: dns-gone), so this file now pins the
// non-callable state: probe disabled pending re-verification (retired, not
// deleted), and the MCP tool refusing the call before any upstream fetch.
// The transport-layer fixture test below is unchanged -- callSubnetSurface
// itself does not gate on probe.enabled.
//
// The surface is the public no-auth SN94 API health endpoint
// (sn-94-bitsota-healthz, GET https://autoresearch.bitsota.com/healthz, JSON, single fixed endpoint -- no schema). Live-verified
// 2026-07-21 to return HTTP 200 application/json {"status":"ok"}. The
// fixture below mirrors that live response rather than fetching it, keeping the
// test hermetic while still exercising the JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const SURFACE_ID = "sn-94-bitsota-healthz";

const registry: Row = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/cathedral.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live https://autoresearch.bitsota.com/healthz response body.
const BODY = { status: "ok" };

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN94 SN94 call_subnet_surface verification (#7106)", () => {
  test("the registry surface is pinned to its retired (probe-disabled) config", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    // [2026-11-15 infra#873 p2] dns-gone: retired from the callable set.
    assert.equal(SURFACE.probe?.enabled, false);
    assert.match(SURFACE.notes, /\[2026-11-15 infra#873 p2\] dns-gone/);
    // No-auth GET returning JSON.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://autoresearch.bitsota.com/healthz");
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init?.method;
        return upstreamResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).status, "ok");
  });

  test("the call_subnet_surface MCP tool refuses the retired surface without fetching upstream", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 94 }],
    };
    const deps = {
      readArtifact: async (_env: Row, path: string) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    let upstreamFetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      upstreamFetched = true;
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
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /probe\.enabled:false/);
      assert.equal(upstreamFetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
