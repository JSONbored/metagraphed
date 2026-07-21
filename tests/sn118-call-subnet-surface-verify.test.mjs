// SN118 (Ditto) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7128, MCP execute Phase 1 follow-up #7014/#7215). Like
// tests/sn92-call-subnet-surface-verify.test.mjs, this pins SN118's *real*
// registry surface config (registry/subnets/ditto.json) to the tool's
// contract, so a future edit that regresses callability (flipping to HEAD,
// marking it auth_required, disabling its probe, dropping the trailing slash,
// or moving the schema URL) is caught here.
//
// SN118 exposes two no-auth GET surfaces the issue asks to verify:
//
//   1. sn-118-taomarketcap-subnet-api (kind: subnet-api) --
//      GET https://api.taomarketcap.com/public/v1/subnets/118/. Verified live
//      to return HTTP 200 application/json; HEAD 405 (so the probe correctly
//      declares GET) and the non-slash path 301s to the tracked trailing-slash
//      URL. subnet-api is an OPERATIONAL_SURFACE_KIND, so it lands in
//      operational-surfaces.json and is resolvable through the MCP tool by id.
//
//   2. sn-118-ditto-admin-openapi (kind: openapi) --
//      GET https://api.heyditto.ai/api/admin/v1/swagger/doc.json. Verified live
//      to return HTTP 200 application/json, a Swagger 2.0 document titled
//      "Ditto Admin API" with basePath /api/admin/v1 and 13 paths. openapi is
//      NOT an OPERATIONAL_SURFACE_KIND, so this surface is intentionally absent
//      from operational-surfaces.json and is not resolvable by the MCP tool's
//      catalog lookup -- it is verified directly through callSubnetSurface, the
//      exact passthrough the tool performs. The issue endorses this: for a
//      no-auth GET surface, calling the URL directly is equally valid.
//
// Both fixtures mirror the live responses' top-level shape rather than fetching
// them, keeping the test hermetic while still exercising the JSON
// parse-and-return path against the upstreams' actual field sets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";

const SUBNET_API_ID = "sn-118-taomarketcap-subnet-api";
const OPENAPI_ID = "sn-118-ditto-admin-openapi";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/ditto.json", import.meta.url)),
    "utf8",
  ),
);
const SUBNET_API = registry.surfaces.find(
  (surface) => surface.id === SUBNET_API_ID,
);
const OPENAPI = registry.surfaces.find((surface) => surface.id === OPENAPI_ID);

// A faithful subset of the live
// https://api.taomarketcap.com/public/v1/subnets/118/ response body (top-level
// fields + the nested latest_snapshot object).
const SUBNET_API_BODY = {
  id: "118",
  netuid: 118,
  created_at_block: 5724794,
  registered_at: "2025-06-06T23:15:36+00:00",
  latest_snapshot_id: "8667109-118",
  is_active: true,
  is_subsidized: false,
  mechanism_count: 1,
  latest_snapshot: {
    id: "8667109-118",
    netuid: 118,
    subtoken_enabled: true,
    subnet_owner_hotkey: "5HmP9732JFjnut2RY9yg4Gz2qJ38vF8xFwZb5dQVPF7FsmZz",
  },
};

// A faithful subset of the live Swagger 2.0 document at
// https://api.heyditto.ai/api/admin/v1/swagger/doc.json.
const OPENAPI_BODY = {
  swagger: "2.0",
  info: { title: "Ditto Admin API", version: "1.0" },
  host: "",
  basePath: "/api/admin/v1",
  paths: {
    "/agent-accounts": {},
    "/agent-accounts/{account_id}": {},
    "/agent-accounts/{account_id}/link": {},
  },
  definitions: { "admin.AdminUserSummary": {} },
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN118 Ditto call_subnet_surface verification (#7128)", () => {
  test("the TaoMarketCap subnet-api surface exists and is configured to be callable", () => {
    assert.ok(SUBNET_API, `registry surface ${SUBNET_API_ID} is present`);
    assert.equal(SUBNET_API.kind, "subnet-api");
    assert.equal(SUBNET_API.auth_required, false);
    assert.equal(SUBNET_API.probe?.enabled, true);
    // HEAD 405 upstream -> the probe must call GET.
    assert.equal(SUBNET_API.probe?.method, "GET");
    assert.equal(SUBNET_API.probe?.expect, "json");
    // Canonical non-redirecting form (non-slash path 301s).
    assert.equal(
      SUBNET_API.url,
      "https://api.taomarketcap.com/public/v1/subnets/118/",
    );
    assert.ok(SUBNET_API.url.endsWith("/"));
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SUBNET_API.schema_url, undefined);
    // subnet-api is an operational kind, so this surface reaches the MCP tool's
    // operational-surfaces catalog.
    assert.ok(OPERATIONAL_SURFACE_KINDS.includes(SUBNET_API.kind));
  });

  test("callSubnetSurface returns the real subnet-api JSON body using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SUBNET_API, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return jsonResponse(SUBNET_API_BODY);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SUBNET_API.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal(result.body.id, "118");
    assert.equal(result.body.netuid, 118);
    assert.equal(result.body.is_active, true);
    assert.equal(result.body.latest_snapshot.netuid, 118);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SUBNET_API, surface_id: SUBNET_API.id, netuid: 118 }],
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
      return jsonResponse(SUBNET_API_BODY);
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
              arguments: { surface_id: SUBNET_API_ID },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SUBNET_API_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body.netuid, 118);
      assert.equal(result.structuredContent.body.is_active, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the Ditto Admin OpenAPI surface exists and pins its verified schema config", () => {
    assert.ok(OPENAPI, `registry surface ${OPENAPI_ID} is present`);
    assert.equal(OPENAPI.kind, "openapi");
    assert.equal(OPENAPI.auth_required, false);
    assert.equal(OPENAPI.probe?.enabled, true);
    assert.equal(OPENAPI.probe?.method, "GET");
    assert.equal(OPENAPI.probe?.expect, "json");
    assert.equal(OPENAPI.schema_status, "machine-readable");
    assert.equal(
      OPENAPI.url,
      "https://api.heyditto.ai/api/admin/v1/swagger/doc.json",
    );
    // The schema document is the surface itself.
    assert.equal(OPENAPI.schema_url, OPENAPI.url);
    // openapi is NOT an operational kind, so this surface is intentionally
    // absent from operational-surfaces.json -- it is verified directly, not
    // through the MCP tool's catalog lookup.
    assert.ok(!OPERATIONAL_SURFACE_KINDS.includes(OPENAPI.kind));
  });

  test("callSubnetSurface returns the real Swagger 2.0 document using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(OPENAPI, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return jsonResponse(OPENAPI_BODY);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, OPENAPI.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal(result.body.swagger, "2.0");
    assert.equal(result.body.info.title, "Ditto Admin API");
    assert.equal(result.body.basePath, "/api/admin/v1");
  });
});
