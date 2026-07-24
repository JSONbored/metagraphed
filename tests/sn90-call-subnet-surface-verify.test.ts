// SN90 (DegenBrain) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7102, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN90's *real* registry surface config
// (registry/subnets/degenbrain.json) to the tool's contract, so a future edit
// that regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth DegenBrain pending-markets endpoint
// (GET https://api.subnet90.com/api/markets/pending, JSON, no schema -- a
// single fixed endpoint). Live-verified 2026-07-21 to return HTTP 200
// application/json { markets: [ { id, statement, end_date, createdAt,
// initialValue, direction, category }, ... ] }. The fixture below mirrors that
// live response's shape rather than fetching it, keeping the test hermetic
// while still exercising the JSON parse-and-return path. (The market list is
// live data, so the test asserts the stable shape, not its exact contents.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-90-degenbrain-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/degenbrain.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live https://api.subnet90.com/api/markets/pending body.
const SN90_BODY = {
  markets: [
    {
      id: "btc-100k-2024",
      statement: "Bitcoin will cross $100,000 by December 31, 2024",
      end_date: "2024-12-31T23:59:59Z",
      direction: "up",
      category: "crypto",
    },
  ],
};

function sn90Response() {
  return new Response(JSON.stringify(SN90_BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN90 DegenBrain call_subnet_surface verification (#7102)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    // No-auth GET returning JSON.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://api.subnet90.com/api/markets/pending");
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
        return sn90Response();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    // Live market list -- assert the stable shape, not the exact markets.
    assert.ok(Array.isArray((result.body as Row).markets));
    assert.equal(typeof (result.body as Row).markets[0].id, "string");
    assert.equal(typeof (result.body as Row).markets[0].statement, "string");
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 90 }],
    };
    const deps = {
      readArtifact: async (_env: Row, path: string) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return sn90Response();
    }) as typeof fetch;
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
      assert.ok(Array.isArray(result.structuredContent.body.markets));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
