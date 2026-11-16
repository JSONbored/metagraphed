// SN100 (Plaτform) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7112, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.ts -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN100's *real* registry surface config
// (registry/subnets/cortex.json) to the tool's contract, so a future edit that
// regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth Plaτform challenge registry API
// (sn-100-platform-network-subnet-api, GET https://chain.joinbase.ai/v1/registry,
// JSON, single fixed endpoint -- no schema). Live-verified 2026-07-21 to return
// HTTP 200 application/json { network: "base", api_version: "1.0", master_uid: 0,
// challenges: [...] }. The fixture below mirrors that live response rather than
// fetching it, keeping the test hermetic while still exercising the JSON
// parse-and-return path.
//
// 2026-11-15: the infra#873 availability sweep found the declared route
// answering 404 on an alive host and probe-disabled the surface pending url
// re-verification. This file now pins that non-callable state (gated !=
// broken; probe-disabled = retired from the callable set pending
// re-verification).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-100-platform-network-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/cortex.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live https://chain.joinbase.ai/v1/registry response body.
const BODY = {
  network: "base",
  api_version: "1.0",
  master_uid: 0,
  challenges: [
    {
      slug: "agent-challenge",
      name: "Agent Challenge",
      status: "active",
    },
  ],
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN100 Plaτform call_subnet_surface verification (#7112)", () => {
  test("the registry surface exists and pins its sweep-retired (non-callable) state", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    // Probe-disabled by the 2026-11-15 infra#873 sweep: the declared route
    // answers 404 on an alive host; the dated note records why.
    assert.equal(SURFACE.probe?.enabled, false);
    assert.match(SURFACE.notes, /\[2026-11-15 infra#873 p3b\]/);
    // Declared no-auth GET returning JSON, unchanged by the sweep.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://chain.joinbase.ai/v1/registry");
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
    assert.equal((result.body as Row).network, "base");
    assert.equal((result.body as Row).api_version, "1.0");
    assert.ok(Array.isArray((result.body as Row).challenges));
    assert.equal((result.body as Row).challenges[0].slug, "agent-challenge");
  });

  test("the call_subnet_surface MCP tool refuses the retired surface without fetching upstream", async () => {
    // In production the operational catalog filters probe.enabled:false
    // surfaces out entirely; this injects the real registry config into a
    // catalog fixture to pin the tool's own guard (src/mcp-server.ts
    // surface_unavailable) as the second line of defense.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 100 }],
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
      // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
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
