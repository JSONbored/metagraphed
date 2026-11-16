// SN25 (Mainframe) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7041, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.ts -- which proves the tool wiring
// with synthetic surfaces -- this file pins SN25's registry surface
// (registry/subnets/ur.json) to the tool's contract, so a future
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
//
// [2026-11-15 infra#873 p3a] The availability sweep found the declared route
// answering 404 on an alive host and retired it from the callable set pending
// re-verification (probe.enabled:false -- retired, not merely broken), so this
// file now pins the non-callable state and the tool's refusal to call it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-25-mainframe-pdb-file-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/ur.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

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
  test("the registry surface exists and pins the sweep-retired (non-callable) config", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    // [2026-11-15 infra#873 p3a] route answers 404 on an alive host; retired
    // from the callable set pending url re-verification.
    assert.equal(SURFACE.probe?.enabled, false);
    assert.match(
      SURFACE.notes,
      /\[2026-11-15 infra#873 p3a\] declared route answers 404 on an alive host/,
    );
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
    assert.equal(result.content_type, "text/plain");
    assert.equal(result.truncated, false);
    // Non-JSON content-type -- returned as a raw string, not parsed.
    assert.equal(result.body, BODY);
    assert.ok((result.body as string).startsWith("HEADER"));
  });

  test("the call_subnet_surface MCP tool rejects the retired surface without fetching upstream", async () => {
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 25 }],
    };
    const deps = {
      readArtifact: async (_env: Row, path: string) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    let upstreamFetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      upstreamFetched = true;
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
        mockEnv(),
        deps,
      );
      const result = ((await response.json()) as Row).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /probe\.enabled:false/);
      assert.equal(upstreamFetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
