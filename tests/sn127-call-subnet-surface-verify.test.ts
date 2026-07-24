// SN127 (Astrid) end-to-end verification for the call_subnet_surface MCP
// tool (metagraphed#7135, MCP execute Phase 1 follow-up #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN127's *real* registry surface config
// (registry/subnets/astrid.json) to the tool's contract, so a future edit
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
    fileURLToPath(new URL("../registry/subnets/astrid.json", import.meta.url)),
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
  test("the registry surface exists and is configured to be callable", () => {
    assert.ok(SURFACE, `registry surface ${SURFACE_ID} is present`);
    assert.equal(SURFACE.kind, "subnet-api");
    assert.equal(SURFACE.auth_required, false);
    assert.equal(SURFACE.probe?.enabled, true);
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

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id", async () => {
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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      // DoH lookups for the SSRF guard: no Answer -> fail open (safe).
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
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
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, SURFACE_ID);
      assert.equal(result.structuredContent.status_code, 200);
      assert.equal(
        result.structuredContent.body.competitions[0].name,
        "Miners Showdown 3",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
