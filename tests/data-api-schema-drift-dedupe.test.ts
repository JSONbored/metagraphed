// #8985: schema drift is ONE bit of information that recurs on every request,
// and capturing it per-request cost 868,689 $exception events for a single
// missing table (#8960) -- still arriving at ~5,100/hour when it was found.
//
// The dedupe therefore has to satisfy two opposing properties, and both are
// pinned here rather than only the cheap one:
//
//   - a REPEAT of a drift already seen must be silent, or the storm returns;
//   - a NEW drift must still capture, or the dedupe becomes the outage. A key
//     that is too coarse (say, route alone) would mean the second missing
//     relation on an already-drifted route is invisible for the isolate's whole
//     lifetime, which is a worse failure than the noise it replaces.
//
// The failure mode this file exists to catch is therefore over-suppression,
// not under-suppression.
import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import {
  captureDataApiErrorForTest,
  shouldSkipDriftCapture,
} from "../workers/data-api.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

// The dedupe set is module-level and isolate-scoped by design, so each test
// must start from the post-load baseline. resetModuleState() is the same public
// entry point tests/setup/reset-module-state.ts uses between FILES -- calling it
// per test here keeps these cases independent of their own order.
beforeEach(() => {
  resetModuleState();
});

/** A postgres.js-shaped error: a SQLSTATE in `code`, the relation in `table_name`. */
function pgError(code: string, message: string, table_name?: string) {
  return Object.assign(new Error(message), { code, table_name });
}

const MISSING_TABLE = "42P01";
const MISSING_COLUMN = "42703";

test("captures the first sighting of a missing relation, skips the second", () => {
  const err = pgError(
    MISSING_TABLE,
    'relation "api_usage_rollup" does not exist',
    "api_usage_rollup",
  );

  assert.equal(shouldSkipDriftCapture(err, "wallet-auth-keys"), false);
  assert.equal(shouldSkipDriftCapture(err, "wallet-auth-keys"), true);
  // ...and stays skipped. The real storm was ~5,100/hour, not two.
  for (let i = 0; i < 50; i += 1) {
    assert.equal(shouldSkipDriftCapture(err, "wallet-auth-keys"), true);
  }
});

// A distinct error OBJECT with identical content must still dedupe -- postgres.js
// constructs a new Error per failed query, so identity-based memoization (a
// WeakSet on the error) would suppress nothing at all in production while
// passing any test that reuses one object.
test("dedupes across distinct error objects with the same relation", () => {
  const first = pgError(MISSING_TABLE, "relation x does not exist", "x");
  const second = pgError(MISSING_TABLE, "relation x does not exist", "x");

  assert.equal(shouldSkipDriftCapture(first, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(second, "route-a"), true);
});

test("a DIFFERENT relation on the same route captures again", () => {
  const rollup = pgError(MISSING_TABLE, "missing", "api_usage_rollup");
  const taoUsd = pgError(MISSING_TABLE, "missing", "tao_usd_index");

  assert.equal(shouldSkipDriftCapture(rollup, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(taoUsd, "route-a"), false);
  // Each is now independently suppressed.
  assert.equal(shouldSkipDriftCapture(rollup, "route-a"), true);
  assert.equal(shouldSkipDriftCapture(taoUsd, "route-a"), true);
});

test("the SAME relation on a different route captures again", () => {
  const err = pgError(MISSING_TABLE, "missing", "api_usage_rollup");

  assert.equal(shouldSkipDriftCapture(err, "wallet-auth-keys"), false);
  assert.equal(shouldSkipDriftCapture(err, "api-key-usage"), false);
  assert.equal(shouldSkipDriftCapture(err, "wallet-auth-keys"), true);
});

// 42703 is the column half of the same incident: schema.sql's CREATE TABLE IF
// NOT EXISTS silently skips a column added to an existing table, so a missing
// COLUMN is exactly as likely as a missing table and must dedupe too.
test("missing-column drift (42703) dedupes on its own key", () => {
  const column = pgError(
    MISSING_COLUMN,
    'column "tao_in_emission_tao" does not exist',
  );
  const otherColumn = pgError(
    MISSING_COLUMN,
    'column "excess_tao" does not exist',
  );

  assert.equal(shouldSkipDriftCapture(column, "subnet-snapshots"), false);
  assert.equal(shouldSkipDriftCapture(column, "subnet-snapshots"), true);
  // Different column -> different message -> different key -> still captured.
  assert.equal(shouldSkipDriftCapture(otherColumn, "subnet-snapshots"), false);
});

// A missing table and a missing column never share a key even if postgres.js
// gave them the same relation, because SQLSTATE is part of it.
test("42P01 and 42703 for the same name are separate keys", () => {
  const table = pgError(MISSING_TABLE, "same", "thing");
  const column = pgError(MISSING_COLUMN, "same", "thing");

  assert.equal(shouldSkipDriftCapture(table, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(column, "route-a"), false);
});

// Everything below is the "never suppress a real fault" half. A non-drift error
// must ALWAYS capture -- these are the connection failures, constraint
// violations and timeouts that error tracking exists for, and suppressing a
// repeat of one would hide an ongoing outage.
test("a non-drift SQLSTATE always captures, however often it repeats", () => {
  const uniqueViolation = pgError(
    "23505",
    'duplicate key value violates unique constraint "pk"',
  );

  for (let i = 0; i < 5; i += 1) {
    assert.equal(shouldSkipDriftCapture(uniqueViolation, "route-a"), false);
  }
});

test("an error with no SQLSTATE always captures", () => {
  const plain = new Error("Hyperdrive connection closed");

  assert.equal(shouldSkipDriftCapture(plain, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(plain, "route-a"), false);
});

// `code` is not always a string -- a Node system error carries a numeric errno
// on some shapes, and a non-string must not be coerced into a drift SQLSTATE.
test("a non-string `code` is not treated as a SQLSTATE", () => {
  const numericCode = Object.assign(new Error("boom"), { code: 42 });

  assert.equal(shouldSkipDriftCapture(numericCode, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(numericCode, "route-a"), false);
});

test("null and undefined errors capture rather than throwing", () => {
  assert.equal(shouldSkipDriftCapture(null, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(undefined, "route-a"), false);
});

// postgres.js populates table_name for 42P01 but not for every drift shape.
// The message is the fallback, and it must still discriminate -- collapsing
// every table_name-less drift onto one key would suppress genuinely different
// relations after the first.
test("falls back to the message when table_name is absent", () => {
  const first = pgError(MISSING_TABLE, 'relation "alpha" does not exist');
  const second = pgError(MISSING_TABLE, 'relation "beta" does not exist');

  assert.equal(shouldSkipDriftCapture(first, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(second, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(first, "route-a"), true);
});

// The degenerate shape: a drift SQLSTATE with neither table_name nor a message.
// It still dedupes (on the empty relation) rather than throwing.
test("a drift error with no table_name and no message still dedupes", () => {
  const bare = { code: MISSING_TABLE };

  assert.equal(shouldSkipDriftCapture(bare, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(bare, "route-a"), true);
});

// The wiring itself: everything above tests the predicate, this tests that
// captureDataApiError actually HONOURS it. Without this the predicate could be
// perfect and never consulted -- which is the same production outcome as not
// having written it.
test("captureDataApiError captures once, then suppresses the repeat", async () => {
  // No POSTHOG_PROJECT_TOKEN: recordExceptionEvent is a safe no-op, so the
  // return value is the only signal, which is exactly why it exists.
  const env = {} as Parameters<typeof captureDataApiErrorForTest>[2];
  const err = pgError(
    MISSING_TABLE,
    'relation "api_usage_rollup" does not exist',
    "api_usage_rollup",
  );

  assert.equal(
    await captureDataApiErrorForTest(err, "wallet-auth-keys", env),
    true,
  );
  assert.equal(
    await captureDataApiErrorForTest(err, "wallet-auth-keys", env),
    false,
  );
});

test("captureDataApiError never suppresses a non-drift failure", async () => {
  const env = {} as Parameters<typeof captureDataApiErrorForTest>[2];
  const err = new Error("Hyperdrive connection closed");

  assert.equal(await captureDataApiErrorForTest(err, "route-a", env), true);
  assert.equal(await captureDataApiErrorForTest(err, "route-a", env), true);
});

// The reset is not decoration: without it the set outlives a test file under
// `isolate: false` and one file's drift suppresses another's expected capture.
test("resetModuleState clears the dedupe set", () => {
  const err = pgError(MISSING_TABLE, "missing", "api_usage_rollup");

  assert.equal(shouldSkipDriftCapture(err, "route-a"), false);
  assert.equal(shouldSkipDriftCapture(err, "route-a"), true);

  resetModuleState();

  assert.equal(shouldSkipDriftCapture(err, "route-a"), false);
});
