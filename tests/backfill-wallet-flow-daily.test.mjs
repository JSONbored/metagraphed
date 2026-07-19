// Unit tests for scripts/backfill-wallet-flow-daily.mjs's pure helpers
// (arg parsing, option validation). Not part of the codecov coverage.include
// scope (see vitest.config.mjs's own comment on why only a named subset of
// scripts/ is instrumented) -- these tests exist for correctness confidence
// before running the script against production, the same convention
// tests/backfill-subnet-snapshots-postgres.test.mjs already follows for its
// sibling script.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertValidOptions,
  parseArgs,
} from "../scripts/backfill-wallet-flow-daily.mjs";

test("parseArgs returns defaults with no arguments", () => {
  const opts = parseArgs([]);
  assert.equal(opts.from, null);
  assert.equal(opts.to, null);
  assert.equal(opts.dryRun, false);
});

test("parseArgs honors overrides", () => {
  const opts = parseArgs([
    "--from",
    "2026-01-01",
    "--to",
    "2026-01-31",
    "--database-url",
    "postgres://example",
    "--dry-run",
  ]);
  assert.equal(opts.from, "2026-01-01");
  assert.equal(opts.to, "2026-01-31");
  assert.equal(opts.databaseUrl, "postgres://example");
  assert.equal(opts.dryRun, true);
});

test("parseArgs throws on an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
});

test("assertValidOptions requires --from and --to", () => {
  assert.throws(
    () => assertValidOptions({ from: null, to: null, databaseUrl: "x" }),
    /--from and --to are required/,
  );
});

test("assertValidOptions rejects a malformed date", () => {
  assert.throws(
    () =>
      assertValidOptions({
        from: "not-a-date",
        to: "2026-01-31",
        databaseUrl: "x",
      }),
    /must be YYYY-MM-DD/,
  );
});

test("assertValidOptions rejects --from after --to", () => {
  assert.throws(
    () =>
      assertValidOptions({
        from: "2026-02-01",
        to: "2026-01-01",
        databaseUrl: "x",
      }),
    /must not be after/,
  );
});

test("assertValidOptions requires a database URL", () => {
  assert.throws(
    () =>
      assertValidOptions({
        from: "2026-01-01",
        to: "2026-01-31",
        databaseUrl: "",
      }),
    /DATABASE_URL required/,
  );
});

test("assertValidOptions accepts a valid, complete option set", () => {
  assert.doesNotThrow(() =>
    assertValidOptions({
      from: "2026-01-01",
      to: "2026-01-31",
      databaseUrl: "postgres://example",
    }),
  );
});
