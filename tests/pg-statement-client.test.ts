// The prepare/bind/batch Postgres client (src/pg-statement-client.ts, #10104).
//
// The property this file exists for is ATOMICITY. Several producer lanes write
// their rows and their prune in ONE d1.batch(), and a partial application
// leaves the table pruned but not refilled -- a shape that reads as data loss
// rather than as a failed tick. An adapter that ran the statements one at a
// time would satisfy every other assertion here and lose exactly that.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createPgStatementClient,
  storeBoolean,
  type PgStatementClient,
} from "../src/pg-statement-client.ts";

function fakeClient(opts: { failOn?: RegExp; rows?: unknown[] } = {}) {
  const log: { text: string; values: unknown[] }[] = [];
  let connects = 0;
  let ends = 0;
  const client: PgStatementClient = {
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
  createPgStatementClient("postgresql://example/db", {
    clientFactory: () => f.client,
  });

describe("the D1 object API", () => {
  test("prepare().bind().all() returns rows in D1's envelope", async () => {
    const f = fakeClient({ rows: [{ n: 1 }, { n: 2 }] });
    const db = make(f);
    const out = await db.prepare("SELECT n FROM t WHERE a = ?").bind(7).all();
    assert.deepEqual(out, { results: [{ n: 1 }, { n: 2 }] });
    // `?` became `$1` -- the same conversion createPgSql applies, reused so the
    // two paths cannot disagree about parameter order.
    assert.deepEqual(f.log, [
      { text: "SELECT n FROM t WHERE a = $1", values: [7] },
    ]);
  });

  test("prepare().run() reports rowCount as D1's changes", async () => {
    const f = fakeClient({ rows: [{}, {}] });
    const out = await make(f).prepare("DELETE FROM t").run();
    assert.equal((out as { meta: { changes: number } }).meta.changes, 2);
  });

  test("one connection is opened, however many statements run", async () => {
    const f = fakeClient();
    const db = make(f);
    await db.prepare("SELECT 1").all();
    await db.prepare("SELECT 2").all();
    assert.equal(f.counts().connects, 1);
  });

  test("close() ends the connection, and is safe when nothing opened one", async () => {
    const f = fakeClient();
    const db = make(f);
    await db.close();
    assert.equal(f.counts().ends, 0, "nothing was opened, nothing to end");
    await db.prepare("SELECT 1").all();
    await db.close();
    assert.equal(f.counts().ends, 1);
  });
});

describe("bind() is immutable, the way D1's is", () => {
  // The regression this file gained after production lost 34 hours of
  // subnet_burn_history. `prepare` once + `bind` per row inside one batch is
  // the documented idiom -- and when bind() mutated a shared statement, every
  // element of that array was the same object carrying the LAST row's values.
  // The batch then ran N identical statements, ON CONFLICT DO UPDATE folded
  // them into one row, and the lane reported `captured 129` throughout.
  test("prepare once, bind per row -- each statement keeps its OWN values", async () => {
    const f = fakeClient();
    const db = make(f);
    const insert = db.prepare("INSERT INTO t (netuid, v) VALUES (?, ?)");
    const rows = [
      { netuid: 1, v: "a" },
      { netuid: 2, v: "b" },
      { netuid: 3, v: "c" },
    ];

    await db.batch(rows.map((r) => insert.bind(r.netuid, r.v)));

    // Three statements, three DIFFERENT parameter sets -- not three copies of
    // the last one. Asserting the values, not the count: a mutating bind()
    // still produces three statements, and only the values expose it.
    const writes = f.log.filter((l) => /INSERT INTO t/.test(l.text));
    assert.deepEqual(
      writes.map((w) => w.values),
      [
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ],
    );
  });

  test("binding does not disturb the statement it was bound from", async () => {
    const f = fakeClient();
    const db = make(f);
    const base = db.prepare("SELECT * FROM t WHERE a = ?");
    const first = base.bind(1);
    const second = base.bind(2);
    await first.all();
    await second.all();
    assert.deepEqual(
      f.log.map((l) => l.values),
      [[1], [2]],
    );
  });

  test("re-binding an already-bound statement is independent too", async () => {
    // The chainable case: `stmt.bind(a).bind(b)` must not leave `bind(a)`
    // carrying b, or a caller reusing an intermediate gets the wrong row.
    const f = fakeClient();
    const db = make(f);
    const bound = db.prepare("SELECT * FROM t WHERE a = ?").bind(1);
    const rebound = bound.bind(2);
    await bound.all();
    await rebound.all();
    assert.deepEqual(
      f.log.map((l) => l.values),
      [[1], [2]],
    );
  });
});

describe("batch() is a real transaction", () => {
  test("BEGIN wraps every statement and COMMIT closes it", async () => {
    const f = fakeClient();
    const db = make(f);
    await db.batch([
      db.prepare("INSERT INTO t VALUES (?)").bind(1),
      db.prepare("DELETE FROM t WHERE a < ?").bind(5),
    ]);
    assert.deepEqual(f.texts(), [
      "BEGIN",
      "INSERT INTO t VALUES ($1)",
      "DELETE FROM t WHERE a < $1",
      "COMMIT",
    ]);
  });

  test("a failing statement ROLLS BACK and never COMMITs", async () => {
    // The assertion the whole adapter exists for. subnet-burn-history writes
    // its rows and its prune in one batch; applying the prune without the rows
    // is not a failed tick, it is data loss.
    const f = fakeClient({ failOn: /DELETE/ });
    const db = make(f);
    await assert.rejects(
      db.batch([
        db.prepare("INSERT INTO t VALUES (?)").bind(1),
        db.prepare("DELETE FROM t").bind(),
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
    const db = make(f);
    await assert.rejects(
      db.batch([db.prepare("DELETE FROM t").bind()]),
      /boom/,
    );
  });

  test("statements do not execute before the transaction opens", async () => {
    // If bind() ran the statement eagerly, the writes would land OUTSIDE the
    // transaction and a rollback would undo nothing.
    const f = fakeClient();
    const db = make(f);
    const stmt = db.prepare("INSERT INTO t VALUES (?)").bind(1);
    assert.deepEqual(f.texts(), [], "bind() must not execute");
    await db.batch([stmt]);
    assert.equal(f.texts()[0], "BEGIN");
  });

  test("a foreign statement is rejected rather than silently skipped", async () => {
    const db = make(fakeClient());
    await assert.rejects(
      db.batch([{ not: "a statement" }]),
      /foreign statement/,
    );
  });

  test("every statement's own values survive the batch", async () => {
    // One shared pending object per prepare() would make the last bind() win
    // and every row in the batch identical -- silent, and wrong.
    const f = fakeClient();
    const db = make(f);
    await db.batch([
      db.prepare("INSERT INTO t VALUES (?)").bind("a"),
      db.prepare("INSERT INTO t VALUES (?)").bind("b"),
    ]);
    assert.deepEqual(
      f.log.filter((l) => l.text.startsWith("INSERT")).map((l) => l.values),
      [["a"], ["b"]],
    );
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
