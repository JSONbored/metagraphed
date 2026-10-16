// Every table the repo declares must actually exist in D1.
//
// The check itself is four lines of set arithmetic; what needs testing is the
// PARSING, because a scanner that quietly matches nothing passes on everything.
// Both halves have that failure mode: a migration scanner fooled by prose, and
// a constant scanner that misses the array shape these sets are written in.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare } from "miniflare";
import { describe, test } from "vitest";
import {
  applyTrackedD1Migrations,
  assertDeclaredNativeTables,
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

test("D1 view declarations are required alongside native tables", () => {
  const dir = migrationsDir({
    "0001_documents.sql":
      "CREATE TABLE documents (id INT); CREATE VIEW readings AS SELECT id FROM documents;",
  });
  const declared = tablesInMigrations(dir);
  assert.deepEqual([...declared.keys()], ["documents", "readings"]);
  assert.deepEqual(findMissing(new Set(["documents"]), declared, new Map()), [
    {
      table: "readings",
      declaredBy: "0001_documents.sql",
      source: "migration",
    },
  ]);
});

test("source CLI applies all tracked migrations to proposed native D1", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/validate-declared-tables-exist.ts", "--proposed-native"],
    { encoding: "utf8" },
  );
  assert.match(output, /every declared table exists in the proposed native/);
});

test("native validation refuses a view dropped after real DDL", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('schema')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    await applyTrackedD1Migrations(db);
    const counts = await assertDeclaredNativeTables(db);
    assert.ok(counts.native > 40);
    await db.prepare("DROP VIEW neurons").run();
    await assert.rejects(assertDeclaredNativeTables(db), /neurons/);
  } finally {
    await runtime.dispose();
  }
});

test("populated 0038 upgrades preserve exact legacy rows", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "declared-upgrade-"));
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('upgrade')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const dir = path.join(root, "migrations/d1");
    mkdirSync(dir, { recursive: true });
    const origin = new URL("../migrations/d1/", import.meta.url);
    const files = readdirSync(origin)
      .filter((file) => file.endsWith(".sql"))
      .filter((file) => Number(file.slice(0, 4)) <= 38)
      .sort();
    assert.equal(files.length, 38);
    for (const file of files) {
      copyFileSync(new URL(file, origin), path.join(dir, file));
    }
    const db = await runtime.getD1Database("DB");
    await applyTrackedD1Migrations(db, root);
    const at = "9007199254740993";
    const completedAt = "9007199254740994";
    const shares = ((1n << 128n) - 1n).toString();
    const positionInsert =
      "INSERT INTO nominator_positions" +
      "(coldkey,hotkey,netuid,share_fraction,captured_at,shares,source) " +
      "VALUES('legacy-alpha','validator',23,0.5," +
      "CAST(? AS INTEGER),?,'alpha')," +
      "('legacy-self','other',24,NULL,CAST(? AS INTEGER),NULL,'self-stake')";
    const passInsert =
      "INSERT INTO nominator_positions_passes" +
      "(captured_at,expected_rows,received_rows,completed_at) " +
      "VALUES(CAST(? AS INTEGER),1,1,CAST(? AS INTEGER))";
    const scanInsert =
      "INSERT INTO nominator_scan_receipts(captured_at,coldkey,row_count) " +
      "VALUES(CAST(? AS INTEGER),'legacy-alpha',1)";
    const countInsert =
      "INSERT INTO validator_nominator_counts" +
      "(hotkey,nominator_count,captured_at) " +
      "VALUES('validator',1,CAST(? AS INTEGER))";
    const countPassInsert =
      "INSERT INTO validator_nominator_counts_passes" +
      "(captured_at,expected_rows,received_rows,completed_at) " +
      "VALUES(CAST(? AS INTEGER),1,1,CAST(? AS INTEGER))";
    await db.batch([
      db.prepare(positionInsert).bind(at, shares, at),
      db.prepare(passInsert).bind(at, completedAt),
      db.prepare(scanInsert).bind(at),
      db.prepare(countInsert).bind(at),
      db.prepare(countPassInsert).bind(at, completedAt),
    ]);
    const positionSelect =
      "SELECT coldkey,hotkey,CAST(netuid AS TEXT) AS netuid," +
      "CASE WHEN share_fraction IS NULL THEN NULL ELSE " +
      "printf('%!.26g',share_fraction) END AS share_fraction," +
      "CAST(captured_at AS TEXT) AS captured_at,shares,source " +
      "FROM nominator_positions ORDER BY coldkey,hotkey,netuid";
    const passSelect =
      "SELECT CAST(captured_at AS TEXT) AS captured_at," +
      "CAST(expected_rows AS TEXT) AS expected_rows," +
      "CAST(received_rows AS TEXT) AS received_rows," +
      "CAST(completed_at AS TEXT) AS completed_at " +
      "FROM nominator_positions_passes ORDER BY captured_at";
    const scanSelect =
      "SELECT CAST(captured_at AS TEXT) AS captured_at,coldkey," +
      "CAST(row_count AS TEXT) AS row_count " +
      "FROM nominator_scan_receipts ORDER BY captured_at,coldkey";
    const countSelect =
      "SELECT hotkey,CAST(nominator_count AS TEXT) AS nominator_count," +
      "CAST(captured_at AS TEXT) AS captured_at " +
      "FROM validator_nominator_counts ORDER BY hotkey";
    const countPassSelect =
      "SELECT CAST(captured_at AS TEXT) AS captured_at," +
      "CAST(expected_rows AS TEXT) AS expected_rows," +
      "CAST(received_rows AS TEXT) AS received_rows," +
      "CAST(completed_at AS TEXT) AS completed_at " +
      "FROM validator_nominator_counts_passes ORDER BY captured_at";
    const readLegacy = async () => {
      const sql = [
        positionSelect,
        passSelect,
        scanSelect,
        countSelect,
        countPassSelect,
      ];
      const statements = sql.map((text) => db.prepare(text));
      const results = await db.batch(statements);
      return results.map((result) => result.results);
    };
    const before = await readLegacy();
    assert.equal(before[0]?.[0]?.shares, shares);
    assert.equal(before[0]?.[0]?.captured_at, at);
    assert.equal(before[0]?.[1]?.share_fraction, null);
    assert.equal(before[1]?.[0]?.completed_at, completedAt);
    assert.equal(before[2]?.[0]?.captured_at, at);
    assert.equal(before[3]?.[0]?.captured_at, at);
    assert.equal(before[4]?.[0]?.captured_at, at);
    assert.equal(before[4]?.[0]?.completed_at, completedAt);
    const next = new URL("0039_alpha_runtime_receiver.sql", origin);
    const statements = readFileSync(next, "utf8")
      .split("-- statement-breakpoint")
      .filter((sql) => sql.trim())
      .map((sql) => db.prepare(sql));
    await db.batch(statements);
    assert.deepEqual(await readLegacy(), before);
    const evidenceSql =
      "SELECT coldkey,alpha_rao,alpha_evidence " +
      "FROM nominator_positions ORDER BY coldkey";
    const evidence = await db.prepare(evidenceSql).all();
    assert.deepEqual(evidence.results, [
      { coldkey: "legacy-alpha", alpha_rao: null, alpha_evidence: null },
      { coldkey: "legacy-self", alpha_rao: null, alpha_evidence: null },
    ]);
    const anchorSql =
      "SELECT alpha_snapshot FROM validator_nominator_counts_passes";
    const anchors = await db.prepare(anchorSql).all();
    assert.deepEqual(anchors.results, [{ alpha_snapshot: null }]);
    const countSql = "SELECT COUNT(*) AS n FROM alpha_snapshot_passes";
    assert.equal(await db.prepare(countSql).first("n"), 0);
    const counts = await assertDeclaredNativeTables(db);
    assert.ok(counts.native > 40);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("default CLI checks observed state and rejects unknown flags", () => {
  const root = mkdtempSync(path.join(tmpdir(), "declared-live-"));
  const migrations = path.join(root, "migrations/d1");
  const generated = path.join(root, "generated/db");
  const source = path.join(root, "src");
  for (const dir of [migrations, generated, source]) {
    mkdirSync(dir, { recursive: true });
  }
  const ddl = "CREATE TABLE present(id INTEGER PRIMARY KEY)";
  writeFileSync(path.join(migrations, "0001_present.sql"), ddl);
  const readSets = 'export const TEST_TABLES = ["present"] as const;';
  writeFileSync(path.join(source, "read-store-tables.ts"), readSets);
  const observed = [
    {
      type: "table",
      name: "present",
      tbl_name: "present",
      sql: ddl,
    },
  ];
  const snapshot = path.join(generated, "d1-schema.json");
  writeFileSync(snapshot, JSON.stringify(observed));
  const env = { ...process.env, METAGRAPH_REPO_ROOT: root };
  const options = { encoding: "utf8" as const, env };
  const script = "scripts/validate-declared-tables-exist.ts";
  try {
    const output = execFileSync(process.execPath, [script], options);
    assert.match(output, /every declared table exists/);
    assert.match(output, /1 live/);
    for (const args of [
      ["--unknown"],
      ["--proposed-native", "--unknown"],
      ["--proposed-native", "--proposed-native"],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], options);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Use --proposed-native or no arguments/);
    }
    writeFileSync(
      path.join(migrations, "0002_missing.sql"),
      "CREATE TABLE missing(id INTEGER PRIMARY KEY)",
    );
    const failed = spawnSync(process.execPath, [script], options);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /missing.*0002_missing.sql/);
    assert.match(failed.stderr, /do not exist in the live schema/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
