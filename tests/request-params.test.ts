// Unit tests for workers/request-params.ts — the shared query-parameter parser
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
  MAX_U16_NETUID,
  parseNetuidParam,
  FEED_PAGINATION,
  MAX_LIMIT,
  MAX_OFFSET,
  MIN_LIMIT,
  clampLimit,
  clampOffset,
  parseDateRange,
  parseLimitParam,
  parseNonNegativeIntParam,
  parsePagination,
} from "../workers/request-params.ts";
import type { Row } from "./row-type.ts";

// Build a request URL carrying only the query string under test.
function url(query: string) {
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

  test("REJECTS a limit above the profile maximum, and clamps offset", () => {
    // #9916: this used to clamp, so a route declaring `maximum: 100` answered
    // limit=9999 with 100 rows and HTTP 200. A caller asking for 9999 and
    // getting 100 reads that as "the result set is exhausted" and stops --
    // truncation presented as a complete answer. Offset still clamps: a
    // clamped offset cannot be mistaken for the end of a result set.
    for (const [profile, max] of [
      [FEED_PAGINATION, 1000],
      [BLOCK_PAGINATION, 100],
    ] as const) {
      const result = parsePagination(url("limit=9999&offset=-3"), profile);
      assert.ok("error" in result, `expected a rejection at max ${max}`);
      assert.equal(result.error.parameter, "limit");
      assert.match(result.error.message, new RegExp(`between 1 and ${max}\\.`));
    }
    const ok = parsePagination(url("offset=-3"), FEED_PAGINATION);
    assert.ok(!("error" in ok));
    assert.equal(ok.offset, 0);
  });

  test("falls back to DEFAULT_LIMIT when the profile names no default", () => {
    // The bare-profile path: every caller today passes FEED_PAGINATION or
    // BLOCK_PAGINATION, both of which set defaultLimit, so without this the
    // module-level fallback is never exercised.
    const result = parsePagination(url(""), {});
    assert.ok(!("error" in result));
    assert.equal(result.limit, DEFAULT_LIMIT);
  });

  test("REJECTS limit=0 rather than guessing what it meant", () => {
    // Three routes used to answer it three ways -- 1 row, the route default,
    // or a 400. None of them is "zero rows", the only reading a caller could
    // have intended (#9916).
    const result = parsePagination(url("limit=0"), FEED_PAGINATION);
    assert.ok("error" in result);
    assert.equal(result.error.parameter, "limit");
  });

  test("passes the raw cursor token through opaque (never decoded)", () => {
    const result = parsePagination(url("cursor=150.2"), FEED_PAGINATION);
    assert.ok(!("error" in result));
    assert.equal(result.cursor, "150.2");
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
    const result = parseDateRange(url("from=June")) as Row;
    assert.deepEqual(result.error, {
      parameter: "from",
      message: "from must be a YYYY-MM-DD date.",
    });
    assert.equal(result.from, undefined);
  });

  test("errors on a malformed to bound even when from is valid", () => {
    const result = parseDateRange(url("from=2026-06-01&to=nope")) as Row;
    assert.deepEqual(result.error, {
      parameter: "to",
      message: "to must be a YYYY-MM-DD date.",
    });
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
    const result = parseLimitParam(url("limit=abc1"), opts) as Row;
    assert.deepEqual(result.error, {
      parameter: "limit",
      message: "limit must be an integer between 1 and 100.",
    });
  });

  test("rejects a leading-zero limit (not a canonical integer)", () => {
    assert.equal(
      (parseLimitParam(url("limit=001"), opts) as Row).error?.parameter,
      "limit",
    );
  });

  test("rejects a negative limit", () => {
    assert.equal(
      (parseLimitParam(url("limit=-1"), opts) as Row).error?.parameter,
      "limit",
    );
  });

  test("rejects a blank limit", () => {
    assert.equal(
      (parseLimitParam(url("limit="), opts) as Row).error?.parameter,
      "limit",
    );
  });

  test("rejects an over-cap limit rather than clamping it", () => {
    assert.equal(
      (parseLimitParam(url("limit=999999"), opts) as Row).error?.parameter,
      "limit",
    );
  });

  test("error message reflects the profile's maximum", () => {
    assert.equal(
      (
        parseLimitParam(url("limit=999999"), {
          defaultLimit: 25,
          maxLimit: 100,
        }) as Row
      ).error.message,
      "limit must be an integer between 1 and 100.",
    );
  });
});

describe("parseNonNegativeIntParam", () => {
  test("returns null when the raw value is absent or blank", () => {
    assert.deepEqual(parseNonNegativeIntParam(null, "offset"), { value: null });
    assert.deepEqual(parseNonNegativeIntParam("", "offset"), { value: null });
  });

  test("rejects a non-digit value", () => {
    assert.deepEqual((parseNonNegativeIntParam("-1", "offset") as Row).error, {
      parameter: "offset",
      message: "offset must be a non-negative integer.",
    });
    assert.deepEqual((parseNonNegativeIntParam("abc", "offset") as Row).error, {
      parameter: "offset",
      message: "offset must be a non-negative integer.",
    });
  });

  test("rejects an unsafe integer beyond MAX_SAFE_INTEGER", () => {
    const raw = String(Number.MAX_SAFE_INTEGER + 1);
    assert.deepEqual((parseNonNegativeIntParam(raw, "offset") as Row).error, {
      parameter: "offset",
      message: "offset must be a non-negative integer.",
    });
  });

  test("returns a parsed value for a valid non-negative integer", () => {
    assert.deepEqual(parseNonNegativeIntParam("0", "offset"), { value: 0 });
    assert.deepEqual(parseNonNegativeIntParam("42", "offset"), { value: 42 });
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
describe("parseNetuidParam enforces the u16 bound the contract publishes", () => {
  test("absent or blank is unscoped, not an error", () => {
    assert.deepEqual(parseNetuidParam(null), { value: null });
    assert.deepEqual(parseNetuidParam(""), { value: null });
  });

  test("a netuid inside the range parses", () => {
    assert.deepEqual(parseNetuidParam("0"), { value: 0 });
    assert.deepEqual(parseNetuidParam("64"), { value: 64 });
  });

  test("the ceiling is inclusive", () => {
    assert.deepEqual(parseNetuidParam(String(MAX_U16_NETUID)), {
      value: MAX_U16_NETUID,
    });
  });

  test("one past the ceiling is rejected, and says the range", () => {
    assert.deepEqual(parseNetuidParam(String(MAX_U16_NETUID + 1)), {
      error: {
        parameter: "netuid",
        message: "netuid must be an integer between 0 and 65535.",
      },
    });
    assert.deepEqual(parseNetuidParam("70000"), {
      error: {
        parameter: "netuid",
        message: "netuid must be an integer between 0 and 65535.",
      },
    });
  });

  test("a negative or non-numeric value keeps the shared message", () => {
    // parseNonNegativeIntParam rejects these first, so the ceiling check never
    // sees them and the caller gets the message it always got.
    for (const raw of ["-1", "abc", "1.5", "99999999999999999999"]) {
      assert.deepEqual(parseNetuidParam(raw), {
        error: {
          parameter: "netuid",
          message: "netuid must be a non-negative integer.",
        },
      });
    }
  });
});
