// The validator-nominator-counts D1 write path (#9146) and the schema it
// writes into.
//
// Two things are checked here and they fail in different ways. The MIGRATION
// check is anti-drift: a column the writer binds but the table lacks makes D1
// reject the whole batch, and a column the table has but the writer never
// sends is a permanently-NULL field that reads like real data (0007's
// tests/neurons-d1-schema.test.ts and 0011's
// tests/nominator-positions-d1-write.test.ts make the same guarantee for their
// own tables). The WRITER checks are about the parameter budget and the
// staleness guard: this lane posts a ~113k-row scan across several requests,
// so a chunk that overran the binding's limit would fail the whole batch, and
// a replayed request must never walk a count backwards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { writeValidatorNominatorCountsToD1 } from "../src/validator-nominator-counts-d1-write.ts";
import { VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS } from "../src/validator-nominator-summary.ts";
import { D1_PARAM_BUDGET } from "../src/neurons-d1-write.ts";

const MIGRATION = readFileSync(
  "migrations/d1/0012_validator_nominator_counts.sql",
  "utf8",
);

const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";

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

function row(hotkey: string, count: number, at: number) {
  return { hotkey, nominator_count: count, captured_at: at };
}

describe("the validator_nominator_counts D1 schema matches its writer", () => {
  test("the migration parser actually finds columns", () => {
    // A regex that silently matched nothing would make every comparison below
    // vacuously pass -- the way a source-scanning check stops checking.
    assert.equal(tableColumns("validator_nominator_counts").length, 3);
  });

  test("the table holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("validator_nominator_counts").sort(),
      [...VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS].sort(),
    );
  });

  test("the upsert key is one row per hotkey", () => {
    // Latest-only: the Postgres original was PRIMARY KEY (hotkey) with
    // REPLACE-on-conflict, and the serving readers assume one row per hotkey
    // (the lakehouse mirror, which does NOT enforce this, needs a group-wise
    // MAX for exactly that reason -- see
    // src/validator-nominator-counts-cold-tier.ts).
    assert.match(
      MIGRATION,
      /PRIMARY KEY \(hotkey\)/,
      "the PRIMARY KEY must be the same key the writer declares as its conflict target",
    );
  });
});

describe("writeValidatorNominatorCountsToD1", () => {
  test("upserts on hotkey with the staleness guard", async () => {
    const { statements, db } = d1Stub();
    const { statements: count } = await writeValidatorNominatorCountsToD1(
      db as never,
      [row(HOTKEY, 12, 1_000), row("5G9", 3, 1_000)],
    );

    assert.equal(count, statements.length);
    assert.equal(statements.length, 1, "two narrow rows fit one statement");
    assert.match(
      statements[0]!.sql,
      /INSERT INTO validator_nominator_counts \(hotkey, nominator_count, captured_at\)/,
    );
    assert.match(statements[0]!.sql, /ON CONFLICT \(hotkey\) DO UPDATE SET/);
    assert.match(
      statements[0]!.sql,
      /WHERE validator_nominator_counts\.captured_at <= excluded\.captured_at/,
      "an older capture must never overwrite a newer one",
    );
    assert.deepEqual(statements[0]!.params, [
      HOTKEY,
      12,
      1_000,
      "5G9",
      3,
      1_000,
    ]);
  });

  test("no statement exceeds the Workers binding's bound-parameter limit", async () => {
    // 100 per statement on the BINDING -- not the 1,200 `wrangler d1 execute`
    // permits from the CLI. The first 15 production neurons syncs all failed
    // on exactly this, so the limit is asserted, never a constant we picked.
    const { statements, db } = d1Stub();
    await writeValidatorNominatorCountsToD1(
      db as never,
      Array.from({ length: 500 }, (_unused, i) => row(`hk-${i}`, i, 1_000)),
    );
    assert.ok(statements.length > 1, "500 rows must chunk");
    for (const statement of statements) {
      assert.ok(
        statement.params.length <= D1_PARAM_BUDGET,
        `a statement bound ${statement.params.length} parameters, over the ${D1_PARAM_BUDGET} budget`,
      );
    }
  });

  test("an empty batch issues no statements and never calls batch()", async () => {
    // An empty `db.batch([])` is a round trip that can only fail; the producer
    // legitimately posts nothing when a chunk boundary lands cleanly.
    const { statements, batches, db } = d1Stub();
    const result = await writeValidatorNominatorCountsToD1(db as never, []);
    assert.equal(result.statements, 0);
    assert.equal(statements.length, 0);
    assert.deepEqual(batches, []);
  });
});
