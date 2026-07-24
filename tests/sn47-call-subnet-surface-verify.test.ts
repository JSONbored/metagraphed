// SN47 (EvolAI) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7061, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN47's *real* registry surface config
// (registry/subnets/evolai.json) to the tool's contract, so a future edit that
// regresses its callability is caught here.
//
// The surface is the public no-auth EvolAI Proxy /datasets list endpoint
// (sn-47-evolai-subnet-api, GET https://evolai-gate.hf.space/datasets, JSON,
// single fixed endpoint -- no schema). Live-verified 2026-07-21 to return
// HTTP 503 application/json {"detail":"Backend unavailable"} -- the same
// Hugging Face Space outage already documented in the registry notes. The
// tool is a safety-checked passthrough: it returns that status + body rather
// than inventing success. Registry already matched reality (URL, GET/json
// probe, auth_required false) -- no registry edit needed. The fixture below
// mirrors the live 503 body rather than fetching it, keeping the test
// hermetic while still exercising the JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-47-evolai-subnet-api";
const NETUID = 47;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/evolai.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// Faithful copy of the live https://evolai-gate.hf.space/datasets response
// observed 2026-07-21 (HF Space backend unavailable).
const BODY = { detail: "Backend unavailable" };
const STATUS = 503;

function upstreamResponse() {
  return new Response(JSON.stringify(BODY), {
    status: STATUS,
    headers: { "content-type": "application/json" },
  });
}

describe("SN47 EvolAI call_subnet_surface verification (#7061)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://evolai-gate.hf.space/datasets");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the live 503 JSON body using the surface's own url + GET", async () => {
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
    // Passthrough: network/fetch succeeded; HTTP 503 is surfaced as
    // status_code + parsed body, not as tool-level ok:false.
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 503);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.equal((result.body as Row).detail, "Backend unavailable");
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: NETUID }],
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
      assert.equal(result.structuredContent.status_code, 503);
      assert.equal(result.structuredContent.body.detail, "Backend unavailable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
