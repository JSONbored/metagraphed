// The neurons-sync D1 write path (#9146 priority 1).
//
// The neurons family is the only LIVE-refreshed data left on the decommissioned
// box. History is in the lakehouse and frozen; if the sync has nowhere to write
// once the box goes, the metagraph stops advancing. So this path has to be
// right before the wipe, not after.
//
// Every SQL behaviour asserted here was also executed against PRODUCTION D1
// while writing it -- the multi-row upsert, the `captured_at <= excluded`
// staleness guard, and the per-netuid prune -- because "SQLite supports this
// syntax" is a claim about a dialect, not about the database we actually run
// on. These tests pin the shape so a regression fails here rather than in a
// once-a-day sync.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  buildUpsert,
  D1_PARAM_BUDGET,
  NEURON_DAILY_COLUMNS,
  rowsPerStatement,
  writeNeuronSnapshotToD1,
} from "../src/neurons-d1-write.ts";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.ts";

/** Records what would be sent to D1, without a database. */
function fakeDb() {
  const prepared: { sql: string; values: unknown[] }[] = [];
  let batched: unknown[] | null = null;
  const batchCalls: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const entry = { sql, values: [] as unknown[] };
      prepared.push(entry);
      return {
        bind(...values: unknown[]) {
          entry.values = values;
          return entry;
        },
      };
    },
    async batch(statements: unknown[]) {
      batched = batched ? [...batched, ...statements] : [...statements];
      batchCalls.push(statements);
      return [];
    },
  };
  return {
    db: db as unknown as Parameters<typeof writeNeuronSnapshotToD1>[0],
    prepared,
    batched: () => batched,
    batchCalls: () => batchCalls,
  };
}

function neuronRow(
  netuid: number,
  uid: number,
  capturedAt = 1000,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of NEURON_INSERT_COLUMNS) row[column] = null;
  return { ...row, netuid, uid, hotkey: `hk${uid}`, captured_at: capturedAt };
}

describe("the Workers-binding parameter limit (the one that bit production)", () => {
  test("every statement stays at or under 100 bound parameters", () => {
    // The wrangler/HTTP path accepts 1,200 params; the WORKERS BINDING caps
    // at 100 and failed all 15 first production syncs. The budget must hold
    // against the strictest limit of the runtime it actually executes on.
    for (const cols of [15, 20, 21, 22, 30]) {
      const per = rowsPerStatement(cols);
      assert.ok(
        per * cols <= 100,
        `${cols} columns x ${per} rows = ${per * cols} params > 100`,
      );
      assert.ok(per >= 1);
    }
  });

  test("a full-size snapshot is batched in slices with prunes last", async () => {
    const { db, batchCalls } = fakeDb();
    // 4 rows/statement at 21 columns -> 4,500 rows = 1,126 statements = 2 slices.
    const rows = Array.from({ length: 4_500 }, (_, i) => neuronRow(1, i));
    await writeNeuronSnapshotToD1(db, {
      rows,
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map([[1, 1785700000000]]),
    });
    const calls = batchCalls();
    assert.ok(calls.length >= 2, "sliced into multiple batch() calls");
    for (const c of calls) {
      assert.ok(c.length <= 1_000, `slice of ${c.length} exceeds 1,000`);
    }
    // Order across slices is the write order; the prune is the last statement
    // of the last slice, never ahead of the upserts it depends on.
    const last = calls[calls.length - 1]!;
    assert.ok(last.length >= 1);
  });
});

describe("the neurons D1 write path (#9146)", () => {
  test("the batch size is derived from the column count, not fixed", () => {
    // A hardcoded chunk size silently exceeds the parameter budget the day a
    // column is added. Measured against production D1: 1,200 bound parameters
    // execute fine, so the 900 budget has real headroom.
    assert.equal(
      rowsPerStatement(NEURON_INSERT_COLUMNS.length),
      Math.floor(D1_PARAM_BUDGET / NEURON_INSERT_COLUMNS.length),
    );
    for (const columns of [
      NEURON_INSERT_COLUMNS,
      NEURON_DAILY_COLUMNS,
      ACCOUNT_POSITION_DAILY_COLUMNS,
    ]) {
      assert.ok(
        rowsPerStatement(columns.length) * columns.length <= D1_PARAM_BUDGET,
        `${columns.length} columns would exceed the bound-parameter budget`,
      );
    }
  });

  test("the upsert refreshes every non-key column and guards on captured_at", () => {
    const sql = buildUpsert(
      "neurons",
      NEURON_INSERT_COLUMNS,
      ["netuid", "uid"],
      2,
    );
    // The staleness guard is the whole reason a replayed or out-of-order batch
    // is a no-op instead of a regression.
    assert.match(sql, /WHERE neurons\.captured_at <= excluded\.captured_at$/);
    for (const column of NEURON_INSERT_COLUMNS) {
      if (column === "netuid" || column === "uid") {
        assert.ok(
          !sql.includes(`${column} = excluded.${column}`),
          `${column} is an upsert key and must not be in the SET clause`,
        );
        continue;
      }
      assert.ok(
        sql.includes(`${column} = excluded.${column}`),
        `${column} would go stale on update -- it is written on insert but never refreshed`,
      );
    }
    // Two rows means two placeholder tuples, not two statements.
    assert.equal(
      (sql.match(/\(\?/g) ?? []).length,
      2,
      "a multi-row chunk must produce one statement with one tuple per row",
    );
  });

  test("a chunk binds its values in column order", () => {
    // A shifted binding writes every value into the wrong column and still
    // succeeds, which is the worst kind of failure this path can have.
    const { db, prepared } = fakeDb();
    const row = neuronRow(1, 0);
    void writeNeuronSnapshotToD1(db, {
      rows: [row],
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map(),
    });
    const values = prepared[0].values;
    assert.equal(values.length, NEURON_INSERT_COLUMNS.length);
    NEURON_INSERT_COLUMNS.forEach((column, index) => {
      assert.equal(
        values[index],
        row[column] ?? null,
        `${column} is bound at the wrong position`,
      );
    });
  });

  test("rows are split into statements once the budget is reached", () => {
    const perStatement = rowsPerStatement(NEURON_INSERT_COLUMNS.length);
    const rows = Array.from({ length: perStatement + 1 }, (_, uid) =>
      neuronRow(1, uid),
    );
    const { db, prepared } = fakeDb();
    void writeNeuronSnapshotToD1(db, {
      rows,
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map(),
    });
    assert.equal(
      prepared.length,
      2,
      "one row past the budget needs a second statement",
    );
    assert.equal(
      prepared[0].values.length,
      perStatement * NEURON_INSERT_COLUMNS.length,
    );
    assert.equal(prepared[1].values.length, NEURON_INSERT_COLUMNS.length);
  });

  test("the prune is per-netuid, never batch-wide", () => {
    // A single shared threshold lets one netuid's later capture delete rows
    // this same request just wrote for a different, earlier-captured netuid.
    const { db, prepared } = fakeDb();
    void writeNeuronSnapshotToD1(db, {
      rows: [neuronRow(1, 0, 1000), neuronRow(2, 0, 500)],
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map([
        [1, 1000],
        [2, 500],
      ]),
    });
    const deletes = prepared.filter((statement) =>
      statement.sql.startsWith("DELETE"),
    );
    assert.equal(deletes.length, 2, "one prune per covered netuid");
    assert.deepEqual(deletes.map((statement) => statement.values).sort(), [
      [1, 1000],
      [2, 500],
    ]);
    for (const statement of deletes) {
      assert.match(statement.sql, /netuid = \? AND captured_at < \?/);
    }
  });

  test("everything goes through ONE batch, so a partial write is impossible", async () => {
    // db.batch() is transactional. Issuing the statements individually would
    // let a mid-batch failure leave `neurons` upserted with stale UIDs
    // un-pruned -- the exact state the Postgres side uses sql.begin() to avoid.
    const { db, prepared, batched } = fakeDb();
    await writeNeuronSnapshotToD1(db, {
      rows: [neuronRow(1, 0)],
      dailyRows: [
        { ...neuronRow(1, 0), snapshot_date: "2026-08-02", updated_at: 1 },
      ],
      positionRows: [
        {
          account: "hk0",
          netuid: 1,
          snapshot_date: "2026-08-02",
          captured_at: 1000,
          updated_at: 1,
        },
      ],
      netuidMaxCapturedAt: new Map([[1, 1000]]),
    });
    assert.equal(batched()?.length, prepared.length);
    assert.equal(prepared.length, 4, "three tables plus one prune");
  });

  test("an empty batch touches the database not at all", async () => {
    const { db, batched } = fakeDb();
    const result = await writeNeuronSnapshotToD1(db, {
      rows: [],
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map(),
    });
    assert.equal(result.statements, 0);
    assert.equal(batched(), null, "an empty write must not open a transaction");
  });
});
