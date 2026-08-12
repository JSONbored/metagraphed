// The producer store, EXECUTED (src/producer-store.ts, #10309; lineage
// #10328).
//
// tests/producer-store.test.ts drives the store through a fake client that
// logs `{text, values}` and returns canned rows. That is the right shape for
// asserting WHICH statement the store emits. It cannot reach the part that
// actually cost us data in #10304: the damage was not that N statements
// carried identical parameters; it was that `ON CONFLICT (netuid,
// observed_at) DO UPDATE` then FOLDED those N statements into ONE ROW, so a
// tick that read 129 subnets stored 1. A fake that never executes cannot fold
// anything.
//
// The owned store makes the #10304 aliasing bug unwritable -- statements are
// plain `{ text, values }` data with nothing shared to mutate -- but the
// row-level consequences are still the contract, and only a real engine can
// settle them:
//
//   1. N statements land N rows, judged by rows landed rather than by
//      parameters recorded.
//   2. `changes` is the driver's rowCount. Absent from the predecessor before
//      #10305, which is why the burn lane could only ever report what it
//      INTENDED to write.
//   3. `transaction()` is BEGIN/COMMIT with ROLLBACK on failure, and the
//      session stays usable afterwards.
//
// pglite is real Postgres in-process, and `createProducerStore` takes a
// `clientFactory`, so this needs no change to src/.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, test } from "vitest";
import {
  createProducerStore,
  type ProducerStoreClient,
} from "../src/producer-store.ts";

let pg: PGlite;

/** pglite presented as the driver this module expects. `rowCount` is what
 * becomes `changes`, so mapping it from `affectedRows` is the whole contract
 * being tested in (2). */
const client = (): ProducerStoreClient => ({
  connect: async () => {},
  end: async () => {},
  query: async (text: string, values: unknown[] = []) => {
    const res = await pg.query(text, values as never[]);
    return { rows: res.rows as unknown[], rowCount: res.affectedRows ?? 0 };
  },
});

const make = () =>
  createProducerStore("postgresql://example/db", {
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
const insertAll = (n: number) =>
  rows(n).map((r) => ({
    text: INSERT,
    values: [r.netuid, OBSERVED, r.burn_tao],
  }));

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

describe("N statements land N rows", () => {
  test("one statement per row, one row per subnet -- all 129 land", async () => {
    // THE #10304 REGRESSION, as the table saw it: the D1-shaped predecessor's
    // shared bind() made a 129-statement batch carry the last row's values 129
    // times, and ON CONFLICT folded them into a single row. Statements as
    // plain data cannot alias; this pins the consequence anyway, from the
    // rows.
    const db = make();
    await db.transaction(insertAll(129));
    const out = await stored();
    assert.equal(out.length, 129, "one row per subnet, not one row per batch");
    assert.deepEqual(out[0], { netuid: 0, burn_tao: 1 });
    assert.deepEqual(out[128], { netuid: 128, burn_tao: 129 });
    await db.close();
  });

  test("a replayed tick updates in place rather than erroring", async () => {
    // Idempotence is the requirement ON CONFLICT is there for; that it also
    // folds N identical statements is the #10304 trap, not a bug in itself.
    const db = make();
    await db.transaction(insertAll(3));
    await db.transaction(
      rows(3).map((r) => ({ text: INSERT, values: [r.netuid, OBSERVED, 99] })),
    );
    const out = await stored();
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((r) => r.burn_tao),
      [99, 99, 99],
    );
    await db.close();
  });
});

describe("changes counts what LANDED", () => {
  test("a transaction reports one change per statement", async () => {
    // Absent entirely from the predecessor before #10305, which is why the
    // lane could only report what it INTENDED to write. A write path that
    // cannot count its own effect cannot be watched.
    const db = make();
    const out = await db.transaction(insertAll(4));
    assert.deepEqual(
      out.map((r) => r.changes),
      [1, 1, 1, 1],
    );
    await db.close();
  });

  test("run() reports the rows a DELETE actually removed", async () => {
    // The prune half. Reporting the intended count here would make a sweep
    // that matched nothing indistinguishable from one that cleared the table.
    const db = make();
    await db.transaction(insertAll(5));
    const swept = await db.run("DELETE FROM burn WHERE observed_at < ?", [
      OBSERVED + 1,
    ]);
    assert.equal(swept.changes, 5);
    const none = await db.run("DELETE FROM burn WHERE observed_at < ?", [0]);
    assert.equal(none.changes, 0, "a sweep that matched nothing says so");
    await db.close();
  });
});

describe("transaction() is a real transaction", () => {
  test("a failing statement rolls the whole set back", async () => {
    // src/subnet-burn-history.ts writes its rows and its prune in ONE
    // transaction. A partial application leaves the table pruned but not
    // refilled, which is strictly worse than the tick not running.
    const db = make();
    await assert.rejects(() =>
      db.transaction([
        { text: INSERT, values: [1, OBSERVED, 1] },
        { text: INSERT, values: [2, OBSERVED, 2] },
        { text: "INSERT INTO burn (netuid) VALUES (?)", values: [3] },
      ]),
    );
    assert.deepEqual(await stored(), [], "nothing from the set survived");
    await db.close();
  });

  test("the connection stays usable after a rollback", async () => {
    // A ROLLBACK that leaves the session wedged would turn one bad tick into
    // a dead lane, so the recovery path matters as much as the rollback.
    const db = make();
    await assert.rejects(() =>
      db.transaction([
        { text: "INSERT INTO burn (netuid) VALUES (?)", values: [1] },
      ]),
    );
    await db.run(INSERT, [7, OBSERVED, 7]);
    assert.deepEqual(await stored(), [{ netuid: 7, burn_tao: 7 }]);
    await db.close();
  });

  test("a committed transaction is visible to a later read on the same handle", async () => {
    const db = make();
    await db.transaction([{ text: INSERT, values: [1, OBSERVED, 1] }]);
    const read = await db.first<{ burn_tao: number }>(
      "SELECT burn_tao FROM burn WHERE netuid = ?",
      [1],
    );
    assert.equal(read?.burn_tao, 1);
    await db.close();
  });
});

describe("the `?` placeholders reach Postgres as $n", () => {
  test("a multi-parameter statement binds in the order given", async () => {
    // The rewrite is toPositionalPlaceholders', shared with createPgSql so the
    // two paths cannot disagree about parameter order -- and an off-by-one
    // here would silently swap netuid and burn_tao, both numbers.
    const db = make();
    await db.run(INSERT, [42, OBSERVED, 3.5]);
    assert.deepEqual(await stored(), [{ netuid: 42, burn_tao: 3.5 }]);
    await db.close();
  });
});
