// SN127 (Astrid) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7135, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.ts -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN127's *real* registry surface config
// (registry/subnets/zils.json) to the tool's contract, so a future edit
// that regresses its callability (flipping method, marking it auth_required,
// disabling its probe, changing the path) is caught here.
//
// The surface is the public no-auth Astrid Arena completed-competitions feed
// (GET https://arena-api.astrid.global/public/arena/completed-competitions,
// JSON, no schema -- a single fixed endpoint). Verified live to return HTTP
// 200 application/json; charset=utf-8 with a `{competitions:[...]}` body
// (HEAD also 200, so GET is a superset-safe probe). The fixture below mirrors
// that live response's top-level shape rather than fetching it, keeping the
// test hermetic while still exercising charset-suffixed JSON parsing against
// the upstream's actual field set.
//
// [2026-11-15 infra#873 p3a] The availability sweep found every declared
// Astrid route answering 404 on an alive host -- SN127 is now "Zils" on chain
// and the old product's API is fully withdrawn; the audit recommends retiring
// the provider entry and re-curating under the new identity. The surface is
// retired from the callable set pending that re-curation (probe.enabled:false
// -- retired, not merely broken), so this file now pins the non-callable state
// and the tool's refusal to call it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import type { Row } from "./row-type.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";

const SURFACE_ID = "sn-127-astrid-subnet-api";

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/zils.json", import.meta.url)),
    "utf8",
  ),
);
const SURFACE = registry.surfaces.find(
  (surface: Row) => surface.id === SURFACE_ID,
);

// A faithful subset of the live
// https://arena-api.astrid.global/public/arena/completed-competitions response.
const SN127_BODY = {
  competitions: [
    {
      competitionId: "190482a8-70b8-463d-b6c5-d1808bc7db9f",
      name: "Miners Showdown 3",
      startTime: "2026-06-01T00:00:01.326Z",
      endTime: "2026-06-28T23:59:00.000Z",
      initialBalance: 10000,
    },
  ],
};

function sn127Response() {
  return new Response(JSON.stringify(SN127_BODY), {
    status: 200,
    // Live upstream returns charset-suffixed JSON; the tool must still parse it.
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("SN127 Astrid call_subnet_surface verification (#7135)", () => {
  test("the registry surface exists and pins the sweep-retired (non-callable) config", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    // [2026-11-15 infra#873 p3a] route answers 404 on an alive host; retired
    // from the callable set pending re-curation under the Zils identity.
    assert.equal(SURFACE.probe?.enabled, false);
    assert.match(
      SURFACE.notes,
      /\[2026-11-15 infra#873 p3a\] declared route answers 404 on an alive host/,
    );
    assert.equal(SURFACE.probe?.method, "GET");
    assert.equal(SURFACE.probe?.expect, "json");
    assert.equal(
      SURFACE.url,
      "https://arena-api.astrid.global/public/arena/completed-competitions",
    );
    // Single fixed endpoint -- no machine-readable schema is expected.
    assert.equal(SURFACE.schema_url, undefined);
  });

  test("callSubnetSurface returns the real JSON body using the surface's own url + GET", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const result = await callSubnetSurface(SURFACE, {
      isUnsafeUrl: async () => false,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedMethod = init!.method;
        return sn127Response();
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, SURFACE.url);
    assert.equal(requestedMethod, "GET");
    assert.equal(result.status_code, 200);
    assert.equal(result.truncated, false);
    assert.ok(Array.isArray((result.body as Row).competitions));
    assert.equal(
      (result.body as Row).competitions[0].competitionId,
      "190482a8-70b8-463d-b6c5-d1808bc7db9f",
    );
    assert.equal(
      (result.body as Row).competitions[0].name,
      "Miners Showdown 3",
    );
  });

  test("the call_subnet_surface MCP tool rejects the retired surface without fetching upstream", async () => {
    // operational-surfaces.json flattens each registry surface's `id` to a
    // top-level `surface_id`; build that catalog shape from the real surface.
    const catalog = {
      surfaces: [{ ...SURFACE, surface_id: SURFACE.id, netuid: 127 }],
    };
    const deps = {
      readArtifact: async (_env: Row, path: string) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    let upstreamFetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      upstreamFetched = true;
      return sn127Response();
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
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /probe\.enabled:false/);
      assert.equal(upstreamFetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
