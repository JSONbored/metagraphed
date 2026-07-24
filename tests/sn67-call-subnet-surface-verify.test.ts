// SN67 (Harnyx) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7080, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN67's *real* registry surface config
// (registry/subnets/harnyx.json) to the tool's contract, so a future edit that
// regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe, "fixing" expect to json) is caught here.
//
// The surface is the public no-auth Harnyx healthz endpoint
// (sn-67-harnyx-healthz-api, GET https://harnyx.ai/healthz, plain text,
// single fixed endpoint -- no schema). Live-verified 2026-07-21 to return
// HTTP 200 text/plain; charset=utf-8 with body "ok\n". Registry already
// matched reality (probe.expect: any for the non-JSON body) -- no registry
// edit needed. The fixture below mirrors that live response rather than
// fetching it, keeping the test hermetic while still exercising the text
// return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-67-harnyx-healthz-api";
const NETUID = 67;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/harnyx.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful copy of the live https://harnyx.ai/healthz body.
const LIVE_TEXT = "ok\n";

function upstreamResponse() {
  return new Response(LIVE_TEXT, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

describe("SN67 Harnyx call_subnet_surface verification (#7080)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    // The live body is text/plain, so the non-JSON "any" expectation is
    // deliberate -- pin it so nobody "fixes" it to json and breaks probes.
    assert.equal(SURFACE.probe?.expect, "any");
    assert.equal(SURFACE.url, "https://harnyx.ai/healthz");
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the plain-text body uncapped and unparsed", async () => {
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
    assert.equal(result.content_type, "text/plain; charset=utf-8");
    assert.equal(result.truncated, false);
    // Text path: returned as the raw string, no JSON parse attempted.
    assert.equal(result.body, LIVE_TEXT);
    assert.equal(result.parse_error, undefined);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
    };
    const deps = {
      readArtifact: async (_env: Row, path: string) =>
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
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body, LIVE_TEXT);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
