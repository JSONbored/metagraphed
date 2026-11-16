import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgChainConcentrationStore } from "../src/pg-chain-concentration.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createD1Store } from "../src/d1-store.ts";
import { rollupChainConcentration } from "../src/chain-concentration-rollup.ts";
import type { HistoryReadEnv } from "../src/history-readers.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const runtime = createPgStoreRuntime({
  connectionString,
  maxConnections: 2,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const binary = new DatabaseSync(":memory:");
const native = createPgChainConcentrationStore(runtime, decoder);
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const stamp = Date.UTC(2026, 10, 4);
let db: D1Database;
let ownApp = false;
const tables: string[] = [];

async function insert(
  day: string,
  netuid: number,
  shard: number,
  json: string,
  members: [number, string | null][],
) {
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  await db
    .prepare("INSERT INTO neuron_daily_documents VALUES(?,?,?,?,jsonb(?))")
    .bind(netuid, day, shard, stamp, json)
    .run();
  await control.query(
    "INSERT INTO app.neuron_daily_documents VALUES($1,$2,$3,$4,$5)",
    [netuid, day, shard, stamp, payload],
  );
  for (const [uid, coldkey] of members) {
    await db
      .prepare("INSERT INTO neuron_daily_members VALUES(?,?,?,NULL,?,?)")
      .bind(netuid, uid, day, coldkey, shard)
      .run();
    await control.query(
      "INSERT INTO app.neuron_daily_members(netuid,uid,snapshot_date,coldkey,shard) VALUES($1,$2,$3,$4,$5)",
      [netuid, uid, day, coldkey, shard],
    );
  }
}

describe(
  "native chain concentration source parity",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownApp = !(
        await control.query("SELECT 1 FROM pg_namespace WHERE nspname='app'")
      ).rows.length;
      db = await source.getD1Database("DB");
      for (const file of [
        "0007_neuron_documents.sql",
        "0012_neuron_daily_join_index.sql",
        "0022_neuron_document_dates.sql",
      ])
        for (const sql of readFileSync(
          new URL(`../migrations/d1/${file}`, import.meta.url),
          "utf8",
        ).split("-- statement-breakpoint"))
          if (sql.trim()) await db.prepare(sql).run();
      await db
        .prepare(
          "CREATE TABLE chain_concentration_daily(day TEXT PRIMARY KEY,neuron_count INTEGER NOT NULL,card TEXT NOT NULL,source_captured_at INTEGER,computed_at INTEGER NOT NULL,builder_version INTEGER NOT NULL)",
        )
        .run();
      for (const file of [
        "0024_neuron_documents.sql",
        "0012_economic_history.sql",
      ]) {
        const sql = readFileSync(
          new URL(`../migrations/postgres/${file}`, import.meta.url),
          "utf8",
        );
        const created = [
          ...sql.matchAll(/CREATE TABLE app\.([a-z_0-9]+)\s*\(/g),
        ].map((match) => match[1]!);
        for (const table of created)
          assert.equal(
            (
              await control.query("SELECT to_regclass($1) AS name", [
                `app.${table}`,
              ])
            ).rows[0].name,
            null,
            `Fixture table already exists: ${table}`,
          );
        await control.query(sql);
        tables.push(...created);
      }
    });
    beforeEach(async () => {
      for (const table of [
        "chain_concentration_daily",
        "neuron_daily_members",
        "neuron_daily_documents",
      ]) {
        await control.query(`DELETE FROM app.${table}`);
        await db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    after(async () => {
      await runtime.close();
      await source.dispose();
      decoder.close();
      binary.close();
      try {
        for (const table of tables.reverse())
          await control.query(`DROP TABLE app.${table}`);
        if (ownApp) await control.query("DROP SCHEMA app");
      } finally {
        await control.end();
      }
    });

    it("preserves duplicate aliases, integer array keys, row order, wire values and complete-day writes", async () => {
      const json =
        '{"01":{"stake_tao":10000000000000000,"emission_tao":0.1,"validator_permit":true,"captured_at":1793750400001},"1":{"stake_tao":1,"emission_tao":0.2,"captured_at":1793750400002},"1":{"stake_tao":1,"stake_tao":9,"emission_tao":0.3,"captured_at":9007199254740993},"9":"not-json","0":null}';
      for (const day of ["2026-11-03", "2026-11-01", "2026-11-04"]) {
        await insert(day, 7, 2, json, [
          [0, null],
          [1, "same-entity"],
        ]);
        await insert(day, 7, 0, '{"5":{"stake_tao":0.1,"emission_tao":0.1}}', [
          [5, "same-entity"],
        ]);
        await insert(
          day,
          2,
          5,
          '[{"stake_tao":2,"emission_tao":0.4,"validator_permit":false},{"stake_tao":3,"emission_tao":0.5}]',
          [
            [0, "same-entity"],
            [1, "other-entity"],
          ],
        );
      }
      await insert("2026-10-31", 1, 0, '{"1":{"stake_tao":1}}', []);
      const original = createD1Store(db);
      const captured = new Map<string, Record<string, unknown>[]>();
      const store = {
        ...original,
        async query<T>(text: string, values?: unknown[]) {
          const rows = await original.query<T>(text, values);
          if (text.includes("CROSS JOIN json_each"))
            captured.set(String(values![0]), rows as Record<string, unknown>[]);
          return rows;
        },
      };
      const env = {
        D1_STATE: db,
        D1_STATE_TABLES: "neuron_daily",
      } as HistoryReadEnv;
      const expected = await rollupChainConcentration(store, {
        nowMs: stamp,
        env,
      });
      assert.deepEqual(await native.pendingDays("2026-11-04", 3), [
        "2026-11-03",
        "2026-11-01",
      ]);
      for (const [day, rows] of captured)
        assert.deepEqual(await native.dailyRows(day), rows);
      assert.equal(captured.get("2026-11-03")!.length, 7);
      assert.deepEqual(
        await rollupChainConcentration(null, { nowMs: stamp, native }),
        expected,
      );
      const pgRows = (
        await control.query(
          "SELECT day,neuron_count::int,card,source_captured_at::float8,computed_at::float8,builder_version::int FROM app.chain_concentration_daily ORDER BY day",
        )
      ).rows;
      assert.deepEqual(
        pgRows,
        await original.query(
          "SELECT * FROM chain_concentration_daily ORDER BY day",
        ),
      );
      assert.deepEqual(await native.pendingDays("2026-11-04", 3), []);
    });

    it("keeps a matched malformed primitive pending and continues other days", async () => {
      await insert("2026-11-03", 1, 0, '{"4":"not-json"}', [[4, "entity"]]);
      await insert(
        "2026-11-02",
        1,
        0,
        '{"1":{"stake_tao":3,"emission_tao":2},"9":"unmatched"}',
        [[1, "entity"]],
      );
      const original = createD1Store(db);
      const env = {
        D1_STATE: db,
        D1_STATE_TABLES: "neuron_daily",
      } as HistoryReadEnv;
      const expected = await rollupChainConcentration(original, {
        nowMs: stamp,
        env,
      });
      assert.deepEqual(
        await rollupChainConcentration(null, { nowMs: stamp, native }),
        expected,
      );
      assert.deepEqual(expected.days_failed, ["2026-11-03"]);
      assert.deepEqual(expected.days_rolled, ["2026-11-02"]);
      assert.deepEqual(await native.pendingDays("2026-11-04", 3), [
        "2026-11-03",
      ]);
    });
  },
);
