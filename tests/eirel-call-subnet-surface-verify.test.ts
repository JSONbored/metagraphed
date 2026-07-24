// SN36 (Eirel) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7051, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN36's *real* registry surface config
// (registry/subnets/eirel.json) to the tool's contract, so a future edit that
// regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth SN36 API status endpoint
// (sn-36-eirel-metagraph-status, GET https://api.eirel.ai/v1/metagraph/status,
// JSON, single fixed endpoint -- no schema). Live-verified 2026-07-21
// (reproduced twice, ~5 minutes apart) to return HTTP 200 application/json,
// but the body itself reports an internal decode error for this netuid
// (status: failed, validator_count/miner_count both 0, plus a scalecodec
// type-mismatch message) rather than real metagraph data -- a bug in Eirel's
// own on-chain query path for this one route (their /healthz reports
// database/redis ok, and the sibling dashboard-overview surface on the same
// host returns correct netuid/network/validator data), not a metagraphed
// config issue -- see registry/subnets/eirel.json's note on this surface.
// call_subnet_surface correctly passes the error body through unchanged
// (transport-level ok: true, status_code: 200); this test pins that CURRENT
// error state (not a healthy one) so a future edit that either regresses the
// transport (e.g. a non-2xx) or silently drops the `error` field is caught.
// The fixture below mirrors that live response rather than fetching it,
// keeping the test hermetic while still exercising the JSON parse-and-return
// path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-36-eirel-metagraph-status";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/eirel.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// The live https://api.eirel.ai/v1/metagraph/status response body, verbatim
// (not simplified) -- the `error` field is the whole point of this fixture,
// so it stays in rather than being trimmed down to just `status`.
const BODY = {
  status: "failed",
  network: "finney",
  netuid: 36,
  validator_count: 0,
  miner_count: 0,
  error:
    "Invalid type for data: 36 of type <class 'int'>, type_def: Composite(TypeDefComposite { fields: [Field { name: None, ty: UntrackedSymbol { id: 42, marker: PhantomData<fn() -> core::any::TypeId> }, type_name: Some(\"u16\"), docs: [] }] })",
  created_at: "2026-07-21T15:11:17.411957",
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN36 (Eirel) call_subnet_surface verification (#7051)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    // No-auth GET returning JSON.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://api.eirel.ai/v1/metagraph/status");
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET — including the subnet's own internal-error payload, unmasked", async () => {
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
    // Pins the CURRENT error state, not a healthy one -- see this file's
    // header comment. Asserting on `error` (not just `status`) so a future
    // simplification of this fixture can't silently drop the field that
    // actually proves this is an error response, not real metagraph data.
    assert.equal((result.body as Row).status, "failed");
    assert.equal((result.body as Row).validator_count, 0);
    assert.equal((result.body as Row).miner_count, 0);
    assert.match((result.body as Row).error, /Invalid type for data/);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 36 }],
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
      // Tool-layer transport succeeds (isError: false, 200) even though the
      // payload it faithfully relays is itself an error from the subnet's
      // own backend -- that distinction is the whole point of this file.
      assert.equal(result.structuredContent.body.status, "failed");
      assert.match(
        result.structuredContent.body.error,
        /Invalid type for data/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
