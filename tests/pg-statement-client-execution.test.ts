// The D1-shaped Postgres shim, EXECUTED (#10328 follow-on).
//
// tests/pg-statement-client.test.ts drives this module through a fake client
// that logs `{text, values}` and returns canned rows. That is the right shape
// for asserting WHICH statement the shim emits, and it is how the #10304 bind
// bug was pinned -- by reading the values array.
//
// It cannot reach the part that actually cost us data. The damage was not that
// N statements carried identical parameters; it was that `ON CONFLICT (netuid,
// observed_at) DO UPDATE` then FOLDED those N statements into ONE ROW, so a
// tick that read 129 subnets stored 1. A fake that never executes cannot fold
// anything, so the consequence -- 126 of 129 netuids frozen for 34 hours while
// every lane card stayed green -- was outside what any test could observe.
//
// Three properties only a real engine can settle, all of them load-bearing:
//
//   1. BIND IMMUTABILITY, judged by rows landed rather than by parameters
//      recorded.
//   2. `meta.changes`, which is `rowCount` from the driver. The shim did not
//      return it at all before #10305, and its absence is why the lane could
//      only ever report what it INTENDED to write.
//   3. `batch()` as a real transaction -- BEGIN/COMMIT with ROLLBACK on
//      failure. src/subnet-burn-history.ts writes its rows and its prune in
//      one batch, and a partial application there leaves the table pruned but
//      not refilled.
//
// pglite is real Postgres in-process, and `createPgStatementClient` already
// takes a `clientFactory`, so this needs no change to src/.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, test } from "vitest";
import {
  createPgStatementClient,
  type PgStatementClient,
} from "../src/pg-statement-client.ts";

let pg: PGlite;

/** pglite presented as the driver this module expects. `rowCount` is what
 * becomes `meta.changes`, so mapping it from `affectedRows` is the whole
 * contract being tested in (2). */
const client = (): PgStatementClient => ({
  connect: async () => {},
  end: async () => {},
  query: async (text: string, values: unknown[] = []) => {
    const res = await pg.query(text, values as never[]);
    return { rows: res.rows as unknown[], rowCount: res.affectedRows ?? 0 };
  },
});

const make = () =>
  createPgStatementClient("postgresql://example/db", {
    clientFactory: () => client(),
  });

/** The shape src/subnet-burn-history.ts writes: one row per subnet per tick,
 * keyed so a replay at the same stamp updates rather than erroring. */
const CREATE = `CREATE TABLE IF NOT EXISTS burn (
  netuid INTEGER NOT NULL,
  observed_at BIGINT NOT NULL,
  burn_tao DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (netuid, observed_at)
)`;
const INSERT =
  "INSERT INTO burn (netuid, observed_at, burn_tao) VALUES (?, ?, ?)" +
  " ON CONFLICT (netuid, observed_at) DO UPDATE SET burn_tao = EXCLUDED.burn_tao";

const OBSERVED = 1_786_000_000_000;
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ netuid: i, burn_tao: 1 + i }));

const stored = async () =>
  (
    await pg.query<{ netuid: number; burn_tao: number }>(
      "SELECT netuid, burn_tao FROM burn ORDER BY netuid",
    )
  ).rows;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(CREATE);
});

beforeEach(async () => {
  await pg.exec("TRUNCATE burn");
});

describe("bind() immutability, measured in rows landed", () => {
  test("prepare once, bind per row, batch -- every row lands", async () => {
    // THE REGRESSION, as the table saw it. An earlier shim mutated one shared
    // statement and returned one shared object, so `rows.map((r) =>
    // insert.bind(...))` was N references to the LAST row's values; ON CONFLICT
    // folded them into a single row. Production stored 1 of 129 per tick for 34
    // hours while reporting `captured 129`.
    const db = make();
    const insert = db.prepare(INSERT);
    await db.batch(
      rows(129).map((r) => insert.bind(r.netuid, OBSERVED, r.burn_tao)),
    );
    const out = await stored();
    assert.equal(out.length, 129, "one row per subnet, not one row per batch");
    assert.deepEqual(out[0], { netuid: 0, burn_tao: 1 });
    assert.deepEqual(out[128], { netuid: 128, burn_tao: 129 });
    await db.close();
  });

  test("re-binding an already-bound statement does not disturb the first", async () => {
    // `bind()` is chainable, so a caller may bind a bound statement. Both must
    // be independent, which is only observable once both have executed.
    const db = make();
    const first = db.prepare(INSERT).bind(1, OBSERVED, 10);
    const second = first.bind(2, OBSERVED, 20);
    await db.batch([first, second]);
    assert.deepEqual(await stored(), [
      { netuid: 1, burn_tao: 10 },
      { netuid: 2, burn_tao: 20 },
    ]);
    await db.close();
  });

  test("a replayed tick updates in place rather than erroring", async () => {
    // Idempotence is the requirement ON CONFLICT is there for; that it also
    // folds N identical statements is the trap above, not a bug in itself.
    const db = make();
    const insert = db.prepare(INSERT);
    await db.batch(
      rows(3).map((r) => insert.bind(r.netuid, OBSERVED, r.burn_tao)),
    );
    await db.batch(rows(3).map((r) => insert.bind(r.netuid, OBSERVED, 99)));
    const out = await stored();
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((r) => r.burn_tao),
      [99, 99, 99],
    );
    await db.close();
  });
});

describe("meta.changes counts what LANDED", () => {
  test("a batch reports one change per statement", async () => {
    // Absent entirely before #10305, which is why the lane could only report
    // what it INTENDED to write. A write path that cannot count its own effect
    // cannot be watched.
    const db = make();
    const insert = db.prepare(INSERT);
    const out = (await db.batch(
      rows(4).map((r) => insert.bind(r.netuid, OBSERVED, r.burn_tao)),
    )) as { meta?: { changes?: number } }[];
    assert.deepEqual(
      out.map((r) => r.meta?.changes),
      [1, 1, 1, 1],
    );
    await db.close();
  });

  test("run() reports the rows a DELETE actually removed", async () => {
    // The prune half. Reporting the intended count here would make a sweep that
    // matched nothing indistinguishable from one that cleared the table.
    const db = make();
    const insert = db.prepare(INSERT);
    await db.batch(
      rows(5).map((r) => insert.bind(r.netuid, OBSERVED, r.burn_tao)),
    );
    const swept = (await db
      .prepare("DELETE FROM burn WHERE observed_at < ?")
      .bind(OBSERVED + 1)
      .run()) as { meta: { changes: number } };
    assert.equal(swept.meta.changes, 5);
    const none = (await db
      .prepare("DELETE FROM burn WHERE observed_at < ?")
      .bind(0)
      .run()) as { meta: { changes: number } };
    assert.equal(none.meta.changes, 0, "a sweep that matched nothing says so");
    await db.close();
  });
});

describe("batch() is a real transaction", () => {
  test("a failing statement rolls the whole batch back", async () => {
    // src/subnet-burn-history.ts writes its rows and its prune in ONE batch. A
    // partial application leaves the table pruned but not refilled, which is
    // strictly worse than the tick not running.
    const db = make();
    const insert = db.prepare(INSERT);
    await assert.rejects(() =>
      db.batch([
        insert.bind(1, OBSERVED, 1),
        insert.bind(2, OBSERVED, 2),
        db.prepare("INSERT INTO burn (netuid) VALUES (?)").bind(3),
      ]),
    );
    assert.deepEqual(await stored(), [], "nothing from the batch survived");
    await db.close();
  });

  test("the connection stays usable after a rollback", async () => {
    // A ROLLBACK that leaves the session wedged would turn one bad tick into a
    // dead lane, so the recovery path matters as much as the rollback.
    const db = make();
    await assert.rejects(() =>
      db.batch([db.prepare("INSERT INTO burn (netuid) VALUES (?)").bind(1)]),
    );
    await db.prepare(INSERT).bind(7, OBSERVED, 7).run();
    assert.deepEqual(await stored(), [{ netuid: 7, burn_tao: 7 }]);
    await db.close();
  });

  test("a committed batch is visible to a later read on the same handle", async () => {
    const db = make();
    await db.batch([db.prepare(INSERT).bind(1, OBSERVED, 1)]);
    const read = (await db
      .prepare("SELECT burn_tao FROM burn WHERE netuid = ?")
      .bind(1)
      .first()) as { burn_tao: number } | null;
    assert.equal(read?.burn_tao, 1);
    await db.close();
  });
});

describe("the `?` placeholders reach Postgres as $n", () => {
  test("a multi-parameter statement binds in the order given", async () => {
    // The rewrite is toPositionalPlaceholders', shared with createPgSql so the
    // two paths cannot disagree about parameter order -- and an off-by-one here
    // would silently swap netuid and burn_tao, both numbers.
    const db = make();
    await db.prepare(INSERT).bind(42, OBSERVED, 3.5).run();
    assert.deepEqual(await stored(), [{ netuid: 42, burn_tao: 3.5 }]);
    await db.close();
  });
});
