// #5544: free-text query filters (`q`, `provider`, `id`, `review_state`,
// `reason_codes`) were all built from a shared `textSchema = { type: "string" }`
// with no maxLength, unlike every other validated param (pallet/method 64,
// call_module 100, netuids 767). An arbitrarily long value reached searchRows,
// which tokenizes it and scans every row's haystack per term — unbounded
// per-request work driven by an unbounded input. `q` is now searchTextSchema
// (200, generous for search prose) and the exact-ish filters are
// filterTextSchema (100, matching the structured-token precedent).
//
// #10218 moved the enforcement: the bound is read off the same schema, but by
// the router's single parse rather than by list-query's own copy of the check,
// so these assert the boundary a request actually meets.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseRouteQuery } from "../src/route-query.ts";

function queryError(path: string) {
  const parsed = parseRouteQuery(new URL(`https://api.metagraph.sh${path}`));
  return "error" in parsed ? parsed.error : null;
}

describe("free-text query filters enforce a maxLength (#5544)", () => {
  // `economics` is a searchable collection (search_keys > 0), so it exposes `q`.
  test("rejects a q longer than 200 chars", () => {
    const error = queryError(`/api/v1/economics?q=${"a".repeat(201)}`);
    assert.equal(error!.parameter, "q");
    assert.equal(
      error!.message,
      `q must be 200 characters or fewer. Received: "${"a".repeat(40)}...".`,
    );
  });

  test("accepts a q of exactly 200 chars", () => {
    assert.equal(queryError(`/api/v1/economics?q=${"a".repeat(200)}`), null);
  });

  // `endpoints` carries the exact-ish `provider` filter (filterTextSchema, 100).
  test("rejects a provider filter longer than 100 chars", () => {
    const error = queryError(`/api/v1/endpoints?provider=${"a".repeat(101)}`);
    assert.equal(error!.parameter, "provider");
    assert.equal(
      error!.message,
      `provider must be 100 characters or fewer. Received: "${"a".repeat(40)}...".`,
    );
  });

  test("accepts a provider filter of exactly 100 chars", () => {
    assert.equal(
      queryError(`/api/v1/endpoints?provider=${"a".repeat(100)}`),
      null,
    );
  });

  // A searchable collection with no q param at all is still valid — the bound
  // only applies when q is present.
  test("accepts a searchable route with no q param", () => {
    assert.equal(queryError("/api/v1/economics"), null);
  });

  // `providers` carries the exact-ish `id` filter — same filterTextSchema bound.
  test("rejects an id filter longer than 100 chars", () => {
    const error = queryError(`/api/v1/providers?id=${"a".repeat(101)}`);
    assert.equal(error!.parameter, "id");
    assert.equal(
      error!.message,
      `id must be 100 characters or fewer. Received: "${"a".repeat(40)}...".`,
    );
  });
});
