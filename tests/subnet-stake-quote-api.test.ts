// Route-dispatch coverage for GET /api/v1/subnets/{netuid}/stake-quote (#5235):
// drives the real api.mjs router end-to-end so the path-pattern match + handler
// call are exercised. Handler/resolver branch detail lives in
// subnet-stake-quote-handler.test.mjs; the pure math in stake-quote.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const req = (path: string) => new Request(`https://api.metagraph.sh${path}`);

const ECONOMICS = {
  generated_at: "2026-07-14T00:00:00.000Z",
  subnets: [
    {
      netuid: 64,
      tao_in_pool_tao: 201959.938748425,
      alpha_in_pool: 2730860.150574127,
    },
  ],
};

function env() {
  const base = createLocalArtifactEnv();
  const artifactBody = () => ({
    async json() {
      return ECONOMICS;
    },
    async text() {
      return JSON.stringify(ECONOMICS);
    },
  });
  base.METAGRAPH_ARCHIVE = {
    async get(key: unknown) {
      return String(key).replace(/^latest\//, "") === "economics.json"
        ? artifactBody()
        : null;
    },
  };
  base.ASSETS = {
    async fetch(request: Request) {
      return new URL(request.url).pathname === "/metagraph/economics.json"
        ? Response.json(ECONOMICS)
        : new Response("{}", { status: 404 });
    },
  };
  base.METAGRAPH_ALLOW_R2_STATIC_FALLBACK = "true";
  return base;
}

describe("GET /api/v1/subnets/{netuid}/stake-quote route", () => {
  test("dispatches to a 200 quote", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/stake-quote?amount=1000&direction=stake"),
      env(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 64);
    assert.equal(body.data.expected_out_unit, "alpha");
    assert.ok(body.data.price_impact_pct > 0);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/stake-quote?amount=1&foo=bar"),
      env(),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("a non-stake-quote subnet path falls through the dispatch (no match)", async () => {
    // Exercises the pattern's no-match branch — the request flows past the
    // stake-quote check to the router's not-found handling.
    const res = await handleRequest(
      req("/api/v1/subnets/64/not-a-real-subroute"),
      env(),
      {},
    );
    assert.notEqual(res.status, 200);
  });
});
