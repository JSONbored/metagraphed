// The no-transaction path in scripts/neon-migrate.ts (#10365).
//
// WHAT THIS EXISTS TO HAVE CAUGHT. `CREATE INDEX CONCURRENTLY` cannot run
// inside a transaction and the runner wrapped every file in one, so
// 0011_index_hygiene.sql failed on every push for two days and blocked
// 0012-0015 behind it. The schema moved by hand in the meantime and
// `schema_migrations` stayed at 0010 -- a ledger that no longer described the
// database.
//
// 0011 SAID SO IN ITS OWN HEADER: "apply this file statement by statement
// (psql does this by default), NOT wrapped in BEGIN/COMMIT". That instruction
// was prose, addressed to a human who was not in the loop. These tests are the
// same instruction in a form that fails a build.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  NO_TRANSACTION_MARKER,
  migrationRefusal,
  runsOutsideTransaction,
  splitStatements,
} from "../scripts/neon-migrate.ts";

describe("refusing the contradiction rather than hitting it", () => {
  test("a CONCURRENTLY statement without the marker is refused, by name", () => {
    const refusal = migrationRefusal(
      "0099_x.sql",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);",
    );
    assert.ok(refusal, "a bare CONCURRENTLY file must be refused");
    assert.match(refusal, /0099_x\.sql/);
    assert.match(refusal, /neon:no-transaction/);
  });

  test("the same file WITH the marker is accepted", () => {
    assert.equal(
      migrationRefusal(
        "0099_x.sql",
        `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);`,
      ),
      null,
    );
  });

  test("prose mentioning CONCURRENTLY is NOT refused", () => {
    // The reason detection is a marker and not a text scan. 0011's own header
    // discusses CONCURRENTLY at length; a file that only TALKS about it still
    // wants the atomicity a transaction gives.
    const sql =
      "-- ## CONCURRENTLY, and why this file is not idempotent-by-transaction\n" +
      "-- Every statement is CONCURRENTLY so a live table is never locked.\n" +
      "CREATE TABLE IF NOT EXISTS t (a INT);";
    assert.equal(migrationRefusal("0099_x.sql", sql), null);
    assert.equal(runsOutsideTransaction(sql), false);
  });

  test("an ordinary migration does not opt out", () => {
    assert.equal(
      runsOutsideTransaction("CREATE TABLE IF NOT EXISTS t (a INT);"),
      false,
    );
  });
});

describe("splitting statements", () => {
  // THE SPLIT IS NOT COSMETIC. node-postgres sends a multi-statement string
  // over the simple query protocol, which Postgres runs as ONE IMPLICIT
  // TRANSACTION -- so dropping the explicit BEGIN/COMMIT is not enough on its
  // own and CONCURRENTLY would fail exactly as before.
  test("splits on top-level semicolons and drops comment-only trailers", () => {
    assert.deepEqual(
      splitStatements("SELECT 1; SELECT 2;\n-- trailing comment\n").map((s) =>
        s.trim(),
      ),
      ["SELECT 1", "SELECT 2"],
    );
  });

  test("a semicolon inside a string is not a separator", () => {
    const parts = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    assert.equal(parts.length, 2);
    assert.match(parts[0]!, /'a;b'/);
  });

  test("a semicolon inside a dollar-quoted block is not a separator", () => {
    // The DO/EXCEPTION guard these migrations use for ADD CONSTRAINT, which
    // Postgres has no IF NOT EXISTS for. A naive split on ";" tears it into
    // four fragments, none of which parse.
    const sql =
      "DO $$ BEGIN ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0); " +
      "EXCEPTION WHEN duplicate_object THEN NULL; END $$;\nSELECT 1;";
    const parts = splitStatements(sql);
    assert.equal(parts.length, 2, parts.join(" || "));
    assert.match(parts[0]!, /EXCEPTION WHEN duplicate_object/);
  });

  test("a semicolon inside a line comment is not a separator", () => {
    const parts = splitStatements("-- a; b\nSELECT 1;");
    assert.equal(parts.length, 1);
  });

  test("a semicolon inside a block comment is not a separator", () => {
    const parts = splitStatements("/* a; b */ SELECT 1;");
    assert.equal(parts.length, 1);
  });

  test("never yields an empty statement, which Postgres rejects", () => {
    for (const sql of [";;", "\n\n", "-- only a comment\n", ""]) {
      assert.deepEqual(splitStatements(sql), [], JSON.stringify(sql));
    }
  });
});

describe("0011 itself, which is the file that broke", () => {
  const sql = readFileSync("migrations/neon/0011_index_hygiene.sql", "utf8");

  test("carries the marker", () => {
    assert.ok(
      runsOutsideTransaction(sql),
      "0011 uses CONCURRENTLY and must declare it",
    );
  });

  test("is accepted by the gate", () => {
    assert.equal(migrationRefusal("0011_index_hygiene.sql", sql), null);
  });

  test("splits into its four real statements, not its seven mentions", () => {
    // `grep -c CONCURRENTLY` says 7; three of those are prose. Asserting the
    // count keeps the splitter honest about comments in both directions.
    const parts = splitStatements(sql);
    assert.equal(parts.length, 4, parts.join("\n---\n"));
    for (const part of parts) {
      assert.match(part, /CONCURRENTLY/);
    }
  });

  test("every statement is idempotent, which is what pays for no rollback", () => {
    // A file applied outside a transaction can fail half-done and WILL be
    // retried, because the bookkeeping row is only written after the last
    // statement. That is only safe while re-running is a no-op.
    for (const part of splitStatements(sql)) {
      assert.match(
        part,
        /IF NOT EXISTS|IF EXISTS/,
        `not re-runnable: ${part.trim().slice(0, 80)}`,
      );
    }
  });
});

describe("every migration on disk", () => {
  test("is accepted by the gate", () => {
    // The check the runner does before applying anything, run at build time so
    // a bad file fails a PR rather than a deploy.
    const files = readdirSync("migrations/neon")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    assert.ok(files.length >= 15, `only ${files.length} migrations found`);
    const refusals: (string | null)[] = files
      .map((f) =>
        migrationRefusal(f, readFileSync(`migrations/neon/${f}`, "utf8")),
      )
      .filter(Boolean);
    assert.deepEqual(refusals, []);
  });
});
