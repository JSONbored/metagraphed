// Unit tests for workers/request-params.mjs — the shared query-parameter parser
// the entity/feed handlers and their D1 loaders now route every `limit`/`offset`/
// `cursor` read through. Covers the page-size bounds + profiles, the clamp
// primitives (missing / non-numeric / negative / over-cap / fractional inputs),
// the URL pagination triplet, and the YYYY-MM-DD date-range validator. These lock
// the clamping contract directly: the routes used to inline it per handler, so a
// single shared parser keeps every paginated route bounding page size identically.

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
  parseDateRange,
  parseLimitParam,
  parsePagination,
} from "../workers/request-params.mjs";

// Build a request URL carrying only the query string under test.
function url(query) {
  return new URL(`https://api.metagraph.sh/x${query ? `?${query}` : ""}`);
}

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

describe("parsePagination", () => {
  test("returns the feed-profile defaults when no params are present", () => {
    assert.deepEqual(parsePagination(url(""), FEED_PAGINATION), {
      limit: 100,
      offset: 0,
      cursor: null,
    });
  });

  test("returns the block-profile defaults when no params are present", () => {
    assert.deepEqual(parsePagination(url(""), BLOCK_PAGINATION), {
      limit: 50,
      offset: 0,
      cursor: null,
    });
  });

  test("clamps limit and offset per the active profile", () => {
    assert.deepEqual(
      parsePagination(url("limit=9999&offset=-3"), FEED_PAGINATION),
      { limit: 1000, offset: 0, cursor: null },
    );
    assert.equal(
      parsePagination(url("limit=9999"), BLOCK_PAGINATION).limit,
      100,
    );
  });

  test("passes the raw cursor token through opaque (never decoded)", () => {
    assert.equal(
      parsePagination(url("cursor=150.2"), FEED_PAGINATION).cursor,
      "150.2",
    );
  });

  test("parses limit, offset, and cursor together", () => {
    assert.deepEqual(
      parsePagination(url("limit=20&offset=40&cursor=9.9"), FEED_PAGINATION),
      { limit: 20, offset: 40, cursor: "9.9" },
    );
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

describe("parseDateRange", () => {
  test("returns nulls when from/to are absent", () => {
    assert.deepEqual(parseDateRange(url("")), { from: null, to: null });
  });

  test("treats a blank from/to as no bound, not an error", () => {
    assert.deepEqual(parseDateRange(url("from=&to=")), {
      from: null,
      to: null,
    });
  });

  test("returns valid from/to bounds verbatim", () => {
    assert.deepEqual(parseDateRange(url("from=2026-06-01&to=2026-06-30")), {
      from: "2026-06-01",
      to: "2026-06-30",
    });
  });

  test("normalizes a present lower bound with an absent upper bound", () => {
    assert.deepEqual(parseDateRange(url("from=2026-06-01")), {
      from: "2026-06-01",
      to: null,
    });
  });

  test("errors on a malformed from bound", () => {
    const result = parseDateRange(url("from=June"));
    assert.equal(result.error, "from/to must be YYYY-MM-DD dates.");
    assert.equal(result.from, undefined);
  });

  test("errors on a malformed to bound even when from is valid", () => {
    const result = parseDateRange(url("from=2026-06-01&to=nope"));
    assert.equal(result.error, "from/to must be YYYY-MM-DD dates.");
  });

  test("is format-only — accepts a present but out-of-range date", () => {
    assert.deepEqual(parseDateRange(url("from=2026-13-40")), {
      from: "2026-13-40",
      to: null,
    });
  });
});

describe("parseLimitParam", () => {
  const opts = { defaultLimit: 50, maxLimit: 100 };

  test("falls back to the default when limit is absent", () => {
    assert.deepEqual(parseLimitParam(url(""), opts), { limit: 50 });
  });

  test("returns a valid in-range limit", () => {
    assert.deepEqual(parseLimitParam(url("limit=20"), opts), { limit: 20 });
  });

  test("rejects a non-numeric limit", () => {
    const result = parseLimitParam(url("limit=abc1"), opts);
    assert.deepEqual(result.error, {
      parameter: "limit",
      message: "limit must be an integer between 1 and 100.",
    });
  });

  test("rejects a leading-zero limit (not a canonical integer)", () => {
    assert.equal(
      parseLimitParam(url("limit=001"), opts).error?.parameter,
      "limit",
    );
  });

  test("rejects a blank limit", () => {
    assert.equal(
      parseLimitParam(url("limit="), opts).error?.parameter,
      "limit",
    );
  });

  test("rejects an over-cap limit rather than clamping it", () => {
    assert.equal(
      parseLimitParam(url("limit=999999"), opts).error?.parameter,
      "limit",
    );
  });

  test("error message reflects the profile's maximum", () => {
    assert.equal(
      parseLimitParam(url("limit=999999"), { defaultLimit: 25, maxLimit: 100 })
        .error.message,
      "limit must be an integer between 1 and 100.",
    );
  });
});
