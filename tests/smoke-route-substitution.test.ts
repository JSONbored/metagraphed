import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { API_ROUTES } from "../src/contracts.ts";
import {
  apiRouteUrl,
  fixtureSurfaceIdFromIndex,
  liveSmokeApiRoutes,
} from "../scripts/smoke-live-api.ts";

// PR-time guard for the recurring #1682 class: the live smoke substitutes path
// placeholders ({netuid}/{slug}/{date}/{uid}/{hash}/{ref}/{ss58}) before
// fetching. A route that grows a new placeholder without a matching
// substitution would otherwise only blow up at publish time. Assert that
// apiRouteUrl yields a fully-substituted URL for every registered route.
describe("smoke route substitution", () => {
  const sampleDate = "2026-06-24";

  for (const route of API_ROUTES) {
    test(`${route.path} has no leftover placeholder`, () => {
      const url = apiRouteUrl(route.path, sampleDate);
      assert.ok(
        !url.includes("{"),
        `${route.path}: apiRouteUrl left an unsubstituted placeholder (${url})`,
      );
    });
  }

  // REGRESSION: /api/v1/compare/validators requires `hotkeys` -- a bare GET is
  // a 400 invalid_query, not a route failure (same #1682 class as
  // /api/v1/compare's `netuids` and stake-quote's `amount`, confirmed live
  // against production: the smoke step failed with "hotkeys is required" until
  // this special-case was added).
  test("/api/v1/compare/validators URL includes a hotkeys query param", () => {
    const url = new URL(apiRouteUrl("/api/v1/compare/validators", sampleDate));
    assert.ok(
      url.searchParams.get("hotkeys"),
      "expected apiRouteUrl to set a hotkeys query param for /api/v1/compare/validators",
    );
  });

  test("fixture detail live smoke is included when a surface id is available", () => {
    assert.equal(
      liveSmokeApiRoutes(null).some((route) => route.id === "fixture-detail"),
      false,
    );
    assert.equal(
      liveSmokeApiRoutes("7:subnet-api:new_v2").some(
        (route) => route.id === "fixture-detail",
      ),
      true,
    );
  });

  test("fixture detail URL uses the discovered surface id", () => {
    const url = apiRouteUrl("/api/v1/fixtures/{surface_id}", sampleDate, {
      surfaceId: "91:subnet-api:live_v1",
    });
    assert.equal(
      new URL(url).pathname,
      "/api/v1/fixtures/91:subnet-api:live_v1",
    );
  });

  test("fixture detail live smoke can derive a surface id from the fixture index", () => {
    assert.equal(
      fixtureSurfaceIdFromIndex({
        data: {
          fixtures: [{ surface_id: "7:subnet-api:new_v2" }],
        },
      }),
      "7:subnet-api:new_v2",
    );
    assert.equal(fixtureSurfaceIdFromIndex({ data: { fixtures: [] } }), null);
  });
});

describe("the live smoke set is GET-only (#9650)", () => {
  test("no route with a body is smoked", () => {
    // Every check in the runner asserts a CACHEABLE READ CONTRACT -- 200, CORS,
    // an ETag, a contract-version header -- so a route with a request body has
    // nothing the assertions are about. The runner fetches with a plain GET, so
    // including one draws 405 and fails the whole publish lane.
    //
    // This is not hypothetical. Until #9101 registered /api/v1/ask as POST,
    // every route in the contract was a GET, so "all routes" and "the read
    // surface" were the same set. Publishing broke on 2026-08-02 and stayed
    // broken for four days, taking `webhooks:dispatch` -- later in the same
    // job -- with it.
    for (const route of liveSmokeApiRoutes("7:subnet-api:new_v2")) {
      assert.equal(
        route.method ?? "GET",
        "GET",
        `${route.path} is ${route.method}; the smoke runner only issues GET`,
      );
    }
  });

  test("and the contract does still carry a non-GET route, or this proves nothing", () => {
    // A filter with nothing to filter passes forever. Assert the input set
    // really does contain the case being excluded.
    assert.equal(
      API_ROUTES.some((route) => (route.method ?? "GET") !== "GET"),
      true,
      "no non-GET route in the contract -- this guard is now vacuous",
    );
    assert.equal(
      liveSmokeApiRoutes("7:subnet-api:new_v2").length < API_ROUTES.length,
      true,
      "the smoke set must be strictly smaller than the contract",
    );
  });
});

describe("the live smoke supplies every required query param (#9663)", () => {
  // Routes whose bare GET is a correct 400. The smoke iterates the whole
  // contract, so each one has to be given what it requires or the publish lane
  // fails on a route that is working exactly as designed.
  //
  // The contract does not declare requiredness, so this list cannot be derived
  // -- which is why it is asserted here instead: each entry was found by a
  // failing production publish, one per run, and this is what stops the next
  // one being found the same way.
  const REQUIRES = [
    ["/api/v1/compare", "netuids"],
    ["/api/v1/compare/validators", "hotkeys"],
    ["/api/v1/subnets/{netuid}/stake-quote", "amount"],
    ["/api/v1/search/semantic", "q"],
  ] as const;

  test("each known required param is present in the built URL", () => {
    for (const [routePath, param] of REQUIRES) {
      const url = new URL(apiRouteUrl(routePath, "2026-08-06"));
      assert.ok(
        url.searchParams.get(param),
        `${routePath} needs ?${param}= or it answers 400`,
      );
    }
  });

  test("every route in the smoke set is one the contract still has", () => {
    // A required-param entry for a route that no longer exists is a guard that
    // silently stops guarding.
    const paths = new Set(API_ROUTES.map((route) => route.path));
    for (const [routePath] of REQUIRES) {
      assert.ok(paths.has(routePath), `${routePath} is no longer a route`);
    }
  });
});
