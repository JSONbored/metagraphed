// The SQL buildPgUpsert emits, EXECUTED on real Postgres (#10328).
//
// ## The specific blindness this closes
//
// `tests/helpers/pg-sqlite.ts` lets seven write-path suites run against
// node:sqlite, and to make Postgres parse as SQLite it runs `stripPgCasts`,
// which DELETES EVERY `::` cast before the engine sees it. There are 204 of
// them across 29 files in `src/`.
//
// The casts are not decoration. `src/neon-write.ts` says so at the argument
// that produces them, and it is a production incident twice over:
//
//     The insert then fails with `column "netuid" is of type integer but
//     expression is of type text` -- which took the hotkey_alpha mirror down
//     TWICE. #10000 fixed only the predicate half (`src.netuid::int` inside
//     the EXISTS) and left the SELECT list handing text to an integer column.
//
// So the one construct whose absence is a total-lane outage is the one the
// double removes, and the suites that exercise the write path cannot fail on
// it. What caught the last regression was a hand-written assertion that the
// SQL TEXT contains casts -- which works for the call site someone remembered,
// and covers none of the other 203.
//
// ## Why the FILTERED form is where this lives
//
// A plain `INSERT INTO t (a, b) VALUES ($1, $2)` gives Postgres the target
// columns as type context, so an untyped parameter is inferred and no cast is
// needed. Wrapping the same list in `FROM (VALUES ...) AS src (a, b)` removes
// that context entirely: `src` is a standalone relation whose columns have no
// declared types, so every parameter falls back to TEXT and the insert into an
// integer column fails. That is a fact about Postgres, and it can only be
// demonstrated on Postgres.
//
// pglite is real Postgres compiled to wasm, and `migrations/neon/*.sql` applies
// to it verbatim -- so the schema here is production's, not a transliteration.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, test } from "vitest";
import { buildPgUpsert, pgFlatValues } from "../src/neon-write.ts";

/** The real DDL for the two tables the hotkey-alpha mirror touches. */
const MIGRATIONS = [
  "migrations/neon/0007_hand_created_tables.sql",
  "migrations/neon/0008_hotkey_alpha.sql",
].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));

const COLUMNS = ["hotkey", "netuid", "total_alpha", "captured_at"] as const;
const CONFLICT = ["hotkey", "netuid"] as const;

/** The predicate src/ledger-neon-write.ts carries, verbatim. */
const FILTER =
  "EXISTS (SELECT 1 FROM nominator_positions np" +
  " WHERE np.hotkey = src.hotkey AND np.netuid = src.netuid::int)";

/** The declared target types, verbatim. `hotkey` is text on both sides and
 * needs none -- which is exactly why a missing entry is easy to miss. */
const COLUMN_TYPES = {
  netuid: "int",
  total_alpha: "double precision",
  captured_at: "bigint",
} as const;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  for (const sql of MIGRATIONS) await pg.exec(sql);
});

beforeEach(async () => {
  await pg.exec("TRUNCATE hotkey_alpha, nominator_positions");
});

/** Make (hotkey, netuid) referenced, so the filter admits a row for it. */
const reference = (hotkey: string, netuid: number) =>
  pg.query(
    "INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)" +
      " VALUES ($1, $2, $3, 1.0, 1)",
    [`5Cold${hotkey}${netuid}`, hotkey, netuid],
  );

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    hotkey: `5Hot${i}`,
    netuid: i,
    total_alpha: 1.5 + i,
    captured_at: 1_786_000_000_000 + i,
  }));

/** Run the built statement with its flattened parameters, as the mirror does. */
const upsert = (
  rowSet: ReturnType<typeof rows>,
  {
    filter,
    columnTypes,
  }: { filter?: string; columnTypes?: Readonly<Record<string, string>> } = {},
) =>
  pg.query(
    buildPgUpsert(
      "hotkey_alpha",
      COLUMNS,
      CONFLICT,
      rowSet.length,
      "hotkey_alpha.captured_at <= EXCLUDED.captured_at",
      filter,
      columnTypes,
    ),
    pgFlatValues(rowSet, COLUMNS) as never[],
  );

describe("the FILTERED form", () => {
  test("executes, and stores only referenced pools", async () => {
    // The behaviour the filter exists for (#9832): the mirror stored every
    // pool while D1 stored only the referenced ones, and Neon ended up with
    // ~29,000 rows D1 refuses on purpose.
    await reference("5Hot0", 0);
    await reference("5Hot2", 2);
    await upsert(rows(3), { filter: FILTER, columnTypes: COLUMN_TYPES });
    const stored = await pg.query<{ hotkey: string }>(
      "SELECT hotkey FROM hotkey_alpha ORDER BY hotkey",
    );
    assert.deepEqual(
      stored.rows.map((r) => r.hotkey),
      ["5Hot0", "5Hot2"],
    );
  });

  test("WITHOUT the column types it fails, on Postgres, exactly as production did", async () => {
    // The whole point. This is the statement `stripPgCasts` produces, and it
    // is the state the hotkey_alpha mirror shipped in twice. If this ever
    // stops throwing, the casts have stopped being load-bearing and the rest
    // of this file can go -- but until then, a suite that cannot reach this
    // error is not testing the write path.
    await reference("5Hot0", 0);
    await assert.rejects(
      () => upsert(rows(1), { filter: FILTER }),
      (error: Error) => {
        assert.match(
          error.message,
          /type|text/i,
          `expected a typing failure, got: ${error.message}`,
        );
        return true;
      },
    );
  });

  test("a MISSING single entry fails too -- not just an empty map", async () => {
    // #10000's exact half-fix: the predicate was cast and the SELECT list was
    // not, so `netuid` still handed text to an integer column. A test that
    // only checked "types present vs absent" would have passed that.
    await reference("5Hot0", 0);
    const { netuid: _dropped, ...withoutNetuid } = COLUMN_TYPES;
    await assert.rejects(() =>
      upsert(rows(1), { filter: FILTER, columnTypes: withoutNetuid }),
    );
  });

  test("the guard keeps an older capture from clobbering a newer row", async () => {
    await reference("5Hot0", 0);
    const newer = [
      { ...rows(1)[0]!, total_alpha: 99, captured_at: 2_000_000_000_000 },
    ];
    await upsert(newer, { filter: FILTER, columnTypes: COLUMN_TYPES });
    const older = [
      { ...rows(1)[0]!, total_alpha: 1, captured_at: 1_000_000_000_000 },
    ];
    await upsert(older, { filter: FILTER, columnTypes: COLUMN_TYPES });
    const stored = await pg.query<{ total_alpha: number }>(
      "SELECT total_alpha FROM hotkey_alpha",
    );
    assert.equal(stored.rows[0]!.total_alpha, 99, "the older capture won");
  });

  test("a re-POST of the same batch is idempotent", async () => {
    await reference("5Hot0", 0);
    await upsert(rows(1), { filter: FILTER, columnTypes: COLUMN_TYPES });
    await upsert(rows(1), { filter: FILTER, columnTypes: COLUMN_TYPES });
    const count = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hotkey_alpha",
    );
    assert.equal(count.rows[0]!.n, 1);
  });

  test("a multi-row batch binds every row independently", async () => {
    // The shape #10304 broke in the pg statement shim: N statements carrying
    // the LAST row's values, folded by ON CONFLICT into one row. Here the
    // parameters are flattened into ONE statement, so the failure mode is
    // different -- but "did all N rows land" is the same question, and it is
    // the one worth asserting on a real engine.
    for (let i = 0; i < 4; i += 1) await reference(`5Hot${i}`, i);
    await upsert(rows(4), { filter: FILTER, columnTypes: COLUMN_TYPES });
    const stored = await pg.query<{ hotkey: string; netuid: number }>(
      "SELECT hotkey, netuid FROM hotkey_alpha ORDER BY netuid",
    );
    assert.deepEqual(
      stored.rows.map((r) => [r.hotkey, r.netuid]),
      [
        ["5Hot0", 0],
        ["5Hot1", 1],
        ["5Hot2", 2],
        ["5Hot3", 3],
      ],
    );
  });
});

describe("the UNFILTERED form", () => {
  test("needs no casts, because the target columns are the type context", async () => {
    // Stated as an executable fact rather than a comment: this is why
    // columnTypes is only threaded through the filtered branch, and why the
    // filtered branch is the one that broke.
    await upsert(rows(2));
    const count = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hotkey_alpha",
    );
    assert.equal(count.rows[0]!.n, 2);
  });
});
