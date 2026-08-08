// The D1-shaped Postgres adapter (src/pg-d1-adapter.ts, #10104).
//
// The property this file exists for is ATOMICITY. Several producer lanes write
// their rows and their prune in ONE d1.batch(), and a partial application
// leaves the table pruned but not refilled -- a shape that reads as data loss
// rather than as a failed tick. An adapter that ran the statements one at a
// time would satisfy every other assertion here and lose exactly that.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createPgD1, type PgD1Client } from "../src/pg-d1-adapter.ts";

function fakeClient(opts: { failOn?: RegExp; rows?: unknown[] } = {}) {
  const log: { text: string; values: unknown[] }[] = [];
  let connects = 0;
  let ends = 0;
  const client: PgD1Client = {
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
  createPgD1("postgresql://example/db", { clientFactory: () => f.client });

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
