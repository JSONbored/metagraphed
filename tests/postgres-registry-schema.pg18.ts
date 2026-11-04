import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client, type QueryResult } from "pg";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import { setTimeout as delay } from "node:timers/promises";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const names = [
  "origin_reachability",
  "providers",
  "self_health_checks",
  "self_health_daily",
  "subnets",
  "surface_checks",
  "surface_failure_daily",
  "surface_history",
  "surface_status",
  "surface_uptime_daily",
  "surfaces",
];
const sourceObjects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}[];
const source = new DatabaseSync(":memory:");
const control = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const activation = migration("0008_registry_health_activate.sql");
let ownApp = false;
let ownMetadata = false;

async function activate() {
  await control.query("BEGIN");
  try {
    await control.query(activation);
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

describe(
  "registry and surface-health PostgreSQL schema",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownApp =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='app'",
          )
        ).rowCount === 0;
      ownMetadata =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='source_meta'",
          )
        ).rowCount === 0;
      if (ownMetadata)
        await control.query(migration("0000_source_metadata.sql"));
      await control.query(migration("0007_registry_health.sql"));
      for (const object of sourceObjects.filter(
        (object) => object.type === "table" && names.includes(object.name),
      ))
        source.exec(object.sql);
      for (const object of sourceObjects.filter(
        (object) => object.type !== "table" && names.includes(object.tbl_name),
      ))
        source.exec(object.sql);
    });
    beforeEach(async () => {
      await control.query(
        "DROP TRIGGER IF EXISTS surface_status_lock ON app.surface_status; DROP TRIGGER IF EXISTS surface_status_alias_insert ON app.surface_status",
      );
      await control.query(
        `TRUNCATE ${names.map((name) => `app.${name}`).join(",")},source_meta.state_sqlite_sequence RESTART IDENTITY`,
      );
      for (const name of names) source.exec(`DELETE FROM ${name}`);
    });
    after(async () => {
      try {
        for (const name of names)
          await control.query(`DROP TABLE IF EXISTS app.${name}`);
        await control.query(
          "DROP FUNCTION IF EXISTS app.surface_status_alias_insert(); DROP FUNCTION IF EXISTS app.surface_status_lock()",
        );
        if (ownApp) await control.query("DROP SCHEMA app");
        if (ownMetadata) await control.query("DROP SCHEMA source_meta CASCADE");
      } finally {
        source.close();
        await control.end();
      }
    });

    it("preserves all source columns and every explicit index", async () => {
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((row) => row.name);
        const actual = await control.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name=$1 ORDER BY ordinal_position",
          [name],
        );
        assert.deepEqual(
          actual.rows.map((row) => row.column_name),
          expected,
          name,
        );
      }
      const expectedIndexes = sourceObjects
        .filter(
          (object) =>
            object.type === "index" && names.includes(object.tbl_name),
        )
        .map((object) => object.name)
        .sort();
      const actualIndexes = await control.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname='app' AND indexname LIKE 'idx_%' ORDER BY indexname",
      );
      assert.deepEqual(
        actualIndexes.rows.map((row) => row.indexname),
        expectedIndexes,
      );
      assert.equal(expectedIndexes.length, 16);
    });

    it("retains nullable and duplicate rows while enforcing source uniqueness and flag types", async () => {
      await control.query(
        "INSERT INTO app.providers VALUES ('p','{ \"exact\": 1.00 }','commit',1000000000000)",
      );
      assert.equal(
        (await control.query("SELECT overlay FROM app.providers")).rows[0]
          .overlay,
        '{ "exact": 1.00 }',
      );
      await control.query(
        "INSERT INTO app.surfaces(id,subnet_netuid,surface_key,kind,url,overlay,source_commit) VALUES ('s',1,'key','docs','https://example.com','{}','commit')",
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT probe_eligible,public_safe FROM app.surfaces",
          )
        ).rows[0],
        { probe_eligible: false, public_safe: true },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.surfaces(id,subnet_netuid,surface_key,kind,url,overlay,source_commit) VALUES ('other',1,'different','docs','https://example.com','{}','commit')",
        ),
        { code: "23505" },
      );
      await control.query(
        "INSERT INTO app.surface_checks(surface_id,checked_at,ok) VALUES ('s',1,NULL),('s',2,true),('s',3,false)",
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT ok FROM app.surface_checks ORDER BY checked_at",
          )
        ).rows.map((row) => row.ok),
        [null, true, false],
      );
      await control.query(
        "INSERT INTO app.surface_history(id,subnet_netuid,action,overlay,source_commit) VALUES (-3,1,'same','{}','c'),(4,1,'same','{}','c')",
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.surface_history",
          )
        ).rows[0].n,
        2,
      );
      await control.query(
        "INSERT INTO app.surface_failure_daily VALUES ('day',NULL,'docs','offline',1,1)",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.surface_failure_daily VALUES ('day',-1,'docs','offline',1,1)",
        ),
        { code: "23505" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.origin_reachability VALUES ('o',1,0,0,'serving')",
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.origin_reachability VALUES ('o',1000000000000,-1,0,'serving')",
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.origin_reachability VALUES ('o',1000000000000,0,0,'unknown')",
        ),
        { code: "23514" },
      );
    });

    it("reconciles identity above imported, legacy and already-consumed sequence values", async () => {
      await control.query(
        "INSERT INTO app.surface_history(id,subnet_netuid,action,overlay,source_commit) VALUES (12,1,'import','{}','c')",
      );
      await control.query(
        "INSERT INTO source_meta.state_sqlite_sequence VALUES ('surface_history',20)",
      );
      await control.query("SELECT setval('app.surface_history_id_seq',30)");
      await activate();
      const inserted = await control.query(
        "INSERT INTO app.surface_history(subnet_netuid,action,overlay,source_commit) VALUES (1,'next','{}','c') RETURNING id",
      );
      assert.equal(Number(inserted.rows[0].id), 31);
      await control.query("DELETE FROM app.surface_history WHERE id=31");
      await control.query("BEGIN");
      await control.query(
        activation.slice(0, activation.indexOf("CREATE TRIGGER")),
      );
      await control.query("COMMIT");
      assert.equal(
        Number(
          (
            await control.query(
              "SELECT nextval('app.surface_history_id_seq') AS id",
            )
          ).rows[0].id,
        ),
        32,
      );
    });

    it("refuses exhausted sequence activation before installing alias maintenance", async () => {
      await control.query(
        "INSERT INTO source_meta.state_sqlite_sequence VALUES ('surface_history',9223372036854775807)",
      );
      await assert.rejects(activate(), { code: "22003" });
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM pg_trigger WHERE tgrelid='app.surface_status'::regclass AND NOT tgisinternal",
          )
        ).rows[0].n,
        0,
      );
    });

    it("matches source alias moves, newer-observation refusal, equal timestamps and NULL rules", async () => {
      await activate();
      const sql =
        "INSERT INTO surface_status(surface_id,surface_key,last_checked,status) VALUES (?,?,?,?) ON CONFLICT(surface_id) DO UPDATE SET surface_key=excluded.surface_key,last_checked=excluded.last_checked,status=excluded.status";
      const rows: (string | number | null)[][] = [
        ["alias", "first", 10, "ok"],
        ["alias", "second", 20, "ok"],
        ["alias", "third", 19, "stale"],
        ["alias", "third", 20, "unknown"],
        ["legacy", null, 1, "ok"],
        ["legacy", "fresh", 2, "ok"],
        ["empty", "", 3, "ok"],
        ["null-time", "null-key", null, "ok"],
      ];
      for (const row of rows) {
        source.prepare(sql).run(...row);
        await control.query(
          toPositionalPlaceholders(
            sql.replace("INTO surface_status", "INTO app.surface_status"),
          ),
          row,
        );
        const expected = source
          .prepare(
            "SELECT surface_id,surface_key,last_checked,status FROM surface_status ORDER BY surface_id",
          )
          .all()
          .map((value) => ({ ...value }));
        const actual = (
          await control.query(
            "SELECT surface_id,surface_key,last_checked::double precision,status FROM app.surface_status ORDER BY surface_id",
          )
        ).rows;
        assert.deepEqual(actual, expected);
      }
    });

    it("rolls alias changes back with their failed enclosing transaction", async () => {
      await activate();
      await control.query(
        "INSERT INTO app.surface_status(surface_id,surface_key,last_checked) VALUES ('a','old',1)",
      );
      await control.query("BEGIN");
      await control.query(
        "INSERT INTO app.surface_status(surface_id,surface_key,last_checked) VALUES ('a','new',2)",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.surface_status(surface_id,surface_key) VALUES ('duplicate','new')",
        ),
        { code: "23505" },
      );
      await control.query("ROLLBACK");
      assert.deepEqual(
        (
          await control.query(
            "SELECT surface_id,surface_key FROM app.surface_status",
          )
        ).rows,
        [{ surface_id: "a", surface_key: "old" }],
      );
    });

    it("checks a waiting alias insert against the newly committed observation", async () => {
      await activate();
      const writer = new Client({
        connectionString: pg18FixtureUrl().toString(),
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000,
      });
      await writer.connect();
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await control.query("BEGIN");
      let committed = false;
      let pending: Promise<QueryResult> | undefined;
      try {
        await control.query(
          "INSERT INTO app.surface_status(surface_id,surface_key,last_checked) VALUES ('winner','key',30)",
        );
        pending = writer.query(
          "INSERT INTO app.surface_status(surface_id,surface_key,last_checked) VALUES ('older','key',20)",
        );
        let blocked = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const row = (
            await control.query(
              "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0];
          if (row?.wait_event_type === "Lock") {
            blocked = true;
            break;
          }
          await delay(20);
        }
        assert.ok(
          blocked,
          "the second writer waits for the first alias transaction",
        );
        await control.query("COMMIT");
        committed = true;
        assert.equal((await pending).rowCount, 0);
        assert.deepEqual(
          (
            await control.query(
              "SELECT surface_id,surface_key FROM app.surface_status",
            )
          ).rows,
          [{ surface_id: "winner", surface_key: "key" }],
        );
      } finally {
        if (!committed) await control.query("ROLLBACK");
        await pending?.catch(() => {});
        await writer.end();
      }
    });
  },
);
