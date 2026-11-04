import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgObservations } from "../src/observations-pg.ts";
import {
  persistProbesToNeon,
  pruneChecksNeon,
  rollupFailureReasonsToNeon,
  rollupUptimeDailyToNeon,
  type ObservationsSql,
} from "../src/observations-neon.ts";
import {
  persistProbesD1,
  rollupFailuresD1,
  rollupUptimeD1,
} from "../src/observations-d1.ts";
import type { ProducerStore } from "../src/producer-store.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const tables = [
  "surface_checks",
  "surface_status",
  "surface_failure_daily",
  "surface_uptime_daily",
];
const control = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const sqlite = new DatabaseSync(":memory:");
const bind = (values: unknown[] = []) =>
  values.map((value) =>
    typeof value === "boolean" ? Number(value) : value,
  ) as (string | number | null | Uint8Array)[];
const source: ProducerStore = {
  async query<Row>(text: string, values: unknown[] = []) {
    return sqlite.prepare(text).all(...bind(values)) as Row[];
  },
  async first<Row>(text: string, values: unknown[] = []) {
    return (sqlite.prepare(text).get(...bind(values)) ?? null) as Row | null;
  },
  async run(text, values) {
    return {
      changes: Number(sqlite.prepare(text).run(...bind(values)).changes),
    };
  },
  async transaction(statements) {
    sqlite.exec("BEGIN");
    try {
      const results = statements.map(({ text, values }) => ({
        changes: Number(sqlite.prepare(text).run(...bind(values)).changes),
      }));
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
  async close() {},
};
let runtime: PgStoreRuntime;
let native: ObservationsSql;
let ownsSchemas = false;
const readMigration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const days = [{ date: "2026-11-01", start: 1000, end: 2000 }];
const probe = (
  id: string,
  key: string,
  checked: number,
  status = "ok",
  netuid: number | null = 1,
) => ({
  surface_id: id,
  surface_key: key,
  checked_at_ms: checked,
  status,
  netuid,
  kind: "subnet-api",
  classification: status === "ok" ? "live" : "unreachable",
  latency_ms: status === "ok" ? 10 : null,
  last_ok_ms: status === "ok" ? checked : null,
  consecutive_failures: status === "ok" ? 0 : 1,
});

async function compare(table: string, order: string) {
  const expected = sqlite
    .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
    .all()
    .map((row) => ({ ...row }));
  const actual = (
    await control.query(`SELECT * FROM app.${table} ORDER BY ${order}`)
  ).rows.map((row) => {
    if (typeof row.ok === "boolean") row.ok = Number(row.ok);
    return row;
  });
  assert.deepEqual(actual, expected, table);
}

describe(
  "pooled observation writers on the migrated PostgreSQL schema",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query("BEGIN");
      try {
        for (const name of [
          "0000_source_metadata.sql",
          "0007_registry_health.sql",
          "0008_registry_health_activate.sql",
        ])
          await control.query(readMigration(name));
        await control.query("COMMIT");
        ownsSchemas = true;
      } catch (error) {
        await control.query("ROLLBACK");
        throw error;
      }
      const objects = JSON.parse(
        readFileSync(
          new URL("../generated/db/d1-schema.json", import.meta.url),
          "utf8",
        ),
      ) as { type: string; tbl_name: string; sql: string }[];
      for (const object of objects.filter(
        (value) => value.type === "table" && tables.includes(value.tbl_name),
      ))
        sqlite.exec(object.sql);
      for (const object of objects.filter(
        (value) => value.type !== "table" && tables.includes(value.tbl_name),
      ))
        sqlite.exec(object.sql);
      runtime = createPgStoreRuntime({
        connectionString: pg18FixtureUrl().toString(),
        maxConnections: 2,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => {
          throw error;
        },
      });
      native = createPgObservations(runtime);
    });
    beforeEach(async () => {
      await control.query(
        `TRUNCATE ${tables.map((name) => `app.${name}`).join(",")}`,
      );
      for (const table of tables) sqlite.exec(`DELETE FROM ${table}`);
    });
    after(async () => {
      try {
        await runtime?.close();
        if (ownsSchemas)
          await control.query(
            "DROP SCHEMA app CASCADE; DROP SCHEMA source_meta CASCADE",
          );
      } finally {
        sqlite.close();
        await control.end();
      }
    });

    it("matches probe history and aliases across replay, renames and older observations", async () => {
      for (const rows of [
        [probe("alias", "old", 1100)],
        [probe("alias", "new", 1200)],
        [probe("alias", "older", 1150)],
        [probe("alias", "new", 1300, "failed")],
        [probe("alias", "new", 1300, "failed")],
      ]) {
        assert.equal((await persistProbesD1(source, rows, 1400)).ok, true);
        assert.equal((await persistProbesToNeon(native, rows, 1400)).ok, true);
        await compare("surface_checks", "surface_id,checked_at");
        await compare("surface_status", "surface_id");
      }
    });

    it("rolls back the whole probe batch after a later source constraint fails", async () => {
      const rows = [
        probe("valid", "key", 1100),
        { ...probe("bad", "other", 1200), surface_id: null },
      ];
      assert.equal((await persistProbesD1(source, rows, 1400)).ok, false);
      assert.equal((await persistProbesToNeon(native, rows, 1400)).ok, false);
      await compare("surface_checks", "surface_id,checked_at");
      await compare("surface_status", "surface_id");
    });

    it("matches failure rollups including the source NULL and minus-one collision", async () => {
      const rows = [
        probe("a", "a", 1100, "failed", null),
        probe("b", "b", 1100, "failed", -1),
        probe("b", "b", 1200, "failed", -1),
        probe("c", "c", 1100, "failed", 2),
      ];
      await persistProbesD1(source, rows, 1400);
      await persistProbesToNeon(native, rows, 1400);
      assert.equal((await rollupFailuresD1(source, days, 1500)).ok, true);
      assert.equal(
        (await rollupFailureReasonsToNeon(native, days, 1500)).ok,
        true,
      );
      await compare(
        "surface_failure_daily",
        "kind,classification,netuid NULLS FIRST",
      );
    });

    it("matches uptime percentiles and preserves prior rollup data when raw history is empty", async () => {
      const rows = [
        probe("a", "a", 1100),
        probe("a", "a", 1200, "failed"),
        { ...probe("a", "a", 1300), latency_ms: 21 },
      ];
      await persistProbesD1(source, rows, 1400);
      await persistProbesToNeon(native, rows, 1400);
      assert.equal((await rollupUptimeD1(source, days, 1500)).ok, true);
      assert.equal(
        (await rollupUptimeDailyToNeon(native, days, 1500)).ok,
        true,
      );
      await compare("surface_uptime_daily", "surface_id,day");
      assert.equal((await pruneChecksNeon(native, 2000)).ok, true);
      sqlite.exec("DELETE FROM surface_checks");
      assert.equal((await rollupUptimeD1(source, days, 1600)).ok, true);
      assert.equal(
        (await rollupUptimeDailyToNeon(native, days, 1600)).ok,
        true,
      );
      await compare("surface_uptime_daily", "surface_id,day");
    });
  },
);
