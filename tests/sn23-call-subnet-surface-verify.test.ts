// SN23 (Trishool) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7039, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN23's *real* registry surface config
// (registry/subnets/trishool.json) to the tool's contract, so a future edit
// that regresses its callability (flipping method, marking it auth_required,
// disabling its probe, changing expect away from `any`) is caught here.
//
// The surface is the public no-auth Trishool API landing page
// (GET https://api.trishool.ai/, no schema -- a single fixed endpoint).
// Live-verified 2026-07-21 to return HTTP 200 `text/plain` with body
// "You have arrived at the Trishool phase 2 platform.\n" (not JSON) -- which
// is why the registry correctly sets `probe.expect: "any"`. The fixture below
// mirrors that live response rather than fetching it, keeping the test
// hermetic while still exercising the non-JSON body path through the tool.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-23-trishool-api-root";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/trishool.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

const BODY = "You have arrived at the Trishool phase 2 platform.\n";

function sn23Response() {
  return new Response(BODY, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

describe("SN23 Trishool call_subnet_surface verification (#7039)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    // Live body is plain text -- not JSON -- so expect must stay `any`.
    assert.equal(SURFACE.probe?.expect, "any");
    assert.equal(SURFACE.url, "https://api.trishool.ai/");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the plain-text landing body via GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init!.method;
        return sn23Response();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.equal(result.body, BODY);
    assert.match(result.content_type!, /^text\/plain/i);
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 23 }],
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
      return sn23Response();
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
      assert.equal(result.structuredContent.body, BODY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
