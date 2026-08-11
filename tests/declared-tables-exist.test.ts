// Every table the repo declares must actually exist in Neon.
//
// The check itself is four lines of set arithmetic; what needs testing is the
// PARSING, because a scanner that quietly matches nothing passes on everything.
// Both halves have that failure mode: a migration scanner fooled by prose, and
// a constant scanner that misses the array shape these sets are written in.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  findMissing,
  tablesInMigrations,
  tablesInReadStoreSets,
} from "../scripts/validate-declared-tables-exist.ts";

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("reading tables out of the migrations", () => {
  test("finds a CREATE TABLE with and without IF NOT EXISTS", () => {
    const dir = migrationsDir({
      "0001_a.sql": "CREATE TABLE IF NOT EXISTS alpha (id INT);",
      "0002_b.sql": "CREATE TABLE beta (id INT);",
    });
    assert.deepEqual([...tablesInMigrations(dir).keys()].sort(), [
      "alpha",
      "beta",
    ]);
  });

  test("IGNORES a table named only in prose", () => {
    // Several migrations discuss tables they do not create. A scanner that read
    // comments would demand tables nobody declared, and the failure would look
    // like a missing migration rather than a broken scanner.
    const dir = migrationsDir({
      "0001_a.sql": [
        "-- CREATE TABLE ghost (id INT); -- described, not created",
        "/* CREATE TABLE phantom (id INT); */",
        "CREATE TABLE real_one (id INT);",
      ].join("\n"),
    });
    assert.deepEqual([...tablesInMigrations(dir).keys()], ["real_one"]);
  });

  test("records the FIRST migration to declare a table", () => {
    // A later `CREATE TABLE IF NOT EXISTS` of the same name is a re-run guard,
    // not a second declaration, and the report should name where it came from.
    const dir = migrationsDir({
      "0001_a.sql": "CREATE TABLE alpha (id INT);",
      "0002_b.sql": "CREATE TABLE IF NOT EXISTS alpha (id INT);",
    });
    assert.equal(tablesInMigrations(dir).get("alpha"), "0001_a.sql");
  });

  test("matches case-insensitively and normalises to lower case", () => {
    const dir = migrationsDir({ "0001_a.sql": "create table Alpha (id INT);" });
    assert.deepEqual([...tablesInMigrations(dir).keys()], ["alpha"]);
  });

  test("finds nothing in a directory with no migrations", () => {
    assert.equal(tablesInMigrations(migrationsDir({})).size, 0);
  });
});

describe("reading tables out of the read-store sets", () => {
  test("finds every table in every *_TABLES constant", () => {
    const found = tablesInReadStoreSets(`
      export const ALPHA_TABLES = ["one", "two"] as const;
      const NOT_EXPORTED = ["three"];
      export const BETA_TABLES = ["four"] as const;
    `);
    assert.deepEqual([...found.keys()].sort(), ["four", "one", "two"]);
    assert.equal(found.get("one"), "ALPHA_TABLES");
  });

  test("the scanner actually MATCHES the shape this repo uses", () => {
    // The guard against a check that passes because it found nothing: this is
    // the real file, and it must yield real tables.
    const source = `/** doc */
export const REVENUE_OBSERVATION_TABLES = [
  "revenue_observations",
  "revenue_probe_failures",
] as const;`;
    assert.deepEqual([...tablesInReadStoreSets(source).keys()].sort(), [
      "revenue_observations",
      "revenue_probe_failures",
    ]);
  });
});

describe("deciding what is missing", () => {
  const live = new Set(["present"]);

  test("names a migration's table that the live schema lacks", () => {
    const out = findMissing(
      live,
      new Map([["absent", "0018_x.sql"]]),
      new Map(),
    );
    assert.deepEqual(out, [
      { table: "absent", declaredBy: "0018_x.sql", source: "migration" },
    ]);
  });

  test("names a read-store table with no migration at all", () => {
    // The other direction: a loader declaring a table nobody ever created.
    const out = findMissing(live, new Map(), new Map([["absent", "X_TABLES"]]));
    assert.deepEqual(out, [
      { table: "absent", declaredBy: "X_TABLES", source: "read-store-tables" },
    ]);
  });

  test("reports a table declared in BOTH places only once", () => {
    // One problem, not two -- listing it twice makes the report look worse
    // than it is and obscures how many tables are actually affected.
    const out = findMissing(
      live,
      new Map([["absent", "0018_x.sql"]]),
      new Map([["absent", "X_TABLES"]]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].source, "migration");
  });

  test("says nothing when everything declared exists", () => {
    assert.deepEqual(
      findMissing(
        live,
        new Map([["present", "0001_x.sql"]]),
        new Map([["present", "X_TABLES"]]),
      ),
      [],
    );
  });

  test("sorts by table, so the report is stable across runs", () => {
    const out = findMissing(
      new Set<string>(),
      new Map([
        ["zulu", "a.sql"],
        ["alpha", "b.sql"],
      ]),
      new Map(),
    );
    assert.deepEqual(
      out.map((m) => m.table),
      ["alpha", "zulu"],
    );
  });
});
