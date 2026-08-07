// BIGINT must come out of Neon the same shape it comes out of D1.
//
// node-postgres returns `int8` as a STRING by default, because int8 spans a
// wider range than a JS number holds exactly. D1 returns the same columns as
// numbers. So without a parser, moving a route between the two stores changes
// the TYPE of every epoch-ms and counter field in its response -- with no
// error anywhere, and a consumer doing arithmetic or a `>` comparison silently
// getting a different answer.
//
// Measured against production 2026-08-07, which is what makes this a fix
// rather than a precaution: `SELECT registered_at_block FROM neurons` over
// this driver returned "1404439", while the live /subnets/1/metagraph -- a
// route ALREADY served from Neon -- returned 8692121. They agree only because
// that one handler happens to coerce.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { types } from "pg";

// Importing for the side effect: the parser is registered at module load, so
// every Client this codebase builds inherits it. Asserting through
// `types.getTypeParser` rather than through a live query is what lets this run
// in CI with no database.
import "../src/pg-sql.ts";

const INT8_OID = 20;
const parse = types.getTypeParser(INT8_OID) as (v: string) => unknown;

describe("int8 arrives as the shape D1 would have produced", () => {
  test("an epoch-ms timestamp is a number", () => {
    // The actual value of github_accounts.created_at in production.
    assert.equal(parse("1785176950652"), 1785176950652);
    assert.equal(typeof parse("1785176950652"), "number");
  });

  test("a block number is a number", () => {
    assert.equal(parse("8795218"), 8795218);
  });

  test("zero and negatives survive", () => {
    assert.equal(parse("0"), 0);
    assert.equal(parse("-1"), -1);
  });

  test("the largest exactly-representable integer still converts", () => {
    assert.equal(parse("9007199254740991"), Number.MAX_SAFE_INTEGER);
    assert.equal(typeof parse("9007199254740991"), "number");
  });

  test("ONE PAST that stays a string rather than rounding", () => {
    // The guard is the point. Silently rounding a value past 2^53 would be a
    // worse bug than the one this parser fixes: 9007199254740993 rounds to
    // ...992, and nothing anywhere would say so. A caller that receives a
    // string knows it got a value a number could not hold.
    assert.equal(parse("9007199254740993"), "9007199254740993");
    assert.equal(typeof parse("9007199254740993"), "string");
  });

  test("int8's full range stays a string at both ends", () => {
    assert.equal(typeof parse("9223372036854775807"), "string");
    assert.equal(typeof parse("-9223372036854775808"), "string");
  });

  test("every int8 column in this schema is far inside the safe range", () => {
    // Not a hypothetical bound. Epoch-milliseconds is ~1.79e12 against a
    // ceiling of ~9.01e15, so the guard above is a backstop rather than a live
    // path -- which is why converting is safe rather than merely convenient.
    const nowMs = Date.now();
    assert.ok(nowMs < Number.MAX_SAFE_INTEGER / 1000);
  });
});
