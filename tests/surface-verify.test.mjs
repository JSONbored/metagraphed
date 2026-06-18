import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  findSurface,
  primarySurfaceForNetuid,
  verifySurface,
  SURFACE_ID_PATTERN,
} from "../src/surface-verify.mjs";
import { handleRequest } from "../workers/api.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

describe("surface-verify core (#358)", () => {
  const surfaces = [
    {
      surface_id: "7:subnet-api:x",
      surface_key: "srf-subnetapix0000",
      netuid: 7,
      kind: "subnet-api",
      url: "https://x",
      provider: "p",
      auth_required: false,
      probe: { enabled: true },
    },
    {
      surface_id: "7:docs:y",
      netuid: 7,
      kind: "docs",
      url: "https://y",
      provider: "p",
      probe: { enabled: false },
    },
    {
      surface_id: "9:rpc:z",
      netuid: 9,
      kind: "subtensor-rpc",
      url: "https://z",
    },
    // a netuid whose every surface is probe-disabled → exercises the `|| forNetuid[0]` fallback
    {
      surface_id: "11:docs:only",
      netuid: 11,
      kind: "docs",
      url: "https://only",
      probe: { enabled: false },
    },
  ];

  test("findSurface matches by surface_id", () => {
    assert.equal(findSurface(surfaces, "7:subnet-api:x")?.url, "https://x");
    assert.equal(findSurface(surfaces, "srf-subnetapix0000")?.url, "https://x");
    assert.equal(findSurface(surfaces, "nope"), null);
    assert.equal(findSurface(null, "x"), null);
    assert.equal(findSurface(surfaces, 7), null);
  });

  test("primarySurfaceForNetuid prefers probe-enabled, else first", () => {
    assert.equal(
      primarySurfaceForNetuid(surfaces, 7)?.surface_id,
      "7:subnet-api:x",
    );
    assert.equal(primarySurfaceForNetuid(surfaces, 9)?.surface_id, "9:rpc:z");
    // all surfaces probe-disabled → falls back to the first
    assert.equal(
      primarySurfaceForNetuid(surfaces, 11)?.surface_id,
      "11:docs:only",
    );
    assert.equal(primarySurfaceForNetuid(surfaces, 99), null);
    assert.equal(primarySurfaceForNetuid(null, 7), null);
  });

  test("SURFACE_ID_PATTERN accepts catalog ids, rejects traversal/junk", () => {
    assert.ok(SURFACE_ID_PATTERN.test("7:subnet-api:x"));
    assert.ok(SURFACE_ID_PATTERN.test("nodies-finney-rpc"));
    assert.ok(!SURFACE_ID_PATTERN.test("../etc/passwd"));
    assert.ok(!SURFACE_ID_PATTERN.test("a b"));
    assert.ok(!SURFACE_ID_PATTERN.test("/slash"));
  });

  test("verifySurface maps a healthy probe to callable=true", async () => {
    const okProber = async (surface) => {
      assert.equal(surface.id, "7:subnet-api:x"); // surface_id→id bridge
      return {
        status: "ok",
        classification: "live",
        latency_ms: 42,
        status_code: 200,
        error: null,
        last_checked: "2026-06-16T00:00:00.000Z",
      };
    };
    const out = await verifySurface(surfaces[0], {}, okProber);
    assert.equal(out.surface_id, "7:subnet-api:x");
    assert.equal(out.surface_key, "srf-subnetapix0000");
    assert.equal(out.callable, true);
    assert.equal(out.latency_ms, 42);
    assert.equal(out.netuid, 7);
    assert.equal(out.probed_at, "2026-06-16T00:00:00.000Z");
  });

  test("verifySurface: dead/unsafe → not callable; missing fields → null", async () => {
    const dead = await verifySurface(surfaces[0], {}, async () => ({
      status: "failed",
      classification: "dead",
      error: "ECONNREFUSED",
    }));
    assert.equal(dead.callable, false);
    assert.equal(dead.latency_ms, null);
    assert.equal(dead.status_code, null);
    assert.equal(dead.probed_at, null);
    const unsafe = await verifySurface(surfaces[0], {}, async () => ({
      status: "degraded",
      classification: "unsafe",
      latency_ms: 10,
    }));
    assert.equal(unsafe.callable, false);
    // a surface with no provider/auth → defaults
    const bare = await verifySurface(
      { surface_id: "z", kind: "subnet-api", url: "https://z" },
      {},
      async () => ({ status: "ok", verified_at: "2026-06-16T01:00:00Z" }),
    );
    assert.equal(bare.provider, null);
    assert.equal(bare.auth_required, false);
    assert.equal(bare.netuid, null);
    assert.equal(bare.probed_at, "2026-06-16T01:00:00Z"); // verified_at fallback
  });
});

// --- worker endpoint: GET /api/v1/surfaces/{surface_id}/verify ----------------
describe("surface verify-now endpoint (#358)", () => {
  // A real non-RPC operational surface from the committed catalog (the worker
  // handler reads it via the imported readArtifact → env.ASSETS, so we use the
  // local artifact env, not an injected readArtifact).
  const SURFACE_ID = "sn-6-numinous-api-health";
  const SURFACE_KEY = "srf-4d92fe6304cbb843";
  const req = (id) =>
    new Request(`https://metagraph.sh/api/v1/surfaces/${id}/verify`);

  const withGlobals = async ({ cache, fetchImpl }, run) => {
    const oc = globalThis.caches;
    const of = globalThis.fetch;
    if (cache !== undefined) globalThis.caches = { default: cache };
    if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
    try {
      return await run();
    } finally {
      globalThis.caches = oc;
      globalThis.fetch = of;
    }
  };
  const okFetch = async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  test("404s on an unknown surface_id without probing", async () => {
    let fetched = false;
    await withGlobals(
      {
        fetchImpl: async () => {
          fetched = true;
          return okFetch();
        },
      },
      async () => {
        const res = await handleRequest(
          req("zzz-not-real"),
          createLocalArtifactEnv(),
          {},
        );
        assert.equal(res.status, 404);
        assert.equal((await res.json()).error.code, "surface_not_found");
      },
    );
    assert.equal(fetched, false);
  });

  test("503 when the catalog is unavailable", async () => {
    const badEnv = {
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const res = await handleRequest(req(SURFACE_ID), badEnv, {});
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "surfaces_unavailable");
  });

  test("429 when the rate limiter rejects", async () => {
    const limitedEnv = createLocalArtifactEnv();
    limitedEnv.RPC_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const res = await handleRequest(req(SURFACE_ID), limitedEnv, {});
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, "verify_rate_limited");
  });

  test("probes a catalogued surface, then serves the 60s cache", async () => {
    const store = new Map();
    const cache = {
      async match(key) {
        return store.get(key.url);
      },
      async put(key, res) {
        store.set(key.url, res);
      },
    };
    await withGlobals({ cache, fetchImpl: okFetch }, async () => {
      const ctx = { waitUntil: (p) => p };
      const res = await handleRequest(
        req(SURFACE_ID),
        createLocalArtifactEnv(),
        ctx,
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.surface_id, SURFACE_ID);
      assert.equal(typeof body.data.callable, "boolean");
      assert.equal(body.data.from_cache, false);
      // second call → served from the cached entry
      const res2 = await handleRequest(
        req(SURFACE_ID),
        createLocalArtifactEnv(),
        ctx,
      );
      assert.equal((await res2.json()).data.from_cache, true);
    });
  });

  test("accepts stable surface_key as the verify identifier", async () => {
    await withGlobals({ fetchImpl: okFetch }, async () => {
      const res = await handleRequest(
        req(SURFACE_KEY),
        createLocalArtifactEnv(),
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.surface_id, SURFACE_ID);
      assert.equal(body.data.surface_key, SURFACE_KEY);
    });
  });

  test("blocks catalogued hostnames that resolve to private addresses", async () => {
    let surfaceFetches = 0;
    await withGlobals(
      {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
            return new Response(
              JSON.stringify({
                Answer: [{ type: 1, data: "127.0.0.1" }],
              }),
              { headers: { "content-type": "application/dns-json" } },
            );
          }
          surfaceFetches += 1;
          return okFetch();
        },
      },
      async () => {
        const res = await handleRequest(
          req(SURFACE_ID),
          createLocalArtifactEnv(),
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.callable, false);
        assert.equal(body.data.classification, "unsafe");
        assert.equal(body.data.error, "unsafe URL");
      },
    );
    assert.equal(surfaceFetches, 0);
  });
});

// --- MCP tool: verify_integration --------------------------------------------
describe("verify_integration MCP tool (#358)", () => {
  const CATALOG = {
    surfaces: [
      {
        surface_id: "x:api:1",
        surface_key: "srf-xapi100000000",
        netuid: 5,
        kind: "subnet-api",
        url: "https://x.example/api",
        provider: "p",
        auth_required: false,
        probe: { method: "GET", expect: "json", timeout_ms: 8000 },
      },
    ],
  };
  const deps = {
    readArtifact: async (_e, path) =>
      path === "/metagraph/operational-surfaces.json"
        ? { ok: true, data: CATALOG }
        : { ok: false, status: 404 },
  };
  const call = async (args) => {
    const of = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const response = await handleMcpRequest(
        new Request("https://metagraph.sh/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "verify_integration", arguments: args },
          }),
        }),
        {},
        deps,
      );
      return (await response.json()).result;
    } finally {
      globalThis.fetch = of;
    }
  };

  test("verifies by surface_id and by netuid", async () => {
    const bySurface = await call({ surface_id: "x:api:1" });
    assert.equal(bySurface.isError, false);
    assert.equal(bySurface.structuredContent.surface_id, "x:api:1");
    const byKey = await call({ surface_id: "srf-xapi100000000" });
    assert.equal(byKey.isError, false);
    assert.equal(byKey.structuredContent.surface_id, "x:api:1");
    assert.equal(byKey.structuredContent.surface_key, "srf-xapi100000000");
    const byNetuid = await call({ netuid: 5 });
    assert.equal(byNetuid.structuredContent.surface_id, "x:api:1");
  });

  test("blocks rebinding catalogued hostnames before probing", async () => {
    let surfaceFetches = 0;
    const of = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(
          JSON.stringify({
            Answer: [{ type: 1, data: "10.0.0.5" }],
          }),
          { headers: { "content-type": "application/dns-json" } },
        );
      }
      surfaceFetches += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
              name: "verify_integration",
              arguments: { surface_id: "x:api:1" },
            },
          }),
        }),
        {},
        deps,
      );
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.callable, false);
      assert.equal(result.structuredContent.classification, "unsafe");
    } finally {
      globalThis.fetch = of;
    }
    assert.equal(surfaceFetches, 0);
  });

  test("error paths require no probe", async () => {
    assert.equal((await call({ surface_id: "bad id!" })).isError, true);
    assert.equal((await call({ surface_id: "missing" })).isError, true);
    assert.equal((await call({ netuid: 999 })).isError, true);
    assert.equal((await call({})).isError, true);
  });
});
