// SN25 (Mainframe) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7041, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN25's registry surface
// (registry/subnets/mainframe.json) to the tool's contract, so a future
// edit that regresses its callability (flipping to HEAD, marking it
// auth_required, disabling its probe) is caught here.
//
// The surface is the public no-auth PDB structure-file API
// (sn-25-mainframe-pdb-file-api, GET
// https://sn25.nyc3.digitaloceanspaces.com/pdb_files/1ubq.pdb, text, single
// fixed endpoint -- no schema). Live-verified 2026-07-21: the origin serves
// this object with `Content-Encoding: gzip`, so a raw curl without
// `--compressed` sees only the compressed bytes -- but `fetch()` (both
// Node's and the Workers runtime's, exactly what callSubnetSurface uses)
// transparently decompresses any Content-Encoding-tagged response, so the
// real end-to-end call correctly returns HTTP 200 text/plain plain-text PDB
// structure data. Re-verified with `curl --compressed` to confirm the
// decompressed body genuinely is PDB text, matching the registry's
// documented behavior -- the surface works exactly as configured. The
// fixture below mirrors that decompressed content (an excerpt) rather than
// fetching it, keeping the test hermetic while still exercising the
// text (non-JSON) parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const SURFACE_ID = "sn-25-mainframe-pdb-file-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../registry/subnets/mainframe.json", import.meta.url),
    ),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find((surface) => surface.id === SURFACE_ID);

// An excerpt of the live (fetch-decompressed) 1ubq.pdb response body.
const BODY =
  "HEADER    CHROMOSOMAL PROTEIN                     02-JAN-87   1UBQ              \n" +
  "TITLE     STRUCTURE OF UBIQUITIN REFINED AT 1.8 ANGSTROMS RESOLUTION            \n" +
  "COMPND    MOL_ID: 1;                                                            \n";

function upstreamResponse() {
  return new Response(BODY, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

describe("SN25 Mainframe call_subnet_surface verification (#7041)", () => {
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
    assert.equal(SURFACE.probe?.method, "GET");
    // Plain-text PDB data, not JSON.
    assert.equal(SURFACE.probe?.expect, "any");
    assert.equal(
      SURFACE.url,
      "https://sn25.nyc3.digitaloceanspaces.com/pdb_files/1ubq.pdb",
    );
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real text body using the surface's own url + GET", async () => {
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
    assert.equal(result.content_type, "text/plain");
    assert.equal(result.truncated, false);
    // Non-JSON content-type -- returned as a raw string, not parsed.
    assert.equal(result.body, BODY);
    assert.ok(result.body.startsWith("HEADER"));
  });

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 25 }],
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
      assert.equal(result.structuredContent.body, BODY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
