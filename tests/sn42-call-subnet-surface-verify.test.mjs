// SN42 (Gopher) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7056, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN42's *real* registry surface config
// (registry/subnets/gopher.json) to the tool's contract, so a future edit that
// regresses its auth gating is caught here.
//
// The surface is the credentialed Gopher Data API live search endpoint
// (sn-42-gopher-ai-subnet-api, https://data.gopher-ai.com/api/v1/search/live).
// Issue #7056 lists it as HEAD / bearer auth / Phase 3 territory. Registry
// already has auth_required:true, bearer Authorization, and probe.enabled:false
// (method HEAD). Live-verified 2026-07-21: anonymous HEAD and GET both returned
// HTTP 530 Cloudflare origin error ("error code: 1033") -- not anonymously
// callable. Credential passthrough is Phase 3 (#7016), out of scope here.
// Registry already matched reality -- no registry edit needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-42-gopher-ai-subnet-api";
const NETUID = 42;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/gopher.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callToolWithSurface(surface, upstreamResponse) {
  const catalog = {
    surfaces: [{ ...surface, surface_id: surface.id, netuid: NETUID }],
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
            arguments: { surface_id: surface.id },
          },
        }),
      }),
      {},
      deps,
    );
    return (await response.json()).result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("SN42 Gopher call_subnet_surface verification (#7056)", () => {
  describe("sn-42-gopher-ai-subnet-api (auth required -- Phase 3 territory)", () => {
    test("registry surface exists and correctly declares bearer auth + disabled probe", () => {
      assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
      assert.equal(SURFACE.kind, "subnet-api");
      // Live-confirmed: anonymous HEAD/GET return HTTP 530 (Cloudflare origin
      // error 1033) -- not anonymously callable. auth_required:true + bearer
      // match reality; credential passthrough is Phase 3 (#7016).
      assert.equal(SURFACE.auth_required, true);
      assert.equal(SURFACE.auth?.scheme, "bearer");
      assert.equal(SURFACE.auth?.location, "header");
      assert.equal(SURFACE.auth?.name, "Authorization");
      // POST-only credentialed endpoint; recurring read probes stay disabled.
      // Issue #7056 lists probe method HEAD -- pin that declared method.
      assert.equal(SURFACE.probe?.enabled, false);
      assert.equal(SURFACE.probe?.method, "HEAD");
      assert.equal(
        SURFACE.url,
        "https://data.gopher-ai.com/api/v1/search/live",
      );
    });

    test("the call_subnet_surface MCP tool rejects it outright without fetching upstream", async () => {
      // In production this surface may never reach the auth gate if the
      // operational catalog filters probe.enabled:false surfaces (not_found).
      // This test injects the real registry config into a catalog fixture to
      // pin the earlier line of defense: even if it were resolvable,
      // auth_required:true blocks the call before any fetch.
      let upstreamFetched = false;
      const result = await callToolWithSurface(SURFACE, () => {
        upstreamFetched = true;
        return jsonResponse({});
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /auth_required/);
      assert.equal(upstreamFetched, false);
    });
  });
});
