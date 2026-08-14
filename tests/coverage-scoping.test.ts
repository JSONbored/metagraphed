// The gate that would have caught #11170 and #11195 (#11199).
//
// Both were a coverage rule measuring one pass against a whole table. The
// committed queries are asserted clean below, but a gate is only worth its line
// count if it FAILS on the thing it exists for -- so the two historical
// queries are pinned verbatim here, exactly as they read before each fix.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  COVERAGE_QUERIES,
  problemsIn,
  topLevelParts,
} from "../scripts/validate-coverage-scoping.ts";

/** hotkey-alpha, as it read before #11170. `referenced` spanned all history. */
const HOTKEY_ALPHA_BEFORE_11170 =
  "SELECT (SELECT COUNT(*) FROM hotkey_alpha) AS total," +
  " (SELECT MAX(captured_at) FROM hotkey_alpha) AS latest," +
  " (SELECT SUM(CASE WHEN captured_at >=" +
  " (SELECT MAX(captured_at) FROM hotkey_alpha) - ? THEN 1 ELSE 0 END)" +
  " FROM hotkey_alpha) AS covered," +
  " (SELECT COUNT(*) FROM (SELECT DISTINCT hotkey, netuid" +
  " FROM nominator_positions)) AS referenced";

/** subnet-burn, as it read before #11195. `expected` spanned all history. */
const SUBNET_BURN_BEFORE_11195 =
  "SELECT (SELECT MAX(observed_at) FROM subnet_burn_history) AS latest," +
  " (SELECT COUNT(DISTINCT netuid) FROM subnet_burn_history" +
  " WHERE observed_at = (SELECT MAX(observed_at) FROM subnet_burn_history))" +
  " AS covered," +
  " (SELECT COUNT(DISTINCT netuid) FROM subnet_hyperparams) AS expected";

describe("the committed coverage reads", () => {
  test("every rule-feeding aggregate is bounded to a pass", () => {
    const problems = Object.entries(COVERAGE_QUERIES).flatMap(([lane, sql]) =>
      problemsIn(lane, sql),
    );
    assert.deepEqual(problems, []);
  });

  test("all six lanes are actually covered, not silently skipped", () => {
    // A sweep that reads zero queries reports zero problems, which is the
    // failure mode this class of gate has.
    assert.deepEqual(Object.keys(COVERAGE_QUERIES).sort(), [
      "account-balances",
      "hotkey-alpha",
      "neurons",
      "nominator-positions",
      "subnet-burn-coverage",
      "validator-nominator-counts",
    ]);
  });
});

describe("it fails on the two queries it exists for", () => {
  test("hotkey-alpha's pre-#11170 read is flagged on `referenced`", () => {
    const problems = problemsIn("hotkey-alpha", HOTKEY_ALPHA_BEFORE_11170);
    assert.deepEqual(
      problems.map((p) => p.alias),
      ["referenced"],
      "the unwindowed denominator must be the one flagged",
    );
  });

  test("subnet-burn's pre-#11195 read is flagged on `expected`", () => {
    const problems = problemsIn("subnet-burn", SUBNET_BURN_BEFORE_11195);
    assert.deepEqual(
      problems.map((p) => p.alias),
      ["expected"],
    );
  });

  test("and the SAME queries pass once the denominator is bounded", () => {
    // Non-vacuity in the other direction: the gate must not simply flag
    // everything with a subselect. These are the fixes as they actually landed.
    const fixedAlpha = HOTKEY_ALPHA_BEFORE_11170.replace(
      "FROM nominator_positions)) AS referenced",
      "FROM nominator_positions WHERE captured_at >=" +
        " (SELECT MAX(captured_at) FROM nominator_positions) - ?)) AS referenced",
    );
    const fixedBurn = SUBNET_BURN_BEFORE_11195.replace(
      "FROM subnet_hyperparams) AS expected",
      "FROM subnet_hyperparams WHERE captured_at =" +
        " (SELECT MAX(captured_at) FROM subnet_hyperparams)) AS expected",
    );
    assert.deepEqual(problemsIn("a", fixedAlpha), []);
    assert.deepEqual(problemsIn("b", fixedBurn), []);
  });
});

describe("what the rule deliberately allows", () => {
  test("`total` may be whole-table, because no rule compares against it", () => {
    const sql =
      "SELECT COUNT(*) AS total, MAX(captured_at) AS latest," +
      " SUM(CASE WHEN captured_at >= (SELECT MAX(captured_at) FROM t) - ?" +
      " THEN 1 ELSE 0 END) AS covered FROM t";
    assert.deepEqual(problemsIn("t", sql), []);
  });

  test("but the same expression under any other alias is flagged", () => {
    // The exemption is the NAME, so it cannot be borrowed by a denominator.
    const sql =
      "SELECT COUNT(*) AS expected, MAX(captured_at) AS latest FROM t";
    assert.deepEqual(
      problemsIn("t", sql).map((p) => p.alias),
      ["expected"],
    );
  });

  test("a non-aggregate alias is not a population and is left alone", () => {
    assert.deepEqual(problemsIn("t", "SELECT netuid AS subnet FROM t"), []);
  });
});

describe("topLevelParts", () => {
  test("splits on commas outside parens only", () => {
    assert.deepEqual(topLevelParts("a, f(b, c), d"), ["a", " f(b, c)", " d"]);
  });
});
