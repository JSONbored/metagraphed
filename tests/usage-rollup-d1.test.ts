import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import type {
  ProducerStatement,
  ProducerStore,
} from "../src/producer-store.ts";
import { writeUsageRollupD1 } from "../src/usage-rollup-d1.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
const buckets = [
  {
    day: "2026-09-30",
    family: "blocks",
    cost_shape: "edge",
    request_count: 7,
    keyed_count: 2,
  },
  {
    day: "2026-09-30",
    family: "blocks",
    cost_shape: "edge",
    request_count: 3,
    keyed_count: 1,
  },
  {
    day: "2026-09-29",
    family: "subnets",
    cost_shape: "postgres",
    request_count: 5,
    keyed_count: 0,
  },
];
const expected = [
  {
    day: "2026-09-29",
    route_family: "subnets",
    cost_shape: "postgres",
    request_count: 5,
    keyed_count: 0,
  },
  {
    day: "2026-09-30",
    route_family: "blocks",
    cost_shape: "edge",
    request_count: 10,
    keyed_count: 3,
  },
];
const transientErrors = [
  "D1_ERROR: Network connection lost.",
  "Network connection lost.",
  "D1_ERROR: Replica disconnected from primary.",
  "D1_ERROR: D1 DB reset because its code was updated.",
  "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
  "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
  "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.",
  "D1_ERROR: internal error; reference = e_provider_reset",
];

function fixture() {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0005_user_state.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    readFileSync(
      new URL(
        "../migrations/d1/0036_usage_rollup_batch_receipts.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let beforeStatement:
    | ((statement: ProducerStatement, index: number) => void)
    | undefined;
  let afterCommit: (() => void) | undefined;
  let beforeRead: (() => void) | undefined;
  let readback: ((row: unknown) => unknown) | undefined;
  let transactions = 0;
  const store = {
    async transaction(statements: readonly ProducerStatement[]) {
      transactions++;
      sql.exec("BEGIN");
      let results;
      try {
        results = statements.map((statement, index) => {
          beforeStatement?.(statement, index);
          const result = sql
            .prepare(statement.text)
            .run(...(statement.values as never[]));
          return { changes: Number(result.changes) };
        });
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
      afterCommit?.();
      return results;
    },
    async first<Row>(text: string, values: unknown[] = []) {
      beforeRead?.();
      const row = sql.prepare(text).get(...(values as never[])) ?? null;
      return (readback ? readback(row) : row) as Row | null;
    },
  } as ProducerStore;
  const totals = () =>
    sql
      .prepare(
        "SELECT * FROM api_usage_rollup ORDER BY day,route_family,cost_shape",
      )
      .all()
      .map((row) => ({ ...row }));
  return {
    sql,
    store,
    totals,
    transactions: () => transactions,
    before(fn?: typeof beforeStatement) {
      beforeStatement = fn;
    },
    committed(fn?: typeof afterCommit) {
      afterCommit = fn;
    },
    reading(fn?: typeof beforeRead) {
      beforeRead = fn;
    },
    readWith(fn?: typeof readback) {
      readback = fn;
    },
  };
}

test("one atomic flush preserves every family/day total and distinct flushes add", async () => {
  const f = fixture();
  await writeUsageRollupD1(f.store, buckets);
  assert.deepEqual(f.totals(), expected);
  await writeUsageRollupD1(f.store, buckets);
  assert.deepEqual(
    f.totals(),
    expected.map((row) => ({
      ...row,
      request_count: row.request_count * 2,
      keyed_count: row.keyed_count * 2,
    })),
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM api_usage_rollup_batches").get()?.n,
    2,
  );
});

test("an empty valid batch performs no write", async () => {
  const f = fixture();
  await writeUsageRollupD1(f.store, []);
  assert.equal(f.transactions(), 0);
});

test.each([0, 1, 2, 3])(
  "a failed statement %s rolls back every bucket and receipt",
  async (index) => {
    vi.useFakeTimers();
    const f = fixture();
    let attempts = 0;
    f.before((_statement, current) => {
      if (current === index && ++attempts === 1)
        throw new Error(transientErrors[0]);
    });
    const pending = writeUsageRollupD1(f.store, buckets);
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(attempts, 2);
    assert.deepEqual(f.totals(), expected);
    assert.equal(
      f.sql
        .prepare(
          "SELECT count(*) n FROM api_usage_rollup_batches WHERE applied=1",
        )
        .get()?.n,
      1,
    );
  },
);

test.each(transientErrors)(
  "a lost committed reply never double-counts: %s",
  async (message) => {
    vi.useFakeTimers();
    const f = fixture();
    let attempts = 0;
    f.committed(() => {
      if (++attempts === 1) throw new Error(message);
    });
    const pending = writeUsageRollupD1(f.store, buckets);
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(f.transactions(), 2);
    assert.deepEqual(f.totals(), expected);
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM api_usage_rollup_batches").get()?.n,
      1,
    );
  },
);

test.each(transientErrors)(
  "a receipt read failure can replay an already committed flush: %s",
  async (message) => {
    vi.useFakeTimers();
    const f = fixture();
    let reads = 0;
    f.reading(() => {
      if (++reads === 1) throw new Error(message);
    });
    const pending = writeUsageRollupD1(f.store, buckets);
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(reads, 2);
    assert.deepEqual(f.totals(), expected);
  },
);

test.each([
  ...transientErrors.map((message) => new Error(message)),
  new Error("D1_ERROR: overloaded"),
  new Error("D1_ERROR: internal error"),
  new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset."),
  "D1_ERROR: Network connection lost.",
])(
  "persistent errors retain their original failure and cannot apply a prefix: %s",
  async (error) => {
    vi.useFakeTimers();
    const f = fixture();
    f.before((_statement, index) => {
      if (index === 3) throw error;
    });
    const rejected = assert.rejects(
      writeUsageRollupD1(f.store, buckets),
      (actual) => actual === error,
    );
    await vi.runAllTimersAsync();
    await rejected;
    assert.equal(
      f.transactions(),
      error instanceof Error && transientErrors.includes(error.message) ? 2 : 1,
    );
    assert.deepEqual(f.totals(), []);
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM api_usage_rollup_batches").get()?.n,
      0,
    );
  },
);

test.each([null, { sha256: "wrong", applied: 1 }, { applied: 0 }])(
  "missing or corrupt receipts cannot acknowledge counts: %s",
  async (row) => {
    const f = fixture();
    f.readWith((actual) => row && { ...(actual as object), ...row });
    await assert.rejects(
      writeUsageRollupD1(f.store, buckets),
      /not acknowledged/,
    );
    assert.equal(f.transactions(), 1);
  },
);

test("concurrent replays share one receipt, while a reused identity cannot change its data", async () => {
  const f = fixture();
  const deps = { batchId: "same-batch" };
  await Promise.all([
    writeUsageRollupD1(f.store, buckets, deps),
    writeUsageRollupD1(f.store, buckets, deps),
  ]);
  assert.deepEqual(f.totals(), expected);
  await assert.rejects(
    writeUsageRollupD1(f.store, [{ ...buckets[0]!, request_count: 99 }], deps),
    /not acknowledged/,
  );
  assert.deepEqual(f.totals(), expected);
});

test("expired invocations cannot apply after their receipts have been pruned", async () => {
  const f = fixture();
  const deps = { batchId: "expired-batch", now: () => Date.now() - 3_600_000 };
  await assert.rejects(
    writeUsageRollupD1(f.store, buckets, deps),
    /not acknowledged/,
  );
  assert.deepEqual(f.totals(), []);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM api_usage_rollup_batches").get()?.n,
    0,
  );
});

test("receipt pruning is bounded and never removes historical counters or live receipts", async () => {
  const f = fixture();
  const insert = f.sql.prepare(
    "INSERT INTO api_usage_rollup_batches VALUES(?,?,?,1)",
  );
  for (let index = 0; index < 205; index++)
    insert.run("old-" + index, "a".repeat(64), Date.now() - 1000);
  insert.run("live", "b".repeat(64), Date.now() + 600_000);
  await writeUsageRollupD1(f.store, buckets);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM api_usage_rollup_batches").get()?.n,
    7,
  );
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM api_usage_rollup_batches WHERE batch_id='live'",
      )
      .get()?.n,
    1,
  );
  assert.deepEqual(f.totals(), expected);
});
