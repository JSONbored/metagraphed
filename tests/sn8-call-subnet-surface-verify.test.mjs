// SN8 (Vanta) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7024, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN8's *real* no-auth GET JSON
// registry surface (registry/subnets/vanta.json) to the tool's contract.
//
// Live-verified 2026-07-21:
//   sn-8-vanta-model-parameters  GET
//     https://github.com/taoshidev/vanta-network/raw/main/vali_objects/utils/model_parameters/all_model_parameters.json
//     -> HTTP 200 text/plain; charset=utf-8 JSON document (equity.*.buy/sell.*)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-8-vanta-model-parameters";
const NETUID = 8;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/vanta.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

// A faithful subset of the live all_model_parameters.json shape.
const BODY = {
  equity: {
    AAPL: {
      buy: {
        "1k_10k": {
          intercept: -6.0712694564057e-6,
          "spread/price": 0.5339598003773119,
        },
      },
    },
  },
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

describe("SN8 Vanta call_subnet_surface verification (#7024)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(
      SURFACE.url,
      "https://github.com/taoshidev/vanta-network/raw/main/vali_objects/utils/model_parameters/all_model_parameters.json",
    );
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the model-parameters JSON body via GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return jsonResponse(BODY);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.match(result.content_type, /^text\/plain/i);
    // GitHub raw serves JSON as text/plain -- the tool returns the UTF-8 string.
    const parsed =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body;
    assert.ok(parsed.equity);
    assert.ok(parsed.equity.AAPL);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
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
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return jsonResponse(BODY);
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
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      const parsed = JSON.parse(result.structuredContent.body);
      assert.ok(parsed.equity);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
