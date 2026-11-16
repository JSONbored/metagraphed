import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { createPgLaneHealth } from "../src/lane-health-pg.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  type LaneHealthDb,
} from "../src/lane-health.ts";
import {
  loadLaneFaultRates,
  loadLaneMaxGap,
  loadLaneStaleRuns,
  loadLaneUnknownRuns,
} from "../src/lane-alarm.ts";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

type Row = Record<string, unknown>;
const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  statement_timeout: 5000,
  query_timeout: 5000,
  connectionTimeoutMillis: 2000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const sourceSql = readFileSync(
  new URL("../db/d1-schema.sql", import.meta.url),
  "utf8",
);
const tables = [
  "lane_health",
  "lane_health_current",
  "lane_health_clocks",
  "lane_health_verdict_latest",
] as const;
const columns: Record<(typeof tables)[number], string[]> = {
  lane_health: [
    "source_row_id",
    "lane",
    "verdict",
    "age_ms",
    "detail",
    "checked_at",
    "_source_tid",
  ],
  lane_health_current: [
    "lane",
    "verdict",
    "age_ms",
    "detail",
    "checked_at",
    "_history_rowid",
  ],
  lane_health_clocks: [
    "lane",
    "checked_at",
    "occurrences",
    "previous_at",
    "gap",
  ],
  lane_health_verdict_latest: ["lane", "verdict", "checked_at"],
};
const numeric = new Set([
  "source_row_id",
  "age_ms",
  "checked_at",
  "_history_rowid",
  "occurrences",
  "previous_at",
  "gap",
]);
const orders = ["source_row_id", "lane", "lane,checked_at", "lane,verdict"];
let sqlite: DatabaseSync;
let runtime: PgStoreRuntime;
let ownsSchema = false;
const idleErrors: Error[] = [];

function sourceRows(text: string): Row[] {
  const statement = sqlite.prepare(text);
  statement.setReadBigInts(true);
  return statement.all().map((row) => ({ ...row }));
}

function sourceTable(table: (typeof tables)[number]): Row[] {
  const selected = columns[table].map((column) =>
    column === "source_row_id" ? "rowid AS source_row_id" : column,
  );
  return sourceRows(
    `SELECT ${selected.join(",")} FROM ${table} ORDER BY ${orders[tables.indexOf(table)]}`,
  );
}

function canonical(rows: Row[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (value === null || !numeric.has(key)) return [key, value];
        // Overflow gaps are binary64 integers. BigInt(number) retains the exact
        // binary value, while PostgreSQL numeric retains the same integer value.
        return [
          key,
          typeof value === "string"
            ? value.replace(/\.0+$/, "")
            : BigInt(value as number | bigint).toString(),
        ];
      }),
    ),
  );
}

async function equivalent(): Promise<void> {
  for (const table of tables) {
    const actual = await control.query(
      `SELECT ${columns[table].join(",")} FROM app.${table} ORDER BY ${orders[tables.indexOf(table)]}`,
    );
    assert.deepEqual(
      canonical(actual.rows),
      canonical(sourceTable(table)),
      table,
    );
  }
}

async function resetTarget(): Promise<void> {
  if (ownsSchema) await control.query("DROP SCHEMA app CASCADE");
  await control.query(migration("0004_lane_health.sql"));
  ownsSchema = true;
}

async function importSource(): Promise<void> {
  for (const table of tables) {
    for (const row of sourceTable(table)) {
      const values = columns[table].map((column) => {
        const value = row[column];
        return column === "gap" && typeof value === "number"
          ? BigInt(value).toString()
          : value;
      });
      await control.query(
        `INSERT INTO app.${table} (${columns[table].join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})`,
        values,
      );
    }
  }
}

async function activate(): Promise<void> {
  await control.query("BEGIN");
  try {
    await control.query(migration("0005_lane_health_activate.sql"));
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

async function both(text: string): Promise<void> {
  sqlite.exec(text);
  await control.query(text.replace(/\browid\b/g, "source_row_id"));
  await equivalent();
}

const seed = `INSERT INTO lane_health(rowid,lane,verdict,age_ms,detail,checked_at) VALUES
  (1,'a','ok',1,'first',10),(2,'a','stale',2,'middle tie',20),(3,'a','stale',3,'middle tie 2',20),
  (4,'a','unknown',4,'middle successor',30),(5,'a','ok',5,'newest',40),(6,'a','stale',6,'newest stale',40),
  (7,'b','ok',7,'other lane',5),(8,'b','stale',8,'other latest',15)`;

describe(
  "lane-health source semantics on PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query("SET search_path = app, pg_catalog");
      runtime = createPgStoreRuntime({
        connectionString,
        maxConnections: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => idleErrors.push(error),
      });
    });
    beforeEach(async () => {
      sqlite = new DatabaseSync(":memory:");
      const sourceTables = [
        ...sourceSql.matchAll(
          /^CREATE TABLE lane_health(?:_(?:clocks|current|verdict_latest))? \([\s\S]*?;\n/gm,
        ),
      ];
      const sourceTriggers = [
        ...sourceSql.matchAll(
          /^CREATE TRIGGER lane_health_[^\n]+[\s\S]*?^END;/gm,
        ),
      ];
      assert.equal(sourceTables.length, 4);
      assert.equal(sourceTriggers.length, 7);
      for (const match of [...sourceTables, ...sourceTriggers])
        sqlite.exec(match[0]);
      await resetTarget();
    });
    afterEach(() => sqlite.close());
    after(async () => {
      try {
        await runtime?.close();
        if (ownsSchema) await control.query("DROP SCHEMA app CASCADE");
        assert.deepEqual(idleErrors, []);
      } finally {
        await control.end();
      }
    });

    it("imports original rowids and an existing arbitrary equal-maximum winner without rewriting them", async () => {
      sqlite.exec(`INSERT INTO lane_health(rowid,lane,verdict,age_ms,detail,checked_at) VALUES
      (-9223372036854775808,'negative','ok',NULL,NULL,-9223372036854775808),
      (0,'zero','unknown',0,'zero',0),
      (90,'tied','stale',1,'first inserted',100),(10,'tied','stale',2,'smaller identity',100),
      (9223372036854775807,'maximum','ok',NULL,NULL,9223372036854775807)`);
      await importSource();
      await equivalent();
      await activate();
      await equivalent();
      assert.equal(
        (
          await control.query(
            "SELECT _history_rowid FROM lane_health_current WHERE lane='tied'",
          )
        ).rows[0]._history_rowid,
        90,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM pg_sequences WHERE schemaname='app'",
          )
        ).rows[0].n,
        0,
      );
    });

    it("refuses incomplete, extra or mismatched imported projections before attaching any triggers", async () => {
      sqlite.exec(seed);
      for (const corruption of [
        "DELETE FROM lane_health_current WHERE lane='a'",
        "UPDATE lane_health_current SET detail='changed' WHERE lane='a'",
        "UPDATE lane_health_current SET _history_rowid=1 WHERE lane='a'",
        "DELETE FROM lane_health_clocks WHERE lane='a' AND checked_at=20",
        "UPDATE lane_health_clocks SET occurrences=99 WHERE lane='a' AND checked_at=20",
        "UPDATE lane_health_clocks SET previous_at=NULL,gap=NULL WHERE lane='a' AND checked_at=20",
        "INSERT INTO lane_health_clocks VALUES ('extra',1,1,NULL,NULL)",
        "DELETE FROM lane_health_verdict_latest WHERE lane='a' AND verdict='stale'",
        "UPDATE lane_health_verdict_latest SET checked_at=999 WHERE lane='a' AND verdict='stale'",
        "INSERT INTO lane_health_verdict_latest VALUES ('extra','ok',1)",
      ]) {
        await resetTarget();
        await importSource();
        await control.query(corruption);
        const history = await control.query(
          "SELECT * FROM lane_health ORDER BY source_row_id",
        );
        await assert.rejects(activate(), /projection differs/);
        assert.deepEqual(
          (
            await control.query(
              "SELECT * FROM lane_health ORDER BY source_row_id",
            )
          ).rows,
          history.rows,
        );
        assert.equal(
          (
            await control.query(
              "SELECT count(*) AS n FROM pg_trigger WHERE tgrelid IN ('app.lane_health'::regclass,'app.lane_health_clocks'::regclass) AND NOT tgisinternal",
            )
          ).rows[0].n,
          0,
        );
      }
    });

    it("matches all seven trigger effects across ties, payload updates, lane moves and bulk deletion", async () => {
      sqlite.exec(seed);
      await importSource();
      await activate();
      for (const operation of [
        "DELETE FROM lane_health WHERE detail='middle tie'",
        "DELETE FROM lane_health WHERE detail='middle tie 2'",
        "DELETE FROM lane_health WHERE detail='newest'",
        "UPDATE lane_health SET checked_at=25 WHERE detail='newest stale'",
        "UPDATE lane_health SET checked_at=50 WHERE detail='newest stale'",
        "UPDATE lane_health SET lane='b',checked_at=5,verdict='unknown' WHERE detail='middle successor'",
        "UPDATE lane_health SET verdict='stale' WHERE detail='other lane'",
        "UPDATE lane_health SET verdict='ok',checked_at=5 WHERE detail='other latest'",
        "UPDATE lane_health SET lane='c',checked_at=1 WHERE detail='other latest'",
        "UPDATE lane_health SET age_ms=NULL,detail=NULL,checked_at=checked_at WHERE lane='c'",
        "UPDATE lane_health SET rowid=-100 WHERE lane='c'",
        "DELETE FROM lane_health WHERE lane='b'",
        "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('a','unknown',35),('a','stale',35),('a','ok',45),('a','stale',45)",
        "DELETE FROM lane_health WHERE lane='a' AND checked_at>=35",
        "DELETE FROM lane_health",
      ])
        await both(operation);
    });

    it("keeps exact INTEGER values and exact promoted binary64 gaps including operand-rounding behavior", async () => {
      for (const [current, previous] of [
        ["10", "1"],
        ["0", "-9223372036854775808"],
        ["9223372036854775807", "-9223372036854775808"],
        ["9223372036854775807", "-1025"],
        ["-9223372036854775808", "1"],
      ]) {
        const expected = sourceRows(`SELECT ${current} - (${previous}) AS gap`);
        const actual = await control.query(
          "SELECT app.lane_health_gap($1,$2) AS gap",
          [current, previous],
        );
        assert.deepEqual(canonical(actual.rows), canonical(expected));
      }
      sqlite.exec(`INSERT INTO lane_health(rowid,lane,verdict,checked_at) VALUES
      (1,'overflow','ok',-1025),(2,'overflow','stale',9223372036854775807)`);
      assert.equal(
        sourceRows(
          "SELECT typeof(gap) AS kind FROM lane_health_clocks WHERE previous_at IS NOT NULL",
        )[0].kind,
        "real",
      );
      await importSource();
      await activate();
      await equivalent();
      await both("UPDATE lane_health SET checked_at=10 WHERE rowid=2");
      await both(
        "UPDATE lane_health SET checked_at=9223372036854775807 WHERE rowid=2",
      );
      const gap = (
        await control.query(
          "SELECT gap::double precision AS gap FROM lane_health_clocks WHERE previous_at IS NOT NULL",
        )
      ).rows[0].gap;
      assert.equal(gap, Number(sourceTable("lane_health_clocks")[1].gap));
    });

    it("allocates around an imported maximum and reuses the deleted maximum like a non-AUTOINCREMENT rowid", async () => {
      sqlite.exec(
        "INSERT INTO lane_health(rowid,lane,verdict,checked_at) VALUES (9223372036854775807,'max','ok',1)",
      );
      await importSource();
      await activate();
      const created = await control.query(
        "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('new','ok',2) RETURNING source_row_id::text",
      );
      const allocated = BigInt(created.rows[0].source_row_id);
      assert.ok(allocated > 0n && allocated < 9223372036854775807n);
      await control.query("DELETE FROM lane_health");
      await control.query(
        "INSERT INTO lane_health(source_row_id,lane,verdict,checked_at) VALUES (9,'reuse','ok',1),(10,'reuse','ok',2)",
      );
      await control.query("DELETE FROM lane_health WHERE source_row_id=10");
      assert.equal(
        (
          await control.query(
            "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('reuse','ok',3) RETURNING source_row_id",
          )
        ).rows[0].source_row_id,
        10,
      );
    });

    it("preserves rollback of history and projections after a later statement fails", async () => {
      sqlite.exec(seed);
      await importSource();
      await activate();
      await control.query("BEGIN");
      await control.query("DELETE FROM lane_health");
      await assert.rejects(
        control.query(
          "INSERT INTO lane_health(lane,verdict,checked_at) VALUES (NULL,'ok',1)",
        ),
      );
      await control.query("ROLLBACK");
      await equivalent();
    });

    it("serializes a waiting writer before computing predecessor and current projections", async () => {
      sqlite.exec(
        "INSERT INTO lane_health(rowid,lane,verdict,checked_at) VALUES (1,'concurrent','ok',10)",
      );
      await importSource();
      await activate();
      const waiting = new Client({
        connectionString,
        application_name: "lane-health-waiting-writer",
        statement_timeout: 5000,
      });
      await waiting.connect();
      await waiting.query("SET search_path=app,pg_catalog");
      await control.query("BEGIN");
      try {
        await control.query(
          "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('concurrent','stale',30)",
        );
        const pending = waiting.query(
          "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('concurrent','unknown',20)",
        );
        let blocked = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const state = await control.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE application_name='lane-health-waiting-writer'",
          );
          if (state.rows[0]?.wait_event_type === "Lock") {
            blocked = true;
            break;
          }
          await delay(25);
        }
        assert.equal(blocked, true);
        await control.query("COMMIT");
        await pending;
      } finally {
        await control.query("ROLLBACK");
        await waiting.end();
      }
      sqlite.exec(
        "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('concurrent','stale',30),('concurrent','unknown',20)",
      );
      await equivalent();
    });

    it("exposes existing writer and health-reader results through the pooled native capability", async () => {
      sqlite.exec(seed);
      await importSource();
      await activate();
      const native = createPgLaneHealth(runtime);
      const env = { LANE_HEALTH_STORE: native };
      assert.equal(laneHealthStore(env), native);
      const source: LaneHealthDb = {
        query: async (text, values = []) =>
          sqlite.prepare(text).all(...(values as never[])),
        run: async () => ({ changes: 0 }),
      };
      assert.deepEqual(
        await loadLatestLaneHealth(native),
        await loadLatestLaneHealth(source),
      );
      assert.deepEqual(
        await loadLaneFaultRates(native, 0),
        await loadLaneFaultRates(source, 0),
      );
      assert.deepEqual(
        await loadLaneMaxGap(native, 0),
        await loadLaneMaxGap(source, 0),
      );
      assert.deepEqual(
        await loadLaneStaleRuns(native),
        await loadLaneStaleRuns(source),
      );
      assert.deepEqual(
        await loadLaneUnknownRuns(native),
        await loadLaneUnknownRuns(source),
      );
      assert.equal(
        await recordLaneVerdict(
          native,
          {
            lane: "written",
            verdict: "ok",
            age_ms: null,
            detail: "same pool",
            checked_at: Date.now(),
          },
          { confirm: true },
        ),
        true,
      );
      assert.equal(
        (
          (await native.query(
            "SELECT count(*) AS n FROM lane_health WHERE lane='written'",
          )) as { n: number }[]
        )[0].n,
        1,
      );
      await control.query(
        "ALTER TABLE lane_health DISABLE TRIGGER lane_health_maintain",
      );
      assert.equal(await native.retentionReady!(), false);
      await assert.rejects(native.latest!(), /not activated/);
    });

    it("keeps a repeatable-read snapshot of all projections while a writer commits", async () => {
      sqlite.exec(seed);
      await importSource();
      await activate();
      const selected = await runtime.transaction(
        async (tx) => {
          const before = await tx.query(
            "SELECT * FROM app.lane_health_current ORDER BY lane",
          );
          await control.query(
            "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('a','ok',100)",
          );
          const after = await tx.query(
            "SELECT * FROM app.lane_health_current ORDER BY lane",
          );
          assert.deepEqual(after, before);
          return before;
        },
        { isolation: "repeatable read" },
      );
      assert.notDeepEqual(
        (await control.query("SELECT * FROM lane_health_current ORDER BY lane"))
          .rows,
        selected,
      );
    });
  },
);
