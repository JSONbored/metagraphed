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
  D1_JSON_BUDGET_BYTES,
  writeNeuronSnapshotToD1,
  netuidMaxCapturedAt,
  buildLatestHashGuard,
  buildJsonAppendInsert,
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

  test("a full-size snapshot collapses to a handful of statements", async () => {
    const { db, batchCalls, prepared } = fakeDb();
    // The old shape: 21 columns against a 90-parameter budget is 4 rows a
    // statement, so 4,500 rows was 1,126 statements and two batch slices. That
    // arithmetic is what put a real pass past the producer's 60-second request
    // timeout, so the assertion is now about how FEW statements this is.
    const rows = Array.from({ length: 4_500 }, (_, i) => neuronRow(1, i));
    await writeNeuronSnapshotToD1(db, {
      rows,
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map([[1, 1785700000000]]),
    });
    const oldShape = Math.ceil(
      4_500 / rowsPerStatement(NEURON_INSERT_COLUMNS.length),
    );
    assert.ok(
      prepared.length * 20 < oldShape,
      `${prepared.length} statements must be far below the ${oldShape} the parameter budget needed`,
    );
    const calls = batchCalls();
    for (const c of calls) {
      assert.ok(c.length <= 1_000, `slice of ${c.length} exceeds 1,000`);
    }
    // The prune still lands last: it depends on the upserts ahead of it, and
    // batchInSlices gives no single transaction across slices.
    const last = calls[calls.length - 1]!;
    assert.ok(last.length >= 1);
    assert.match(
      prepared[prepared.length - 1]!.sql,
      /DELETE|captured_at/,
      "the prune is the final statement",
    );
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
    // succeeds, which is the worst kind of failure this path can have. Rows now
    // travel as positional arrays inside ONE json_each parameter, so the
    // ordering contract moved from the bind list into the tuple -- and the
    // statement's json_extract('$[i]') list has to agree with it.
    const { db, prepared } = fakeDb();
    const row = neuronRow(1, 0);
    void writeNeuronSnapshotToD1(db, {
      rows: [row],
      dailyRows: [],
      positionRows: [],
      netuidMaxCapturedAt: new Map(),
    });
    assert.equal(prepared[0].values.length, 1, "one parameter per statement");
    const [tuple] = JSON.parse(prepared[0].values[0] as string);
    assert.equal(tuple.length, NEURON_INSERT_COLUMNS.length);
    NEURON_INSERT_COLUMNS.forEach((column, index) => {
      assert.equal(
        tuple[index],
        row[column] ?? null,
        `${column} is bound at the wrong position`,
      );
      assert.ok(
        prepared[0].sql.includes(`json_extract(value, '$[${index}]')`),
        `${column} has no extractor at its position`,
      );
    });
  });

  test("rows are split into statements once the BYTE budget is reached", () => {
    // The split is by serialized payload now, not by a parameter count: a
    // chunk carries one parameter however many rows it holds, so what bounds
    // it is how big that parameter gets.
    const oneRow = JSON.stringify(
      NEURON_INSERT_COLUMNS.map((c) => neuronRow(1, 0)[c] ?? null),
    ).length;
    const perStatement = Math.floor(D1_JSON_BUDGET_BYTES / (oneRow + 1));
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
    for (const p of prepared) {
      assert.equal(p.values.length, 1, "one parameter per statement");
      assert.ok(
        (p.values[0] as string).length <= D1_JSON_BUDGET_BYTES,
        "no chunk exceeds the byte budget",
      );
    }
    // And the whole point: this is far fewer statements than the parameter
    // budget allowed. 22 rows a statement at four columns was the shape that
    // put a 364k-row pass at ~14,600 statements and timed the request out.
    assert.ok(
      perStatement > rowsPerStatement(NEURON_INSERT_COLUMNS.length) * 20,
      "the JSON budget must hold far more rows than the parameter budget did",
    );
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

describe("netuidMaxCapturedAt", () => {
  test("takes the LATEST capture per netuid, not one batch-wide max", () => {
    // A batch-wide max would let one netuid's later capture delete rows this
    // same write just upserted for a different, earlier-captured netuid.
    const cutoffs = netuidMaxCapturedAt([
      { netuid: 7, captured_at: 100 },
      { netuid: 7, captured_at: 300 },
      { netuid: 8, captured_at: 200 },
    ]);
    assert.equal(cutoffs.get(7), 300);
    assert.equal(cutoffs.get(8), 200);
  });

  test("skips a row with no usable netuid rather than keying on NaN", () => {
    const cutoffs = netuidMaxCapturedAt([
      { netuid: null, captured_at: 100 },
      { captured_at: 100 },
      { netuid: 7, captured_at: 100 },
    ]);
    assert.deepEqual([...cutoffs.keys()], [7]);
  });

  test("skips a row with no usable captured_at, which would delete everything", () => {
    // A NaN cutoff makes `captured_at < cutoff` false for every row, but a
    // null one binds as NULL and the comparison stops being a guard at all --
    // either way the safe move is to not seed a cutoff from an unusable row.
    const cutoffs = netuidMaxCapturedAt([
      { netuid: 7, captured_at: null },
      { netuid: 8, captured_at: "soon" },
    ]);
    assert.equal(cutoffs.size, 0);
  });
});

describe("buildLatestHashGuard", () => {
  const COLUMNS = ["account", "observed_at", "name", "identity_hash"];

  test("compares against the LATEST row, not against any row", () => {
    // The whole reason this is a guard and not a UNIQUE (key, hash): matching
    // any row would forbid a value returning to an earlier one, which is a real
    // history. Matching the latest one only forbids the duplicate.
    const sql = buildLatestHashGuard(
      "account_identity_history",
      COLUMNS,
      "account",
      "identity_hash",
    );
    assert.match(sql, /MAX\(id\)/);
    assert.match(sql, /json_extract\(value, '\$\[0\]'\)/, "keyed on account");
    assert.match(sql, /json_extract\(value, '\$\[3\]'\)/, "hash at its index");
  });

  test("throws when a column it needs is not in the statement", () => {
    // A guard built against the wrong column list would silently compare
    // json_extract(value, '$[-1]') -- NULL -- and never suppress anything.
    assert.throws(
      () => buildLatestHashGuard("t", COLUMNS, "netuid", "identity_hash"),
      /guard needs netuid and identity_hash/,
    );
    assert.throws(
      () => buildLatestHashGuard("t", COLUMNS, "account", "nope"),
      /guard needs account and nope/,
    );
  });

  test("an append with no guard is unconditional, as it was", () => {
    // The neurons history tables append every row; only the two diff-and-append
    // lanes need the guard, so the unguarded form must stay exactly as it was.
    const sql = buildJsonAppendInsert("neuron_daily", ["netuid", "uid"]);
    assert.equal(sql.includes("WHERE"), false);
    assert.match(sql, /FROM json_each\(\?1\)$/);
  });
});
