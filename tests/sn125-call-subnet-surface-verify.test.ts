// SN125 (8 Ball) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7133, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN125's *real* registry surface config
// (registry/subnets/8-ball.json) to the tool's contract, so a future edit that
// regresses its callability (flipping to HEAD, marking it auth_required,
// disabling its probe) is caught here.
//
// The surface is the public no-auth 8 Ball markets list endpoint
// (sn-125-eightball-subnet-api, GET https://8ball125.com/api/markets, single
// fixed endpoint -- no schema). Live-verified 2026-07-21 to return HTTP 502
// text/html nginx Bad Gateway HTML -- the same origin outage already
// documented in the registry notes and gap_notes. The tool is a
// safety-checked passthrough: it returns that status + body rather than
// inventing success. Registry already matched a healthy origin (URL, GET,
// auth_required false; probe.expect json for the documented JSON markets
// payload) -- no registry edit needed. Sibling routes named in notes were
// not registered: path shapes cannot be confirmed while the API origin is
// down (#7133). The fixture below mirrors the live 502 HTML rather than
// fetching it, keeping the test hermetic while still exercising the text
// return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-125-eightball-subnet-api";
const NETUID = 125;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/8-ball.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// Faithful copy of the live https://8ball125.com/api/markets nginx 502 body
// observed 2026-07-21 (CRLF line endings as served).
const LIVE_HTML =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
const STATUS = 502;
const CONTENT_TYPE = "text/html";

function upstreamResponse() {
  return new Response(LIVE_HTML, {
    status: STATUS,
    headers: { "content-type": CONTENT_TYPE },
  });
}

describe("SN125 8 Ball call_subnet_surface verification (#7133)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    // Healthy responses are JSON markets payloads; expect json is correct for
    // the documented happy path. Live outage returns HTML, which the tool
    // still passthroughs as text regardless of probe.expect.
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(SURFACE.url, "https://8ball125.com/api/markets");
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the live 502 HTML body using the surface's own url + GET", async () => {
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
    // Passthrough: network/fetch succeeded; HTTP 502 is surfaced as
    // status_code + text body, not as tool-level ok:false.
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 502);
    assert.equal(result.content_type, CONTENT_TYPE);
    assert.equal(result.truncated, false);
    assert.equal(result.body, LIVE_HTML);
    assert.match(result.body, /502 Bad Gateway/);
    assert.match(result.body, /nginx/);
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
        {},
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 502);
      assert.equal(result.structuredContent.body, LIVE_HTML);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
