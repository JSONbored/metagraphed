// #8961: SQL parameter types, exercised against a REAL Postgres.
//
// The rest of the data-api suite mocks the `postgres` module — it records the
// query text and the bound values and asserts on strings. That is why
// `realized-return-baseline-query` shipped comparing a DATE column against an
// integer and failed on every single invocation for days without one test
// going red: no mock can reproduce Postgres operator resolution.
//
// PGlite is real Postgres compiled to WASM, and `deploy/postgres/schema.sql`
// is deliberately portable vanilla Postgres ("runs as-is ... with no
// extensions required" — its own header), so the production DDL loads
// unmodified. Column types therefore come from the real schema rather than a
// hand-written fixture that could drift away from it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, test } from "vitest";
import { REALIZED_RETURN_BASELINE_TOLERANCE_DAYS } from "../workers/data-api.ts";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.ts";

const ANALYTICS_DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 10);

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(
    readFileSync(
      fileURLToPath(new URL("../deploy/postgres/schema.sql", import.meta.url)),
      "utf8",
    ),
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("deploy/postgres/schema.sql", () => {
  // Also guards the portability claim in the schema's own header: if someone
  // adds a Timescale-only construct to the vanilla file, this fails here
  // rather than at apply time against a plain Postgres.
  test("applies cleanly to a stock Postgres", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((row) => row.table_name);
    assert.ok(tables.includes("neuron_daily"));
    assert.ok(tables.length > 40, `only ${tables.length} tables created`);
  });

  // The `take` drift, generalized (see the schema's own drift-fix comments):
  // handleNeuronsSync writes NEURON_INSERT_COLUMNS into BOTH neurons and
  // neuron_daily, so every column in that list must exist in both tables —
  // neuron_daily additionally carries the snapshot key and updated_at. A
  // column added to the sync path but not to schema.sql fails here instead of
  // at apply time against a fresh deploy.
  test("neurons and neuron_daily carry every column handleNeuronsSync writes", async () => {
    for (const [table, extra] of [
      ["neurons", []],
      ["neuron_daily", ["snapshot_date", "updated_at"]],
    ] as const) {
      const { rows } = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = $1`,
        [table],
      );
      const columns = rows.map((row) => row.column_name);
      for (const column of [...NEURON_INSERT_COLUMNS, ...extra]) {
        assert.ok(columns.includes(column), `${table} is missing ${column}`);
      }
    }
  });

  test("neuron_daily.snapshot_date is a native DATE", async () => {
    const { rows } = await db.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'neuron_daily' AND column_name = 'snapshot_date'`,
    );
    assert.equal(rows[0]?.data_type, "date");
  });
});

describe("realized-return baseline query — parameter types", () => {
  // postgres.js serializes a plain JS number with type OID 0 (unspecified;
  // `types.number.to = 0`, and inferType() returns 0 for it), so the driver
  // hands Postgres an untyped parameter and lets it resolve the operator.
  // A pg-protocol `query(sql, params)` here reproduces that exactly.
  test("the shipped `::date - $n` shape fails the way production did", async () => {
    await assert.rejects(
      () =>
        db.query(
          `SELECT hotkey FROM neuron_daily
            WHERE snapshot_date <= $1 AND snapshot_date >= $1::date - $2`,
          [isoDate(ANALYTICS_DAY_MS), REALIZED_RETURN_BASELINE_TOLERANCE_DAYS],
        ),
      (err: Error) => {
        // The exact message on 5,196 production exceptions. Pinned verbatim:
        // if a future Postgres resolves this differently, that is worth
        // knowing rather than silently passing.
        assert.match(err.message, /operator does not exist: date >= integer/);
        return true;
      },
    );
  });

  test("both bounds as date strings execute against the real column", async () => {
    const { rows } = await db.query(
      `SELECT hotkey FROM neuron_daily
        WHERE snapshot_date <= $1 AND snapshot_date >= $2`,
      [
        isoDate(ANALYTICS_DAY_MS),
        isoDate(
          (1 + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS) * ANALYTICS_DAY_MS,
        ),
      ],
    );
    assert.deepEqual(rows, []);
  });

  // The fix must not quietly change which snapshots qualify: a JS-side floor
  // has to select exactly what the SQL subtraction intended.
  test("the JS-computed floor selects the same rows the SQL subtraction meant to", async () => {
    await db.exec("DELETE FROM neuron_daily");
    const days = 1;
    const rowsIn: [string, number][] = [
      // [snapshot_date, expected-to-be-selected as 1/0]
      [isoDate(days * ANALYTICS_DAY_MS), 1], // the target date itself
      [
        isoDate(
          (days + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS) * ANALYTICS_DAY_MS,
        ),
        1,
      ], // oldest still permitted
      [
        isoDate(
          (days + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS + 1) *
            ANALYTICS_DAY_MS,
        ),
        0,
      ], // one day too old (#8837's stale-baseline rejection)
      [isoDate(0), 0], // newer than the window — must not be a baseline
    ];
    let uid = 0;
    for (const [date] of rowsIn) {
      uid += 1;
      await db.query(
        `INSERT INTO neuron_daily
           (netuid, uid, snapshot_date, hotkey, validator_permit, stake_tao,
            captured_at, updated_at)
         VALUES (1, $1, $2, 'hk', TRUE, 100, 0, 0)`,
        [uid, date],
      );
    }

    const cutoff = isoDate(days * ANALYTICS_DAY_MS);
    const floor = isoDate(
      (days + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS) * ANALYTICS_DAY_MS,
    );
    const { rows } = await db.query<{ snapshot_date: Date }>(
      `SELECT snapshot_date FROM neuron_daily
        WHERE validator_permit = TRUE
          AND snapshot_date <= $1 AND snapshot_date >= $2
        ORDER BY snapshot_date DESC`,
      [cutoff, floor],
    );

    const expected = rowsIn
      .filter(([, keep]) => keep === 1)
      .map(([date]) => date)
      .sort()
      .reverse();
    assert.deepEqual(
      rows.map((row) =>
        row.snapshot_date instanceof Date
          ? row.snapshot_date.toISOString().slice(0, 10)
          : String(row.snapshot_date),
      ),
      expected,
    );
  });
});
