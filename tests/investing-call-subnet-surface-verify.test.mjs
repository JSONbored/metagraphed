// SN88 (Investing) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7100, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN88's real registry surface config
// (registry/subnets/investing.json) to the tool's contract, so a future edit
// that regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth GET SN88 per-miner daily stats endpoint on
// Investing's official API (sn-88-investing-days-api, GET
// https://api.investing88.ai/days). Live-verified 2026-07-21: HTTP 200
// application/json whose payload is a JSON-*encoded string* (a quoted string
// literal wrapping a serialized rows array), so call_subnet_surface parses the
// JSON and returns a string value rather than an array/object. The fixture
// below mirrors that live shape, keeping the test hermetic while exercising
// the JSON parse-returns-a-primitive path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-88-investing-days-api";
const SURFACE_URL = "https://api.investing88.ai/days";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/investing.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

// The live endpoint returns a JSON-encoded string (the rows array is itself
// serialized into a quoted string), so JSON.parse yields a string primitive.
const INNER = '[[1,"5DFqEA","2026-07-20",19,0,85,0,0.0379982111]]';

function upstreamResponse() {
  return new Response(JSON.stringify(INNER), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN88 Investing call_subnet_surface verification (#7100)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, SURFACE_URL);
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface parses the JSON body (a string primitive) using the surface's own url + GET", async () => {
    let requestedUrl;
    let requestedMethod;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = init.method;
        return upstreamResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    // application/json holding a quoted string -> parses to a string primitive.
    assert.equal(typeof result.body, "string");
    assert.equal(result.body, INNER);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 88 }],
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
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(typeof result.structuredContent.body, "string");
      assert.equal(result.structuredContent.body, INNER);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
