// SN3 (Templar) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7019, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN3's real registry surface config
// (registry/subnets/templar.json) to the tool's contract, so a future edit
// that regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth GET JSON OpenAPI document served by
// Templar's official Grafana instance (sn-3-templar-grafana-openapi, GET
// https://grafana.tplr.ai/public/openapi3.json). Live-verified 2026-07-21 to
// return HTTP 200 application/json -- an OpenAPI 3.0.3 document (info.title
// "Grafana HTTP API.", version "0.0.1", 208 documented paths). The fixture
// below mirrors that live response's top-level shape rather than fetching it,
// keeping the test hermetic while still exercising the JSON parse-and-return
// path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-3-templar-grafana-openapi";
const OPENAPI_URL = "https://grafana.tplr.ai/public/openapi3.json";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/templar.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

const BODY = {
  openapi: "3.0.3",
  info: { title: "Grafana HTTP API.", version: "0.0.1" },
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN3 Templar call_subnet_surface verification (#7019)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "openapi");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, OPENAPI_URL);
    // An OpenAPI surface carries its own machine-readable schema at the URL.
    assert.equal(SURFACE.schema_url, OPENAPI_URL);
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
    assert.deepEqual(result.body, BODY);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 3 }],
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
        {},
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.deepEqual(result.structuredContent.body, BODY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
