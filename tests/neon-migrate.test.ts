// The Neon migration runner (scripts/neon-migrate.ts, #9814).
//
// The ordering and the already-applied filter are the whole contract: a
// migration applied twice, skipped, or run out of order is a schema that no
// longer matches the repo -- which is the state this script exists to end.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "vitest";
import { pendingMigrations } from "../scripts/neon-migrate.ts";

describe("pendingMigrations", () => {
  test("returns unapplied files in lexical order", () => {
    // Lexical order is why the files are numbered: `0002` may depend on
    // `0001`, and readdir order is not defined.
    assert.deepEqual(
      pendingMigrations(
        ["0003_c.sql", "0001_a.sql", "0002_b.sql"],
        new Set<string>(),
      ),
      ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
    );
  });

  test("skips what is already applied", () => {
    assert.deepEqual(
      pendingMigrations(
        ["0001_a.sql", "0002_b.sql"],
        new Set(["0001_a.sql"]),
      ),
      ["0002_b.sql"],
    );
  });

  test("ignores anything that is not .sql", () => {
    // A README or an editor swapfile in the directory must not be handed to
    // the database.
    assert.deepEqual(
      pendingMigrations(
        ["README.md", "0001_a.sql", ".0001_a.sql.swp"],
        new Set<string>(),
      ),
      ["0001_a.sql"],
    );
  });

  test("a fully applied directory yields nothing", () => {
    assert.deepEqual(
      pendingMigrations(["0001_a.sql"], new Set(["0001_a.sql"])),
      [],
    );
  });
});

describe("the migrations on disk", () => {
  const files = readdirSync("migrations/neon").filter((f) =>
    f.endsWith(".sql"),
  );

  test("are numbered uniquely, so the order is total", () => {
    const prefixes = files.map((f) => f.slice(0, 4));
    assert.deepEqual(
      [...new Set(prefixes)].sort(),
      prefixes.sort(),
      "two migrations share a number; their relative order is undefined",
    );
    for (const f of files) {
      assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, `${f} is not NNNN_name.sql`);
    }
  });

  test("are idempotent, because the runner may re-run one after a failure", () => {
    // A migration whose file is recorded only on COMMIT can be retried, and a
    // bare CREATE TABLE would fail the retry on the objects that did land.
    for (const f of files) {
      const sql = readFileSync(`migrations/neon/${f}`, "utf8");
      for (const [, stmt] of sql.matchAll(
        /^\s*(CREATE (?:TABLE|INDEX|UNIQUE INDEX)[^\n;]*)/gim,
      )) {
        assert.match(
          stmt,
          /IF NOT EXISTS/i,
          `${f}: "${stmt.slice(0, 60)}…" is not idempotent`,
        );
      }
    }
  });

  test("declare the 0/1 columns as BOOLEAN, never SMALLINT", () => {
    // The mirror writes real JS booleans and Postgres rejects
    // `boolean = integer` -- that mismatch emptied /validators (#9802).
    // Verified against information_schema for the existing tables on
    // 2026-08-07; asserted here so a new migration cannot reintroduce it.
    for (const f of files) {
      const sql = readFileSync(`migrations/neon/${f}`, "utf8");
      for (const [, col, type] of sql.matchAll(
        /^\s+(\w*(?:_enabled|_permit|_active|active|is_immunity_period))\s+(\w+)/gim,
      )) {
        assert.match(
          type,
          /BOOLEAN/i,
          `${f}: ${col} is ${type}; the mirror writes a JS boolean`,
        );
      }
    }
  });
});
