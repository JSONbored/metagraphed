import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { Miniflare } from "miniflare";
import {
  createD1Store,
  selectedD1Store,
  partitionStoreTables,
} from "../src/d1-store.ts";
import { runTableFreshnessWatchdog } from "../src/table-freshness-watchdog.ts";
import { readStore } from "../src/read-store.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import {
  loadLaneMaxGap,
  loadLaneStaleRuns,
  loadLaneUnknownRuns,
  loadLaneFaultRates,
} from "../src/lane-alarm.ts";
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  LANE_HEALTH_RETENTION_MS,
} from "../src/lane-health.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  await db.exec(
    "CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL, enabled INTEGER, stamp INTEGER)",
  );
  for (const name of [
    "0001_lane_health.sql",
    "0002_lane_health_current.sql",
    "0003_lane_health_history_indexes.sql",
  ]) {
    const migration = readFileSync(
      new URL(`../migrations/d1/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("-- statement-breakpoint")) {
      await db.prepare(statement).run();
    }
    if (name === "0001_lane_health.sql") {
      await db
        .prepare(
          "INSERT INTO lane_health (lane, verdict, checked_at) VALUES ('bootstrap', 'ok', 1), ('bootstrap', 'stale', 1), ('bootstrap', 'future-verdict', 1)",
        )
        .run();
    }
  }
});
afterAll(async () => {
  await runtime.dispose();
});

describe("D1 implements the existing store contract", () => {
  test("preserves bound values, null, large integers and actual changed-row counts", async () => {
    const store = createD1Store(db);
    assert.deepEqual(
      await store.run("INSERT INTO rows VALUES (?, ?, ?, ?)", [
        1,
        "O'Reilly ? $1",
        true,
        1790000000000,
      ]),
      { changes: 1 },
    );
    assert.deepEqual(
      await store.first("SELECT * FROM rows WHERE id = ?", [1]),
      {
        id: 1,
        value: "O'Reilly ? $1",
        enabled: 1,
        stamp: 1790000000000,
      },
    );
    await store.run("INSERT INTO rows VALUES (?, ?, ?, ?)", [
      2,
      9007199254740993n,
      false,
      null,
    ]);
    assert.deepEqual(
      await store.first("SELECT * FROM rows WHERE id = ?", [2]),
      {
        id: 2,
        value: "9007199254740993",
        enabled: 0,
        stamp: null,
      },
    );
    assert.deepEqual(
      await store.run("UPDATE rows SET stamp = ? WHERE id = ?", [7, -1]),
      { changes: 0 },
    );
    assert.equal(await store.first("SELECT id FROM rows WHERE id = -1"), null);
    assert.deepEqual(
      await store.query("SELECT id FROM rows WHERE id = -1"),
      [],
    );
    await store.close();
  });

  test("binds blob bytes without changing their representation", async () => {
    assert.deepEqual(
      await createD1Store(db).first("SELECT hex(?) AS bytes", [
        new Uint8Array([0, 255]).buffer,
      ]),
      { bytes: "00FF" },
    );
  });

  test("each statement has independent values and a failed batch rolls back its entire prefix", async () => {
    const store = createD1Store(db);
    assert.deepEqual(
      await store.transaction([
        {
          text: "INSERT INTO rows (id, value) VALUES (?, ?)",
          values: [10, "a"],
        },
        {
          text: "INSERT INTO rows (id, value) VALUES (?, ?)",
          values: [11, "b"],
        },
      ]),
      [{ changes: 1 }, { changes: 1 }],
    );
    assert.deepEqual(
      await store.query(
        "SELECT id, value FROM rows WHERE id >= 10 ORDER BY id",
      ),
      [
        { id: 10, value: "a" },
        { id: 11, value: "b" },
      ],
    );
    await assert.rejects(
      store.transaction([
        {
          text: "INSERT INTO rows (id, value) VALUES (?, ?)",
          values: [12, "must roll back"],
        },
        {
          text: "INSERT INTO rows (id, value) VALUES (?, ?)",
          values: [10, "duplicate"],
        },
      ]),
      /UNIQUE constraint/,
    );
    assert.equal(await store.first("SELECT * FROM rows WHERE id = 12"), null);
    assert.deepEqual(await store.transaction([]), []);
    assert.deepEqual(
      await store.transaction([{ text: "DELETE FROM rows WHERE id = -1" }]),
      [{ changes: 0 }],
    );
  });

  test("invalid bindings reject before executing any part of a transaction", async () => {
    const store = createD1Store(db);
    for (const value of [undefined, {}, [], NaN, Infinity]) {
      await assert.rejects(
        store.transaction([
          { text: "INSERT INTO rows (id, value) VALUES (20, 'must not land')" },
          { text: "SELECT ?", values: [value] },
        ]),
        /Unsupported D1 bind/,
      );
    }
    await assert.rejects(
      store.query("SELECT ?", Array(101).fill(1)),
      /100 bindings/,
    );
    assert.equal(await store.first("SELECT * FROM rows WHERE id = 20"), null);
    await assert.rejects(
      store.query("SELECT * FROM no_such_table"),
      /no such table/,
    );
  });
});

describe("explicit table ownership", () => {
  test("the estate census partitions owners and reports an unbound destination as unreadable", async () => {
    assert.deepEqual(partitionStoreTables(null, ["rows"]), [["rows"]]);
    assert.deepEqual(partitionStoreTables("invalid", []), []);
    assert.deepEqual(partitionStoreTables({ D1_STATE_TABLES: 1 }, ["rows"]), [
      ["rows"],
    ]);
    assert.deepEqual(
      partitionStoreTables({ D1_STATE_TABLES: "rows" }, ["rows", "legacy"]),
      [["rows"], ["legacy"]],
    );
    const spec = {
      rows: {
        column: "stamp",
        kind: "ms" as const,
        maxAgeMs: 100,
        reason: "test",
      },
      legacy: {
        column: "stamp",
        kind: "ms" as const,
        maxAgeMs: 100,
        reason: "test",
      },
    };
    const writes: unknown[][] = [];
    const laneHealthDb = {
      query: async () => [],
      run: async (_text: string, values: unknown[] = []) => {
        writes.push(values);
        return { changes: 1 };
      },
    };
    const result = await runTableFreshnessWatchdog(
      { D1_STATE: db, D1_STATE_TABLES: "rows" },
      { spec, now: () => 1790000000010, laneHealthDb },
    );
    assert.equal(result.checked, 1);
    assert.equal(writes[0][1], "unknown");
    assert.match(String(writes[0][3]), /1 unreadable: legacy/);
    const unbound = await runTableFreshnessWatchdog(
      { D1_STATE_TABLES: "rows" },
      { spec: { rows: spec.rows } },
    );
    assert.equal(unbound.reason, "all batches failed");
  });
  test("the real watchdog writer, retention and reader agree over the migrated schema", async () => {
    const store = laneHealthStore({
      D1_STATE: db,
      D1_STATE_TABLES: "lane_health",
    });
    const now = 1790000000000;
    assert.equal(
      await recordLaneVerdict(store, {
        lane: "capture",
        verdict: "stale",
        checked_at: now - LANE_HEALTH_RETENTION_MS - 1,
        age_ms: null,
        detail: "old failure",
      }),
      true,
    );
    assert.equal(
      await recordLaneVerdict(store, {
        lane: "capture",
        verdict: "ok",
        checked_at: now,
        age_ms: 300,
        detail: "capture complete",
      }),
      true,
    );
    assert.deepEqual(
      await store?.query(
        "SELECT lane, verdict, checked_at FROM lane_health WHERE lane = 'capture'",
      ),
      [{ lane: "capture", verdict: "ok", checked_at: now }],
    );
    const latest = await loadLatestLaneHealth(store);
    assert.equal(latest.capture?.verdict, "ok");
    assert.equal(latest.capture?.detail, "capture complete");
    assert.equal(latest.capture?.checked_at, now);
  });
  test("current status preserves severity ties, repairs updates/deletes, and rolls back with history", async () => {
    const store = laneHealthStore({
      D1_STATE: db,
      D1_STATE_TABLES: "lane_health",
    });
    assert.equal(
      (await loadLatestLaneHealth(store)).bootstrap?.verdict,
      "stale",
    );
    const source = createD1Store(db);
    const insert =
      "INSERT INTO lane_health (lane, verdict, checked_at) VALUES (?, ?, ?)";
    for (const verdict of ["ok", "future-verdict", "stale", "ok"]) {
      await source.run(insert, ["ties", verdict, 100]);
    }
    assert.equal((await loadLatestLaneHealth(store)).ties?.verdict, "stale");
    await source.run(insert, ["ties", "ok", 101]);
    await source.run(insert, ["ties", "stale", 99]);
    assert.equal((await loadLatestLaneHealth(store)).ties?.verdict, "ok");
    await assert.rejects(
      source.transaction([
        { text: insert, values: ["ties", "stale", 102] },
        {
          text: "INSERT INTO lane_health (lane, verdict, checked_at) VALUES (NULL, 'ok', 103)",
        },
      ]),
      /NOT NULL/,
    );
    assert.equal((await loadLatestLaneHealth(store)).ties?.verdict, "ok");
    await source.run(
      "UPDATE lane_health SET lane = 'moved', checked_at = 102 WHERE lane = 'ties' AND checked_at = 101",
    );
    assert.equal((await loadLatestLaneHealth(store)).moved?.verdict, "ok");
    assert.equal((await loadLatestLaneHealth(store)).ties?.verdict, "stale");
    await source.run("DELETE FROM lane_health WHERE lane = 'moved'");
    assert.equal((await loadLatestLaneHealth(store)).moved, undefined);
    await source.run(
      "DELETE FROM lane_health WHERE lane = 'ties' AND verdict = 'stale'",
    );
    assert.equal((await loadLatestLaneHealth(store)).ties?.verdict, "unknown");
  });

  test("latest reads stay bounded when retained history grows", async () => {
    await db
      .prepare(
        "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v < 1000) INSERT INTO lane_health (lane, verdict, checked_at) SELECT 'bounded', 'ok', v FROM n",
      )
      .run();
    const result = await db
      .prepare(
        "SELECT lane, verdict, age_ms, detail, checked_at FROM lane_health_current",
      )
      .all();
    assert.ok(result.results.length < 10);
    assert.ok(
      result.meta.rows_read < 10,
      `read ${result.meta.rows_read} rows for current status`,
    );
    assert.equal(
      (
        await loadLatestLaneHealth(
          laneHealthStore({ D1_STATE: db, D1_STATE_TABLES: "lane_health" }),
        )
      ).bounded?.checked_at,
      1000,
    );
  });

  test("indexed alarm history matches retained-history queries across cutoffs, ties, late arrivals and repairs", async () => {
    const source = createD1Store(db);
    const indexed = laneHealthStore({
      D1_STATE: db,
      D1_STATE_TABLES: "lane_health",
    });
    const compare = async () => {
      assert.deepEqual(
        await loadLaneStaleRuns(indexed),
        await loadLaneStaleRuns(source),
      );
      assert.deepEqual(
        await loadLaneUnknownRuns(indexed),
        await loadLaneUnknownRuns(source),
      );
      for (const cutoff of [-1, 0, 1, 25, 30, 35, 40, 80, 99, 100, 999, 1000]) {
        assert.deepEqual(
          await loadLaneMaxGap(indexed, cutoff),
          await loadLaneMaxGap(source, cutoff),
          `cutoff ${cutoff}`,
        );
        assert.deepEqual(
          await loadLaneFaultRates(indexed, cutoff),
          await loadLaneFaultRates(source, cutoff),
        );
      }
    };
    await compare();
    for (const [clock, verdict] of [
      [30, "ok"],
      [80, "stale"],
      [30, "stale"],
      [40, "unknown"],
      [35, "ok"],
      [80, "unknown"],
      [100, "stale"],
    ]) {
      await source.run(
        "INSERT INTO lane_health (lane, verdict, checked_at) VALUES ('intervals', ?, ?)",
        [verdict, clock],
      );
      await compare();
    }
    await source.run(
      "UPDATE lane_health SET lane = 'repaired', checked_at = checked_at + 10, verdict = 'ok' WHERE lane = 'intervals' AND checked_at = 80",
    );
    await compare();
    await source.run(
      "DELETE FROM lane_health WHERE lane = 'intervals' AND checked_at = 30 AND verdict = 'ok'",
    );
    await compare();
    await source.run(
      "DELETE FROM lane_health WHERE lane = 'intervals' AND checked_at <= 40",
    );
    await compare();
    await source.run(
      "DELETE FROM lane_health WHERE lane IN ('intervals', 'repaired')",
    );
    await compare();
    let readRows = 0;
    const measured = {
      prepare(text: string) {
        const prepared = db.prepare(text);
        return {
          bind(...args: (string | number | null)[]) {
            return {
              async all() {
                const result = await prepared.bind(...args).all();
                readRows += result.meta.rows_read;
                return result;
              },
            };
          },
        };
      },
      batch: db.batch.bind(db),
    };
    await loadLaneMaxGap(
      laneHealthStore({ D1_STATE: measured, D1_STATE_TABLES: "lane_health" }),
      100,
    );
    assert.ok(
      readRows > 0 && readRows < 150,
      `indexed cadence read ${readRows} rows`,
    );
  });

  test("binding alone does not move reads; selected reads and health writes share the D1 destination", async () => {
    const env = { D1_STATE: db, D1_STATE_TABLES: " rows, lane_health " };
    assert.equal(selectedD1Store({ D1_STATE: db }, ["rows"]), null);
    assert.equal(selectedD1Store(env, []), null);
    assert.equal(selectedD1Store(env, ["neurons"]), null);
    assert.equal(selectedD1Store(null, ["rows"]), null);
    assert.equal(selectedD1Store("invalid", ["rows"]), null);
    assert.equal(selectedD1Store({ D1_STATE_TABLES: 1 }, ["rows"]), null);
    const selected = readStore(env, ["rows"]);
    assert.deepEqual(await selected?.first("SELECT 42 AS n"), { n: 42 });
    assert.deepEqual(await laneHealthStore(env)?.query("SELECT 43 AS n"), [
      { n: 43 },
    ]);
    const injected = createD1Store(db);
    assert.equal(readStore(env, ["rows"], injected), injected);
    assert.equal(laneHealthStore(env, injected), injected);
  });

  test("no fallback to Neon after cutover, including mixed-owner JOINs and missing bindings", () => {
    const env = {
      D1_STATE: db,
      D1_STATE_TABLES: "rows",
      HYPERDRIVE: { connectionString: "postgresql://unused/db" },
    };
    assert.throws(
      () => readStore(env, ["rows", "neurons"]),
      /spans D1 and Neon/,
    );
    for (const binding of [undefined, {}, { prepare() {} }]) {
      assert.throws(
        () => readStore({ ...env, D1_STATE: binding }, ["rows"]),
        /Selected D1 store is unbound/,
      );
    }
  });
});
