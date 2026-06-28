import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { API_ROUTES } from "../src/contracts.mjs";
import { apiRouteUrl } from "../scripts/smoke-live-api.mjs";

// PR-time guard for the recurring #1682 class: the live smoke substitutes path
// placeholders ({netuid}/{slug}/{date}/{uid}/{hash}/{ref}/{ss58}/{surface_id}) before
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
});
