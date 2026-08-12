// Which store answers an observation read (src/observations-read-runner.ts).
//
// The property that matters is that the selector cannot hand back a store for
// a family Neon has not been DECLARED to own -- not partly, not without the
// binding to reach it, and not without somewhere to release the connection.
// Getting that wrong is silent: a read against a store that does not hold the
// rows returns an empty set, which every caller renders as "no data" rather
// than as an error.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  observationsReadDb,
  pgObservationsReadDb,
} from "../src/observations-read-runner.ts";
import { storeAll } from "../src/analytics-live.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };
const ctx = { waitUntil() {} };

describe("pgObservationsReadDb", () => {
  test("passes the statement through verbatim, with its params", async () => {
    // Verbatim is the point: createPgSql rewrites ? -> $n, so the two stores
    // are asked the SAME question and a difference cannot come from the text.
    const seen: { text: string; values: unknown[] }[] = [];
    const db = pgObservationsReadDb({
      unsafe: async (text: string, values: unknown[] = []) => {
        seen.push({ text, values });
        return [{ n: 1 }];
      },
    });
    const rows = await storeAll(db, "SELECT ? AS n FROM surface_checks", [7]);
    assert.deepEqual(seen, [
      { text: "SELECT ? AS n FROM surface_checks", values: [7] },
    ]);
    assert.deepEqual(rows, [{ n: 1 }]);
  });

  test("a bare array is read as rows, the shape Postgres returns", async () => {
    const db = pgObservationsReadDb({
      unsafe: async () => [{ a: 1 }, { a: 2 }],
    });
    assert.equal((await storeAll(db, "SELECT 1", [])).length, 2);
  });

  test("prepare().all() works WITHOUT a bind, the shape D1 also offers", async () => {
    // src/top-holders-holdings.ts calls `db.prepare(sql).all?.()` -- its
    // statement carries no parameters, so it never binds. An adapter offering
    // only the bind path would make `.all` undefined there; the `?.` would
    // swallow it into `undefined` rows and the route would serve an empty
    // holdings list rather than fail loudly.
    const seen: unknown[][] = [];
    const db = pgObservationsReadDb({
      unsafe: async (_text: string, values: unknown[] = []) => {
        seen.push(values);
        return [{ netuid: 1 }];
      },
    });
    // Rows, directly. The predecessor's divergence -- one adapter answering a
    // bare array where the other answered { results }, silently flipping a
    // successful read into a failure branch -- is unrepresentable now that
    // there is one verb and one shape (#10909).
    assert.deepEqual(await db.query("SELECT netuid FROM subnet_snapshots"), [
      { netuid: 1 },
    ]);
    assert.deepEqual(seen, [[]]);
  });

  test("the rows come back in order, so a caller can take the first", async () => {
    // The other half of the retired divergence (#10909): this adapter had no
    // `first()` where its twin did, so a caller that used one got "not a
    // function" -- swallowed by the try/catch these readers wrap their query
    // in and reported as a decline rather than as a broken read. With one verb
    // there is no second shape to be missing; a caller takes rows[0] itself,
    // and an empty read is an empty array rather than a shape question.
    const db = pgObservationsReadDb({
      unsafe: async () => [{ captured_at: 7 }, { captured_at: 6 }],
    });
    const rows = await db.query("SELECT 1", [1]);
    assert.deepEqual(rows[0], { captured_at: 7 });

    const empty = pgObservationsReadDb({ unsafe: async () => [] });
    assert.deepEqual(await empty.query("SELECT 1"), []);
  });

  test("a rejected read degrades to zero rows rather than throwing", async () => {
    // storeAll's contract, which the adapter must not break: these are serving
    // paths and a failed read is a schema-stable empty payload, not a 500.
    const db = pgObservationsReadDb({
      unsafe: async () => {
        throw new Error("relation missing");
      },
    });
    assert.deepEqual(await storeAll(db, "SELECT 1", []), []);
  });
});

describe("observationsReadDb", () => {
  // WHAT THESE NOW GUARD. D1 is gone, so "the other store" is `undefined` --
  // and that is the stronger contract, not the weaker one: an undeclared table
  // must produce NO store rather than a second one, because the read helpers
  // treat undefined as zero rows and every caller declines on it. The
  // distinction each case protects is unchanged; only the negative value is.
  // "refuses while the family is not declared Neon's" retired with NEON_SOLE_STORE_TABLES (#10051): Neon is the only
  // store, so the undeclared/partial state cannot exist; the binding pins
  // survive in this suite.

  // "a PARTIAL family refuses, every table short of the whole" retired with NEON_SOLE_STORE_TABLES (#10051): Neon is the only
  // store, so the undeclared/partial state cannot exist; the binding pins
  // survive in this suite.

  test("moves to Neon once it owns the WHOLE family", () => {
    const db = observationsReadDb({ HYPERDRIVE }, ctx, {
      sql: { unsafe: async () => [] },
    });
    assert.ok(db?.query, "expected the Neon-backed adapter");
  });

  test("no ctx refuses, so no connection can leak", () => {
    // createPgSql returns its connection via waitUntil; with nowhere to park
    // the teardown it would leak one per call. Declining to read is the cheaper
    // failure.
    assert.equal(observationsReadDb({ HYPERDRIVE }, null), undefined);
  });

  test("a ctx with NO waitUntil refuses too", () => {
    // Every serving handler defaults `ctx: EdgeCacheCtx = {}`, and EdgeCacheCtx
    // declares waitUntil OPTIONAL. A truthiness check would take `{}` for a
    // usable ctx and hand createPgSql nowhere to return the connection --
    // leaking one per request on a serving path, which is worse than the
    // decline this selector answers with instead.
    for (const bad of [{}, { waitUntil: undefined }]) {
      assert.equal(
        observationsReadDb(
          { HYPERDRIVE },
          bad as { waitUntil?: (p: Promise<unknown>) => void },
        ),
        undefined,
      );
    }
  });

  test("no Hyperdrive refuses even with every table named", () => {
    // Sole-store is a claim about the DATA, not about this isolate: the flag
    // can say Neon owns the table while the binding to reach it is missing.
    assert.equal(observationsReadDb({}, ctx), undefined);
  });

  test("an empty env is undefined, not an empty stub", () => {
    // The read helpers already treat undefined as zero rows. Substituting an
    // empty stub here would turn "no store" into "a store that answered
    // nothing", which is the distinction #9754 was about.
    assert.equal(observationsReadDb({}, ctx), undefined);
    assert.equal(observationsReadDb(null, ctx), undefined);
  });
});
