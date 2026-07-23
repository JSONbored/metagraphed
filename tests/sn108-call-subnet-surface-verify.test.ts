// SN108 (TalkHead) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7119, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN108's *real* registry surface config
// (registry/subnets/talkhead.json) to the tool's contract, so a future edit
// that regresses its callability (flipping method, marking it auth_required,
// disabling its probe, changing expect away from `any`) is caught here.
//
// The surface is the public no-auth health feed
// (GET https://api.talkhead.ai/health, no schema -- a single fixed endpoint).
// Verified live to return HTTP 200 `text/html; charset=utf-8` with plain-text
// body `Healthy` (not JSON) -- which is why the registry correctly sets
// `probe.expect: "any"`. The fixture below mirrors that live response rather
// than fetching it, keeping the test hermetic while still exercising the
// non-JSON body path through the tool.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-108-talkhead-health";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/talkhead.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

function sn108Response() {
  return new Response("Healthy", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("SN108 TalkHead call_subnet_surface verification (#7119)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    // Live body is plain text under a text/html content-type -- not JSON.
    assert.equal(SURFACE.probe?.expect, "any");
    assert.equal(SURFACE.url, "https://api.talkhead.ai/health");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the plain-text Healthy body via GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init!.method;
        return sn108Response();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.equal(result.body, "Healthy");
    assert.match(result.content_type!, /^text\/html/i);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 108 }],
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
      return sn108Response();
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
        mockEnv(),
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(result.structuredContent.body, "Healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
