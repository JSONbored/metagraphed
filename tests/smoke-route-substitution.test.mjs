import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { API_ROUTES } from "../src/contracts.mjs";
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
