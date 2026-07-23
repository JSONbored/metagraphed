// SN92 (Tensorclaw) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7104, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN92's *real* registry surface config
// (registry/subnets/tensorclaw.json) to the tool's contract, so a future edit
// that regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe, dropping the trailing slash) is caught here.
//
// The surface is the public no-auth TaoMarketCap subnet snapshot feed
// (GET https://api.taomarketcap.com/public/v1/subnets/92/, JSON, no schema --
// a single fixed endpoint). Verified live to return HTTP 200 application/json;
// HEAD 405 (so the probe correctly declares GET) and the non-slash path 301s
// to the tracked trailing-slash URL. The fixture below mirrors that live
// response's top-level shape rather than fetching it, keeping the test
// hermetic while still exercising the JSON parse-and-return path against the
// upstream's actual field set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-92-taomarketcap-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/tensorclaw.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live https://api.taomarketcap.com/public/v1/subnets/92/
// response body (top-level fields + the nested latest_snapshot object).
const SN92_BODY = {
  id: "92",
  netuid: 92,
  created_at_block: 5356404,
  registered_at: "2025-04-15T11:14:24+00:00",
  latest_snapshot_id: "8666677-92",
  is_active: true,
  is_subsidized: false,
  mechanism_count: 1,
  latest_snapshot: {
    id: "8666677-92",
    netuid: 92,
    subtoken_enabled: true,
    subnet_owner_hotkey: "5FeHbWK12HHMLY4AtnWkKk8jtQajhQZMLCenGd96Hhs4UJGc",
  },
};

function sn92Response() {
  return new Response(JSON.stringify(SN92_BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN92 Tensorclaw call_subnet_surface verification (#7104)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    // HEAD 405 upstream -> the probe must call GET.
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    // Canonical non-redirecting form (non-slash path 301s).
    assert.equal(
      SURFACE.url,
      "https://api.taomarketcap.com/public/v1/subnets/92/",
    );
    assert.ok(SURFACE.url.endsWith("/"));
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
        return sn92Response();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).id, "92");
    assert.equal((result.body as Row).netuid, 92);
    assert.equal((result.body as Row).is_active, true);
    assert.equal((result.body as Row).latest_snapshot.netuid, 92);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 92 }],
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
      return sn92Response();
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
      assert.equal(result.structuredContent.body.netuid, 92);
      assert.equal(result.structuredContent.body.is_active, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
