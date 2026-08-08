// Which store answers an observation read (src/observations-read-runner.ts).
//
// The property that matters is that the selector cannot move reads onto Neon
// while the family is still on D1, and cannot leave them on D1 once it is not.
// Getting that backwards is silent in both directions: a read against the
// wrong store returns rows, just not the current ones.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  observationsReadDb,
  pgObservationsReadDb,
} from "../src/observations-read-runner.ts";
import { d1All } from "../src/analytics-live.ts";
import { OBSERVATION_TABLES } from "../src/observations-neon.ts";

const D1 = { prepare: () => ({ bind: () => ({ all: async () => [] }) }) };
const HYPERDRIVE = { connectionString: "postgresql://example/db" };
const ctx = { waitUntil() {} };

/** Every observation table named as Neon's, which is what the family gate
 * requires -- built FROM the exported list so a table added there cannot leave
 * this suite testing a smaller family than production runs. */
const ALL_OWNED = [...OBSERVATION_TABLES].join(",");

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
    const rows = await d1All(db, "SELECT ? AS n FROM surface_checks", [7]);
    assert.deepEqual(seen, [
      { text: "SELECT ? AS n FROM surface_checks", values: [7] },
    ]);
    assert.deepEqual(rows, [{ n: 1 }]);
  });

  test("a bare array is read as rows, the shape Postgres returns", async () => {
    const db = pgObservationsReadDb({
      unsafe: async () => [{ a: 1 }, { a: 2 }],
    });
    assert.equal((await d1All(db, "SELECT 1", [])).length, 2);
  });

  test("a rejected read degrades to zero rows rather than throwing", async () => {
    // d1All's contract, which the adapter must not break: these are serving
    // paths and a failed read is a schema-stable empty payload, not a 500.
    const db = pgObservationsReadDb({
      unsafe: async () => {
        throw new Error("relation missing");
      },
    });
    assert.deepEqual(await d1All(db, "SELECT 1", []), []);
  });
});

describe("observationsReadDb", () => {
  test("stays on D1 while the family is not Neon's", () => {
    for (const env of [
      { METAGRAPH_HEALTH_DB: D1 },
      { METAGRAPH_HEALTH_DB: D1, HYPERDRIVE },
      { METAGRAPH_HEALTH_DB: D1, HYPERDRIVE, NEON_SOLE_STORE_TABLES: "" },
    ]) {
      assert.equal(observationsReadDb(env, ctx), D1);
    }
  });

  test("a PARTIAL family stays on D1, every table short of the whole", () => {
    // Two of the writes are INSERT ... SELECT FROM surface_checks -- they
    // aggregate inside the store. A split family would have a rollup reading
    // one store while its source rows live in the other.
    for (const table of OBSERVATION_TABLES) {
      const partial = OBSERVATION_TABLES.filter((t) => t !== table).join(",");
      assert.equal(
        observationsReadDb(
          {
            METAGRAPH_HEALTH_DB: D1,
            HYPERDRIVE,
            NEON_SOLE_STORE_TABLES: partial,
          },
          ctx,
        ),
        D1,
        `${table} missing should have kept the whole family on D1`,
      );
    }
  });

  test("moves to Neon once it owns the WHOLE family", () => {
    const db = observationsReadDb(
      {
        METAGRAPH_HEALTH_DB: D1,
        HYPERDRIVE,
        NEON_SOLE_STORE_TABLES: ALL_OWNED,
      },
      ctx,
      { sql: { unsafe: async () => [] } },
    );
    assert.notEqual(db, D1, "expected the Neon-backed adapter");
    assert.ok(db?.prepare);
  });

  test("no ctx keeps it on D1, so no connection can leak", () => {
    // createPgSql returns its connection via waitUntil; with nowhere to park
    // the teardown it would leak one per call.
    assert.equal(
      observationsReadDb(
        {
          METAGRAPH_HEALTH_DB: D1,
          HYPERDRIVE,
          NEON_SOLE_STORE_TABLES: ALL_OWNED,
        },
        null,
      ),
      D1,
    );
  });

  test("a ctx with NO waitUntil keeps it on D1", () => {
    // Every serving handler defaults `ctx: EdgeCacheCtx = {}`, and EdgeCacheCtx
    // declares waitUntil OPTIONAL. A truthiness check would take `{}` for a
    // usable ctx and hand createPgSql nowhere to return the connection --
    // leaking one per request on a serving path, which is worse than the stale
    // read this whole selector exists to avoid.
    for (const bad of [{}, { waitUntil: undefined }]) {
      assert.equal(
        observationsReadDb(
          {
            METAGRAPH_HEALTH_DB: D1,
            HYPERDRIVE,
            NEON_SOLE_STORE_TABLES: ALL_OWNED,
          },
          bad as { waitUntil?: (p: Promise<unknown>) => void },
        ),
        D1,
      );
    }
  });

  test("no Hyperdrive keeps it on D1 even with every table named", () => {
    assert.equal(
      observationsReadDb(
        { METAGRAPH_HEALTH_DB: D1, NEON_SOLE_STORE_TABLES: ALL_OWNED },
        ctx,
      ),
      D1,
    );
  });

  test("an absent D1 binding is passed through, not faked", () => {
    // d1All already reads undefined as zero rows. Substituting an empty stub
    // here would turn "no store" into "a store that answered nothing", which
    // is the distinction #9754 was about.
    assert.equal(observationsReadDb({}, ctx), undefined);
    assert.equal(observationsReadDb(null, ctx), undefined);
  });
});
