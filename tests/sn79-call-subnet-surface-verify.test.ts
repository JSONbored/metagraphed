// SN79 (MVTRX) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7092, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN79's *real* registry surface config
// (registry/subnets/mvtrx.json) to the tool's contract, so a future edit that
// regresses its callability (flipping method to HEAD, marking it
// auth_required) is caught here.
//
// The surface is the public no-auth MVTRX exchange health endpoint
// (sn-79-taos-im-subnet-api, https://mvtrx.exchange/health, JSON, single
// fixed endpoint -- no schema). Live-verified 2026-07-21:
//   GET  -> HTTP 200 application/json {"status":"ok","mode":"host","network":"mainnet"}
//   HEAD -> HTTP 405
// callSubnetSurface defaults to GET when probe.method is unset (see
// src/call-subnet-surface.ts), which is the correct method for this host.
// The fixture below mirrors the live response rather than fetching it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-79-taos-im-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/mvtrx.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// Faithful subset of the live https://mvtrx.exchange/health response body.
const BODY = { status: "ok", mode: "host", network: "mainnet" };

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN79 MVTRX call_subnet_surface verification (#7092)", () => {
  test("the registry surface exists and is configured to be callable via GET", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.url, "https://mvtrx.exchange/health");
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
    // Live host rejects HEAD (405). callSubnetSurface only uses HEAD when
    // probe.method is explicitly "HEAD"; unset/GET both issue GET.
    assert.notEqual(SURFACE.probe?.method, "HEAD");
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
    assert.equal((result.body as Row).status, "ok");
    assert.equal((result.body as Row).mode, "host");
    assert.equal((result.body as Row).network, "mainnet");
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 79 }],
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
      assert.equal(result.structuredContent.body.status, "ok");
      assert.equal(result.structuredContent.body.network, "mainnet");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
