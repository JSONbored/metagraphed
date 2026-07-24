// SN12 (Compute Horde) end-to-end verification for the call_subnet_surface
// MCP tool (metagraphed#7028, MCP execute Phase 1 follow-up #7014/#7215).
// Unlike tests/call-subnet-surface-mcp.test.mjs -- which proves the tool
// wiring with synthetic surfaces -- this file pins SN12's registry surface
// (registry/subnets/compute-horde.json) to the tool's contract, so a future
// edit that regresses its callability (flipping to HEAD, marking it
// auth_required, disabling its probe) is caught here.
//
// The surface is the public no-auth Grafana OpenAPI schema
// (sn-12-compute-horde-grafana-openapi, GET
// https://grafana.bittensor.church/public/openapi3.json, JSON, has captured
// schema). Live-verified 2026-07-21 to return HTTP 200 application/json (a
// ~735 KB OpenAPI 3 document). The fixture below mirrors the shape of that
// live response with a minimal document rather than fetching it, keeping
// the test hermetic while still exercising the JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const SURFACE_ID = "sn-12-compute-horde-grafana-openapi";

const registry: Row = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/compute-horde.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live Grafana OpenAPI document's shape.
const BODY = {
  components: {
    responses: {
      GetAllIntervalsResponse: {
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: { $ref: "#/components/schemas/GettableTimeIntervals" },
            },
          },
        },
      },
    },
  },
};

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN12 Compute Horde call_subnet_surface verification (#7028)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "openapi");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(
      SURFACE.url,
      "https://grafana.bittensor.church/public/openapi3.json",
    );
    assert.equal(SURFACE.schema_url, SURFACE.url);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
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
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.body, BODY);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 12 }],
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
        {} as unknown as Env,
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
