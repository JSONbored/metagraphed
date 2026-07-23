// #5544: free-text query filters (`q`, `provider`, `id`, `review_state`,
// `reason_codes`) were all built from a shared `textSchema = { type: "string" }`
// with no maxLength, unlike every other validated param (pallet/method 64,
// call_module 100, netuids 767). An arbitrarily long value passed
// validateListQuery untouched and reached searchRows, which tokenizes it and
// scans every row's haystack per term — unbounded per-request work driven by an
// unbounded input. `q` is now searchTextSchema (200, generous for search prose)
// and the exact-ish filters are filterTextSchema (100, matching the structured
// -token precedent). validateListQuery already reads schema.maxLength
// generically, so this is a schema-data fix; these tests are the regression.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { validateListQueryParams } from "../workers/list-query.ts";

function query(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

describe("free-text query filters enforce a maxLength (#5544)", () => {
  // `economics` is a searchable collection (search_keys > 0), so it exposes `q`.
  test("rejects a q longer than 200 chars", () => {
    const error = validateListQueryParams(
      query(`/api/v1/economics?q=${"a".repeat(201)}`),
      "economics",
    );
    assert.equal(error!.parameter, "q");
    assert.equal(error!.message, "q is too long.");
  });

  test("accepts a q of exactly 200 chars", () => {
    assert.equal(
      validateListQueryParams(
        query(`/api/v1/economics?q=${"a".repeat(200)}`),
        "economics",
      ),
      null,
    );
  });

  // `endpoints` carries the exact-ish `provider` filter (filterTextSchema, 100).
  test("rejects a provider filter longer than 100 chars", () => {
    const error = validateListQueryParams(
      query(`/api/v1/endpoints?provider=${"a".repeat(101)}`),
      "endpoints",
    );
    assert.equal(error!.parameter, "provider");
    assert.equal(error!.message, "provider is too long.");
  });

  test("accepts a provider filter of exactly 100 chars", () => {
    assert.equal(
      validateListQueryParams(
        query(`/api/v1/endpoints?provider=${"a".repeat(100)}`),
        "endpoints",
      ),
      null,
    );
  });

  // A searchable collection with no q param at all is still valid — the bound
  // only applies when q is present.
  test("accepts a searchable route with no q param", () => {
    assert.equal(
      validateListQueryParams(query("/api/v1/economics"), "economics"),
      null,
    );
  });

  // `providers` carries the exact-ish `id` filter — same filterTextSchema bound.
  test("rejects an id filter longer than 100 chars", () => {
    const error = validateListQueryParams(
      query(`/api/v1/providers?id=${"a".repeat(101)}`),
      "providers",
    );
    assert.equal(error!.parameter, "id");
    assert.equal(error!.message, "id is too long.");
  });
});
