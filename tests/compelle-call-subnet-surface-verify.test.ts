// SN82 (Compelle) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7095, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN82's *real* registry surface config
// (registry/subnets/compelle.json) to the tool's contract, so a future edit
// that regresses its callability (marking it auth_required, flipping its probe
// to HEAD, or disabling its probe) is caught here.
//
// The surface is the public no-auth Compelle aggregation health endpoint
// (sn-82-compelle-health, GET https://compelle.com/api/health, JSON, single
// fixed endpoint -- no schema). Live-verified 2026-07-21 to return HTTP 200
// application/json; charset=utf-8 with body
// {"ok":true,"db_size_bytes":...,"last_epoch_block":...,"last_indexed_at":...,
// "games":...,"miners":...}. The surface declares no `probe` block at all --
// which is not a defect: call_subnet_surface resolves an absent probe method to
// its default GET (src/call-subnet-surface.ts) and classifies the body by the
// live content-type (probe.expect is never read by the tool), and the MCP
// handler only rejects a surface when auth_required is true or probe.enabled is
// explicitly false (src/mcp-server.mjs). The fixture below mirrors that live
// response rather than fetching it, keeping the test hermetic while still
// exercising the charset-suffixed JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import type { Row } from "./row-type.ts";

const SURFACE_ID = "sn-82-compelle-health";

const registry: Row = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/compelle.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live https://compelle.com/api/health response body.
const BODY = {
  ok: true,
  db_size_bytes: 6933532672,
  last_epoch_block: 8670255,
  last_indexed_at: 1784643996,
  games: 239828,
  miners: 861,
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    // Live upstream returns charset-suffixed JSON; the tool must still parse it.
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("SN82 Compelle call_subnet_surface verification (#7095)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    // No-auth GET returning JSON. The surface declares no probe block, so the
    // tool uses its default GET and the handler does not reject it -- the only
    // callability regressions are an auth flip, a probe disable, or a HEAD flip
    // (which would drop the body), all guarded below.
    assert.notEqual(SURFACE.probe?.enabled, false);
    assert.notEqual(SURFACE.probe?.method, "HEAD");
    assert.equal(SURFACE.url, "https://compelle.com/api/health");
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body via the surface's own url + default GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init?.method;
        return upstreamResponse();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    // The surface has no probe.method; the tool resolves that to GET.
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json; charset=utf-8");
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).ok, true);
    assert.equal(typeof (result.body as Row).db_size_bytes, "number");
    assert.equal(typeof (result.body as Row).games, "number");
    assert.equal(typeof (result.body as Row).miners, "number");
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 82 }],
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
      return upstreamResponse();
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
        {},
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal((result.structuredContent.body as Row).ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
