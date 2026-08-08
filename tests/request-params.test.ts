// Unit tests for what remains of workers/request-params.ts after #10218: the
// page-size bounds + profiles, and the clamp primitives the D1/artifact loaders
// apply BEHIND an already-validated boundary (missing / non-numeric / negative
// / over-cap / fractional inputs).
//
// The URL parsers this file used to cover -- parsePagination, parseLimitParam,
// parseNonNegativeIntParam, parseNetuidParam, parseDateRange -- are gone. Every
// behaviour they pinned is now the router's single parse against the route's
// own Zod schema, and is covered against that boundary in
// tests/route-query.test.ts, where the assertions are about what a REQUEST does
// rather than about what one helper of five did.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BLOCK_PAGINATION,
  DAY_PATTERN,
  DEFAULT_LIMIT,
  FEED_PAGINATION,
  MAX_LIMIT,
  MAX_OFFSET,
  MIN_LIMIT,
  clampLimit,
  clampOffset,
} from "../workers/request-params.ts";

describe("pagination bounds + profiles", () => {
  test("exposes the absolute page-size + offset ceilings", () => {
    assert.equal(MIN_LIMIT, 1);
    assert.equal(MAX_LIMIT, 1000);
    assert.equal(MAX_OFFSET, 1_000_000);
    assert.equal(DEFAULT_LIMIT, 100);
  });

  test("the feed profile defaults to DEFAULT_LIMIT and caps at MAX_LIMIT", () => {
    assert.deepEqual(FEED_PAGINATION, { defaultLimit: 100, maxLimit: 1000 });
    assert.equal(FEED_PAGINATION.defaultLimit, DEFAULT_LIMIT);
    assert.equal(FEED_PAGINATION.maxLimit, MAX_LIMIT);
  });

  test("the block profile defaults to 50 and caps tighter than the feed", () => {
    assert.deepEqual(BLOCK_PAGINATION, { defaultLimit: 50, maxLimit: 100 });
    assert.ok(BLOCK_PAGINATION.maxLimit < FEED_PAGINATION.maxLimit);
    assert.ok(BLOCK_PAGINATION.defaultLimit < FEED_PAGINATION.defaultLimit);
  });
});

describe("clampLimit", () => {
  test("falls back to the profile default when missing/blank/non-numeric", () => {
    assert.equal(clampLimit(null, FEED_PAGINATION), 100);
    assert.equal(clampLimit("", FEED_PAGINATION), 100);
    assert.equal(clampLimit("abc", FEED_PAGINATION), 100);
  });

  test("returns an in-range value unchanged", () => {
    assert.equal(clampLimit("42", FEED_PAGINATION), 42);
  });

  test("truncates a fractional value toward zero", () => {
    assert.equal(clampLimit("99.9", FEED_PAGINATION), 99);
  });

  test("clamps a zero/negative value up to MIN_LIMIT", () => {
    assert.equal(clampLimit("0", FEED_PAGINATION), MIN_LIMIT);
    assert.equal(clampLimit("-5", FEED_PAGINATION), MIN_LIMIT);
  });

  test("clamps an over-cap value down to the profile maximum", () => {
    assert.equal(clampLimit("9999", FEED_PAGINATION), MAX_LIMIT);
    assert.equal(clampLimit("9999", BLOCK_PAGINATION), 100);
  });

  test("honors a profile's tighter default and in-range value", () => {
    assert.equal(clampLimit(null, BLOCK_PAGINATION), 50);
    assert.equal(clampLimit("75", BLOCK_PAGINATION), 75);
  });

  test("defaults maxLimit to MAX_LIMIT when the profile omits it", () => {
    assert.equal(clampLimit("9999", { defaultLimit: 100 }), MAX_LIMIT);
  });

  test("accepts a numeric value (the MCP/loader tool-arg path)", () => {
    assert.equal(clampLimit(500, FEED_PAGINATION), 500);
    assert.equal(clampLimit(0, FEED_PAGINATION), MIN_LIMIT);
  });
});

describe("clampOffset", () => {
  test("falls back to 0 when missing/blank/non-numeric", () => {
    assert.equal(clampOffset(null), 0);
    assert.equal(clampOffset(""), 0);
    assert.equal(clampOffset("nope"), 0);
  });

  test("returns an in-range value unchanged", () => {
    assert.equal(clampOffset("250"), 250);
  });

  test("truncates a fractional value toward zero", () => {
    assert.equal(clampOffset("12.7"), 12);
  });

  test("clamps a negative value up to 0", () => {
    assert.equal(clampOffset("-1"), 0);
  });

  test("clamps an over-cap value down to MAX_OFFSET", () => {
    assert.equal(clampOffset("99999999"), MAX_OFFSET);
  });

  test("accepts a numeric value (the MCP/loader tool-arg path)", () => {
    assert.equal(clampOffset(99), 99);
  });
});

describe("DAY_PATTERN", () => {
  test("matches a canonical YYYY-MM-DD date", () => {
    assert.ok(DAY_PATTERN.test("2026-06-28"));
  });

  test("rejects non-canonical date strings", () => {
    for (const bad of [
      "2026-6-1",
      "26-06-28",
      "2026/06/28",
      "June",
      "2026-06-28T00:00:00",
      "",
    ]) {
      assert.ok(!DAY_PATTERN.test(bad), `expected ${bad} to be rejected`);
    }
  });

  test("is format-only — does not range-check the fields", () => {
    assert.ok(DAY_PATTERN.test("2026-13-40"));
  });
});

// A published bound the handler does not enforce is a contract lie (#10075).
//
// `netuid` is a u16, and openapi.json says `maximum: 65535` on every route that
// takes one. Four routes -- the two account feeds, chain/emission-pipeline and
// compare/validators -- answered `?netuid=70000` with 200 and an empty result,
// which is indistinguishable from "that subnet exists and matches nothing" for
// a value no subnet could ever carry. Same rule as #9916 for page sizes: an
// out-of-range value is rejected, never answered.
