// The producer store's own contract (src/producer-store.ts, #10309).
//
// The property this file exists for is ATOMICITY. Several producer lanes write
// their rows and their prune in ONE transaction(), and a partial application
// leaves the table pruned but not refilled -- a shape that reads as data loss
// rather than as a failed tick. A store that ran the statements one at a time
// would satisfy every other assertion here and lose exactly that.
//
// WHERE THE bind() SUITE WENT. This file's predecessor
// (tests/pg-statement-client.test.ts) carried a "bind() is immutable, the way
// D1's is" describe, born from #10304: the D1-shaped adapter mutated a shared
// statement, every element of a batch carried the LAST row's values, and
// subnet_burn_history wrote one row per tick for 34 hours while reporting
// success. The owned store has NO statement objects -- a statement is plain
// `{ text, values }` data built fresh at the call site -- so the aliasing
// contract those tests policed is not implementable, let alone breakable.
// The per-statement values assertion inside the transaction suite below is
// what remains: the observable half of the same guarantee.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createProducerStore,
  storeBoolean,
  type ProducerStoreClient,
} from "../src/producer-store.ts";

function fakeClient(opts: { failOn?: RegExp; rows?: unknown[] } = {}) {
  const log: { text: string; values: unknown[] }[] = [];
  let connects = 0;
  let ends = 0;
  const client: ProducerStoreClient = {
    connect: async () => {
      connects += 1;
    },
    end: async () => {
      ends += 1;
    },
    query: async (text: string, values: unknown[] = []) => {
      log.push({ text, values });
      if (opts.failOn?.test(text)) throw new Error("boom");
      return { rows: opts.rows ?? [], rowCount: (opts.rows ?? []).length };
    },
  };
  return {
    client,
    log,
    texts: () => log.map((l) => l.text),
    counts: () => ({ connects, ends }),
  };
}

const make = (f: ReturnType<typeof fakeClient>) =>
  createProducerStore("postgresql://example/db", {
    clientFactory: () => f.client,
  });

describe("the owned surface", () => {
  test("query() returns rows directly -- no D1 envelope", async () => {
    const f = fakeClient({ rows: [{ n: 1 }, { n: 2 }] });
    const rows = await make(f).query("SELECT n FROM t WHERE a = ?", [7]);
    assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
    // `?` became `$1` -- the same conversion createPgSql applies, reused so
    // the two paths cannot disagree about parameter order.
    assert.deepEqual(f.log, [
      { text: "SELECT n FROM t WHERE a = $1", values: [7] },
    ]);
  });

  test("first() is the first row, or null on none", async () => {
    const f = fakeClient({ rows: [{ n: 1 }, { n: 2 }] });
    assert.deepEqual(await make(f).first("SELECT n FROM t"), { n: 1 });
    const empty = fakeClient({ rows: [] });
    assert.equal(await make(empty).first("SELECT n FROM t"), null);
  });

  test("run() reports how many rows the write touched", async () => {
    const f = fakeClient({ rows: [{}, {}] });
    const out = await make(f).run("DELETE FROM t");
    assert.equal(out.changes, 2);
  });

  test("one connection is opened, however many statements run", async () => {
    const f = fakeClient();
    const db = make(f);
    await db.query("SELECT 1");
    await db.query("SELECT 2");
    assert.equal(f.counts().connects, 1);
  });

  test("close() ends the connection, and is safe when nothing opened one", async () => {
    const f = fakeClient();
    const db = make(f);
    await db.close();
    assert.equal(f.counts().ends, 0, "nothing was opened, nothing to end");
    await db.query("SELECT 1");
    await db.close();
    assert.equal(f.counts().ends, 1);
  });
});

describe("transaction() is a real transaction", () => {
  test("BEGIN wraps every statement and COMMIT closes it", async () => {
    const f = fakeClient();
    await make(f).transaction([
      { text: "INSERT INTO t VALUES (?)", values: [1] },
      { text: "DELETE FROM t WHERE a < ?", values: [5] },
    ]);
    assert.deepEqual(f.texts(), [
      "BEGIN",
      "INSERT INTO t VALUES ($1)",
      "DELETE FROM t WHERE a < $1",
      "COMMIT",
    ]);
  });

  test("a failing statement ROLLS BACK and never COMMITs", async () => {
    // The assertion the whole store exists for. subnet-burn-history writes
    // its rows and its prune in one transaction; applying the prune without
    // the rows is not a failed tick, it is data loss.
    const f = fakeClient({ failOn: /DELETE/ });
    await assert.rejects(
      make(f).transaction([
        { text: "INSERT INTO t VALUES (?)", values: [1] },
        { text: "DELETE FROM t" },
      ]),
      /boom/,
    );
    assert.ok(f.texts().includes("ROLLBACK"));
    assert.ok(
      !f.texts().includes("COMMIT"),
      "COMMIT must not follow a failure",
    );
  });

  test("a ROLLBACK that itself fails does not mask the original error", async () => {
    // Otherwise the log names the symptom and loses the cause.
    const f = fakeClient({ failOn: /DELETE|ROLLBACK/ });
    await assert.rejects(
      make(f).transaction([{ text: "DELETE FROM t" }]),
      /boom/,
    );
  });

  test("every statement's own values survive the transaction", async () => {
    // The observable half of the #10304 guarantee: N statements, N parameter
    // sets -- never N copies of the last one. With statements as plain data
    // there is no shared object whose mutation could collapse them, and this
    // pins the visible behaviour all the same.
    const f = fakeClient();
    await make(f).transaction([
      { text: "INSERT INTO t VALUES (?)", values: ["a"] },
      { text: "INSERT INTO t VALUES (?)", values: ["b"] },
      { text: "INSERT INTO t VALUES (?)", values: ["c"] },
    ]);
    assert.deepEqual(
      f.log.filter((l) => l.text.startsWith("INSERT")).map((l) => l.values),
      [["a"], ["b"], ["c"]],
    );
  });

  test("per-statement changes come back in order", async () => {
    // The number #10304 proved a batching lane must see: a write path that
    // cannot count its own effect cannot be watched.
    const f = fakeClient({ rows: [{}] });
    const out = await make(f).transaction([
      { text: "INSERT INTO t VALUES (?)", values: [1] },
      { text: "INSERT INTO t VALUES (?)", values: [2] },
    ]);
    assert.deepEqual(out, [{ changes: 1 }, { changes: 1 }]);
  });

  test("an empty transaction still opens and commits cleanly", async () => {
    // Callers guard the empty case themselves (a no-change tick writes
    // nothing), but the store's own behaviour must not be a trap if one
    // reaches it.
    const f = fakeClient();
    assert.deepEqual(await make(f).transaction([]), []);
    assert.deepEqual(f.texts(), ["BEGIN", "COMMIT"]);
  });
});

describe("storeBoolean", () => {
  test("Postgres gets real booleans; SQLite gets 1/0", () => {
    // A `boolean` column rejects 1/0 with `operator does not exist: boolean =
    // integer`, and SQLite has no boolean type. The same row therefore needs a
    // different binding per store -- the mapping cannot be fixed at the schema.
    assert.equal(storeBoolean(true, true), true);
    assert.equal(storeBoolean(true, false), false);
    assert.equal(storeBoolean(false, true), 1);
    assert.equal(storeBoolean(false, false), 0);
  });

  test("NULL survives on BOTH stores", () => {
    // previous_enabled uses null for "no prior observation", which is not the
    // same as false: collapsing it would record every first sighting as a
    // transition from disabled.
    assert.equal(storeBoolean(true, null), null);
    assert.equal(storeBoolean(false, null), null);
    assert.equal(storeBoolean(true, undefined), null);
    assert.equal(storeBoolean(false, undefined), null);
  });

  test("never returns a number for Postgres, nor a boolean for SQLite", () => {
    // The property, stated over the whole domain rather than four literals --
    // a future edit that returns `Number(value)` unconditionally would satisfy
    // the SQLite half above and still break every Postgres write.
    for (const v of [true, false]) {
      assert.equal(typeof storeBoolean(true, v), "boolean");
      assert.equal(typeof storeBoolean(false, v), "number");
    }
  });
});
