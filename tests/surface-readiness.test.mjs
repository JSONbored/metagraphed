import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { computeSurfaceReadiness, handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// computeSurfaceReadiness is the pure projection at the heart of
// /api/v1/surfaces/readiness; these craft surfaces directly so every clarity /
// tier / pass-through branch is exercised without built data artifacts.
describe("computeSurfaceReadiness", () => {
  test("full callable surface scores 100 and is 'ready'", () => {
    const r = computeSurfaceReadiness({
      id: "s1",
      key: "srf-1",
      netuid: 1,
      subnet_slug: "apex",
      subnet_name: "Apex",
      kind: "subnet-api",
      provider: "acme",
      authority: "official",
      url: "https://api.example.com",
      auth_required: true,
      auth: { scheme: "bearer", location: "header", name: "Authorization" },
      rate_limit: { requests: 100, window: "1m", scope: "per-key" },
      schema_status: "machine-readable",
      schema_url: "https://api.example.com/openapi.json",
      stale: false,
      last_verified_at: "2026-06-01T00:00:00.000Z",
    });
    assert.equal(r.auth_clarity_score, 3);
    assert.equal(r.rate_limit_clarity_score, 2);
    assert.equal(r.schema_clarity_score, 2);
    assert.equal(r.readiness_score, 100);
    assert.equal(r.callable, true);
    assert.equal(r.readiness_tier, "ready");
    assert.equal(r.surface_id, "s1");
    assert.equal(r.surface_key, "srf-1");
    assert.equal(r.schema_url, "https://api.example.com/openapi.json");
    assert.deepEqual(r.auth, {
      scheme: "bearer",
      location: "header",
      name: "Authorization",
    });
  });

  test("partial callable surface is 'callable-unverified'", () => {
    const r = computeSurfaceReadiness({
      id: "s2",
      netuid: 2,
      kind: "openapi",
      url: "https://x",
      auth: { scheme: "bearer" }, // scheme only → clarity 1
      rate_limit: { requests: 10, window: "1s" }, // no scope → clarity 1
      schema_status: "ui-only", // → clarity 1
    });
    assert.equal(r.auth_clarity_score, 1);
    assert.equal(r.rate_limit_clarity_score, 1);
    assert.equal(r.schema_clarity_score, 1);
    assert.equal(r.readiness_score, 43); // round(3/7*100)
    assert.equal(r.readiness_tier, "callable-unverified");
  });

  test("bare callable surface with nothing documented is 'blocked'", () => {
    const r = computeSurfaceReadiness({
      id: "s3",
      netuid: 3,
      kind: "sse",
      url: "https://x",
      // no auth, no rate_limit, no schema_status
    });
    assert.equal(r.auth_clarity_score, 0);
    assert.equal(r.rate_limit_clarity_score, 0);
    assert.equal(r.schema_clarity_score, 0);
    assert.equal(r.readiness_score, 0);
    assert.equal(r.callable, true);
    assert.equal(r.readiness_tier, "blocked");
    // absent optionals pass through as null
    assert.equal(r.auth, null);
    assert.equal(r.rate_limit, null);
    assert.equal(r.schema_status, null);
    assert.equal(r.schema_url, null);
    assert.equal(r.provider, null);
    assert.equal(r.authority, null);
    assert.equal(r.auth_required, null);
    assert.equal(r.surface_key, null);
  });

  test("non-callable (reference) surface is tier 'reference' regardless of score", () => {
    const r = computeSurfaceReadiness({
      id: "s4",
      netuid: 4,
      kind: "docs",
      url: "https://x",
      auth: null,
    });
    assert.equal(r.callable, false);
    assert.equal(r.readiness_tier, "reference");
  });

  test("auth value_format (no name) and no location still credit the third auth point", () => {
    const r = computeSurfaceReadiness({
      id: "s5",
      netuid: 5,
      kind: "subnet-api",
      url: "https://x",
      auth: { scheme: "apiKey", value_format: "uuid" }, // scheme + value_format → 2
      rate_limit: { requests: 5, window: "1s", scope: "per-ip" },
      schema_status: "machine-readable",
    });
    assert.equal(r.auth_clarity_score, 2);
    assert.equal(r.rate_limit_clarity_score, 2);
    assert.equal(r.schema_clarity_score, 2);
    assert.equal(r.readiness_score, 86); // round(6/7*100)
    assert.equal(r.readiness_tier, "ready");
  });

  test("auth with only scheme + location credits two points", () => {
    const r = computeSurfaceReadiness({
      id: "s6",
      netuid: 6,
      kind: "subnet-api",
      url: "https://x",
      auth: { scheme: "bearer", location: "query" }, // scheme + location → 2
    });
    assert.equal(r.auth_clarity_score, 2);
  });
});

// surfaces.json is an r2-tier artifact; createLocalArtifactEnv serves the real
// built copy via its archive binding. A binding-less env exercises the cold path
// (readArtifact falls through to a not-ok result → empty-but-valid envelope).
const COLD_ENV = {
  ASSETS: {
    async fetch() {
      return new Response("not found", { status: 404 });
    },
  },
};

describe("GET /api/v1/surfaces/readiness", () => {
  const env = createLocalArtifactEnv();
  const get = async (path, e = env) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      e,
      {},
    );
    return { status: res.status, body: await res.json() };
  };

  test("projects readiness rows from the curated surfaces tier", async () => {
    const { status, body } = await get("/api/v1/surfaces/readiness?limit=5");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.data.surface_count, "number");
    assert.ok(body.data.surface_count > 0);
    assert.ok(body.data.surfaces.length <= 5);
    for (const s of body.data.surfaces) {
      assert.equal(typeof s.readiness_score, "number");
      assert.equal(typeof s.surface_id, "string");
      assert.ok(
        ["ready", "callable-unverified", "blocked", "reference"].includes(
          s.readiness_tier,
        ),
      );
    }
    assert.equal(body.meta.artifact_path, "/metagraph/surfaces/readiness.json");
  });

  test("filters by readiness_tier", async () => {
    const { body } = await get(
      "/api/v1/surfaces/readiness?readiness_tier=reference&limit=10",
    );
    assert.ok(body.data.surfaces.length > 0);
    for (const s of body.data.surfaces) {
      assert.equal(s.readiness_tier, "reference");
    }
  });

  test("filters by callable", async () => {
    const { body } = await get(
      "/api/v1/surfaces/readiness?callable=true&limit=10",
    );
    assert.ok(body.data.surfaces.length > 0);
    for (const s of body.data.surfaces) {
      assert.equal(s.callable, true);
    }
  });

  test("sorts by readiness_score descending", async () => {
    const { body } = await get(
      "/api/v1/surfaces/readiness?sort=readiness_score&order=desc&limit=5",
    );
    const scores = body.data.surfaces.map((s) => s.readiness_score);
    assert.deepEqual(
      scores,
      [...scores].sort((a, b) => b - a),
    );
  });

  test("returns an empty-but-valid envelope when the surfaces tier is cold", async () => {
    const { status, body } = await get("/api/v1/surfaces/readiness", COLD_ENV);
    assert.equal(status, 200);
    assert.equal(body.data.surface_count, 0);
    assert.deepEqual(body.data.surfaces, []);
  });

  test("rejects invalid query params with a 400 invalid_query envelope", async () => {
    const cases = [
      ["/api/v1/surfaces/readiness?limit=0", "limit"],
      ["/api/v1/surfaces/readiness?kind=bogus", "kind"],
      ["/api/v1/surfaces/readiness?readiness_tier=bogus", "readiness_tier"],
      ["/api/v1/surfaces/readiness?sort=bogus", "sort"],
    ];
    for (const [path, parameter] of cases) {
      const { status, body } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(body.error.code, "invalid_query", path);
      assert.equal(body.meta.parameter, parameter, path);
    }
  });
});
