// The nominator-positions D1 write path (#9273) and the schema it writes into.
//
// Two things are checked here and they fail in different ways. The MIGRATION
// check is anti-drift: a column the writer binds but the table lacks makes D1
// reject the whole batch, and a column the table has but the writer never
// sends is a permanently-NULL field that reads like real data (0007's
// tests/neurons-d1-schema.test.ts makes the same guarantee for `neurons`). The
// WRITER checks are about the prune: this lane posts a full Alpha scan across
// several requests, so a batch-wide prune would delete rows a sibling request
// just wrote -- the cutoffs must be per coldkey, and they must never be
// ordered ahead of the upserts they depend on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  coldkeyMaxCapturedAt,
  writeNominatorPositionsToD1,
} from "../src/nominator-positions-d1-write.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "../src/account-nominator-positions.ts";
import { D1_PARAM_BUDGET } from "../src/neurons-d1-write.ts";
import { D1_BIND_PARAM_CAP } from "../src/nominator-positions-cold-tier.ts";

const MIGRATION = readFileSync(
  "migrations/d1/0011_nominator_positions.sql",
  "utf8",
);

const COLDKEY_A = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const COLDKEY_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

/** Column names of one CREATE TABLE block, in declaration order. */
function tableColumns(table: string): string[] {
  const match = MIGRATION.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(match, `no CREATE TABLE for ${table} in the migration`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("--") &&
        !line.startsWith("PRIMARY KEY") &&
        !line.startsWith("CHECK"),
    )
    .map((line) => line.split(/\s+/)[0]);
}

/** Records every prepared statement and its bindings, in order. */
function d1Stub() {
  const statements: { sql: string; params: unknown[] }[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const entry = { sql, params };
          statements.push(entry);
          return entry as never;
        },
      };
    },
    async batch(slice: unknown[]) {
      batches.push(slice.length);
      return [];
    },
  };
  return { statements, batches, db };
}

function row(coldkey: string, hotkey: string, netuid: number, at: number) {
  return {
    coldkey,
    hotkey,
    netuid,
    share_fraction: 0.25,
    captured_at: at,
  };
}

describe("the nominator_positions D1 schema matches its writer", () => {
  test("the migration parser actually finds columns", () => {
    // A regex that silently matched nothing would make every comparison below
    // vacuously pass -- the way a source-scanning check stops checking.
    assert.equal(tableColumns("nominator_positions").length, 5);
  });

  test("the table holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("nominator_positions").sort(),
      [...NOMINATOR_POSITION_INSERT_COLUMNS].sort(),
    );
  });

  test("the upsert key is the ledger's real identity", () => {
    // (coldkey, hotkey, netuid) -- a coldkey holds one position per hotkey per
    // subnet, and any looser key would make a second subnet's position
    // overwrite the first.
    assert.match(
      MIGRATION,
      /PRIMARY KEY \(coldkey, hotkey, netuid\)/,
      "the PRIMARY KEY must be the same triple the writer declares as its conflict target",
    );
  });
});

describe("writeNominatorPositionsToD1", () => {
  test("upserts on the full triple with the staleness guard, then prunes per coldkey", async () => {
    const { statements, db } = d1Stub();
    const rows = [
      row(COLDKEY_A, "5Fy", 18, 1_000),
      row(COLDKEY_B, "5G9", 4, 2_000),
    ];
    const { statements: count } = await writeNominatorPositionsToD1(
      db as never,
      { rows, coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(rows) },
    );

    assert.equal(count, statements.length);
    assert.match(statements[0]!.sql, /INSERT INTO nominator_positions/);
    assert.match(
      statements[0]!.sql,
      /ON CONFLICT \(coldkey, hotkey, netuid\) DO UPDATE SET/,
    );
    assert.match(
      statements[0]!.sql,
      /WHERE nominator_positions\.captured_at <= excluded\.captured_at/,
      "an older capture must never overwrite a newer one",
    );

    const prunes = statements.filter((s) => s.sql.startsWith("DELETE"));
    assert.equal(prunes.length, 2, "one prune per coldkey in the batch");
    for (const prune of prunes) {
      assert.equal(
        prune.sql,
        "DELETE FROM nominator_positions WHERE coldkey = ? AND captured_at < ?",
      );
    }
    assert.deepEqual(prunes[0]!.params, [COLDKEY_A, 1_000]);
    assert.deepEqual(prunes[1]!.params, [COLDKEY_B, 2_000]);
  });

  test("every prune is ordered AFTER the upserts it depends on", async () => {
    // batchInSlices preserves statement order and atomicity is per slice, so
    // the worst a mid-run failure may do is leave a stale position behind --
    // never delete one without having written its replacement first.
    const { statements, db } = d1Stub();
    const rows = Array.from({ length: 60 }, (_unused, i) =>
      row(COLDKEY_A, `hk-${i}`, i, 1_000),
    );
    await writeNominatorPositionsToD1(db as never, {
      rows,
      coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(rows),
    });
    const firstDelete = statements.findIndex((s) => s.sql.startsWith("DELETE"));
    const lastInsert = statements.reduce(
      (last, s, i) => (s.sql.startsWith("INSERT") ? i : last),
      -1,
    );
    assert.ok(firstDelete > lastInsert, "no prune may precede an upsert");
  });

  test("no statement exceeds the Workers binding's bound-parameter limit", async () => {
    // 100 per statement on the BINDING -- not the 1,200 `wrangler d1 execute`
    // permits from the CLI. The first 15 production neurons syncs all failed
    // on exactly this, so the limit is asserted, never a constant we picked.
    const { statements, db } = d1Stub();
    const rows = Array.from({ length: 500 }, (_unused, i) =>
      row(COLDKEY_A, `hk-${i}`, i, 1_000),
    );
    await writeNominatorPositionsToD1(db as never, {
      rows,
      coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(rows),
    });
    assert.ok(statements.length > 1, "500 rows must not be one statement");
    for (const statement of statements) {
      assert.ok(
        statement.params.length <= D1_BIND_PARAM_CAP,
        `a statement bound ${statement.params.length} parameters; D1's binding rejects anything over ${D1_BIND_PARAM_CAP}`,
      );
    }
    // The chunk size is DERIVED from the column count, so adding a column
    // re-sizes the batch instead of silently pushing it over the limit.
    assert.ok(D1_PARAM_BUDGET <= D1_BIND_PARAM_CAP);
  });

  test("an empty batch issues no statements and no db.batch call", async () => {
    const { statements, batches, db } = d1Stub();
    const result = await writeNominatorPositionsToD1(db as never, {
      rows: [],
      coldkeyMaxCapturedAt: new Map(),
    });
    assert.equal(result.statements, 0);
    assert.equal(statements.length, 0);
    assert.deepEqual(batches, []);
  });
});

describe("coldkeyMaxCapturedAt", () => {
  test("keeps the LATEST capture per coldkey, whatever the row order", () => {
    const cutoffs = coldkeyMaxCapturedAt([
      row(COLDKEY_A, "a", 1, 5_000),
      row(COLDKEY_A, "b", 2, 9_000),
      row(COLDKEY_A, "c", 3, 7_000),
      row(COLDKEY_B, "d", 4, 1_000),
    ]);
    assert.equal(cutoffs.get(COLDKEY_A), 9_000);
    assert.equal(cutoffs.get(COLDKEY_B), 1_000);
  });

  test("skips a row whose coldkey or captured_at is unusable", () => {
    // A NaN cutoff would make the prune's `captured_at < ?` comparison
    // meaningless; a missing coldkey has nothing to scope a prune to.
    const cutoffs = coldkeyMaxCapturedAt([
      { ...row(COLDKEY_A, "a", 1, 5_000), captured_at: "not-a-number" },
      { ...row(COLDKEY_B, "b", 2, 3_000), coldkey: null },
      row(COLDKEY_A, "c", 3, 4_000),
    ]);
    assert.deepEqual([...cutoffs.entries()], [[COLDKEY_A, 4_000]]);
  });
});
