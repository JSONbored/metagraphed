import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronDailyViewStore } from "../src/pg-neuron-daily-view.ts";
import { createPgNeuronMetricStore } from "../src/pg-neuron-metrics.ts";
import { createPgNeuronSummaryStore } from "../src/pg-neuron-summaries.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import worker, { neuronDailyWindowBounds } from "../workers/data-api.ts";
import { createD1Sql, createD1Store } from "../src/d1-store.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
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
const codec = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const binary = new DatabaseSync(":memory:");
const native = createPgNeuronDailyViewStore(runtime, codec);
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let ownApp = false;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const routes = [
  "subnets/7/concentration/history",
  "subnets/7/turnover",
  "subnets/7/turnover?window=all&changes=true",
  "subnets/7/history",
  "subnets/7/history?window=all",
  "subnets/7/yield/history",
  "chain/turnover",
  "subnets/movers",
  "subnets/7/turnover?window=invalid&changes=true",
  "chain/turnover?window=invalid&limit=",
  "subnets/movers?window=invalid&limit=3",
];

async function insert(
  day: string,
  netuid: number,
  shard: number,
  json: string,
  uids: number[],
) {
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  await db
    .prepare(
      "INSERT INTO neuron_daily_documents VALUES(?,?,?,1793491200000,jsonb(?))",
    )
    .bind(netuid, day, shard, json)
    .run();
  await control.query(
    "INSERT INTO app.neuron_daily_documents VALUES($1,$2,$3,1793491200000,$4)",
    [netuid, day, shard, payload],
  );
  for (const uid of uids) {
    await db
      .prepare(
        "INSERT INTO neuron_daily_members VALUES(?,?,?, ?,NULL,?,NULL,0)",
      )
      .bind(netuid, uid, day, `key-${uid}`, shard)
      .run();
    await control.query(
      "INSERT INTO app.neuron_daily_members VALUES($1,$2,$3,$4,NULL,$5,NULL,false)",
      [netuid, uid, day, `key-${uid}`, shard],
    );
  }
}
async function compareRoutes() {
  const legacy = dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES:
      "neurons,neurons_passes,neuron_daily,account_position_daily,subnet_snapshots,subnet_ownership,subnet_hyperparams,validator_nominator_counts,nominator_positions,tao_usd_index,treasury_readings",
  });
  const environment = {
    ...dataApiEnv(),
    NEURON_DAILY_VIEW_STORE: native,
    NEURON_SUMMARY_STORE: createPgNeuronSummaryStore(runtime, codec),
    NEURON_METRIC_STORE: createPgNeuronMetricStore(runtime, codec),
  };
  for (const path of routes) {
    const request = new Request(`https://example.com/api/v1/${path}`);
    const expected = await worker.fetch(request.clone(), legacy, ctx);
    const actual = await worker.fetch(request.clone(), environment, ctx);
    assert.equal(actual.status, expected.status, path);
    assert.equal(await actual.text(), await expected.text(), path);
  }
}

describe(
  "canonical daily view and data-anchored routes on PostgreSQL18 and D1",
  { concurrency: false },
  () => {
    before(async () => {
      mock.timers.enable({ apis: ["Date"], now: 1793577600000 });
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
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0024_neuron_documents.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      db = await source.getD1Database("DB");
      const objects = JSON.parse(
        readFileSync(
          new URL("../generated/db/d1-schema.json", import.meta.url),
          "utf8",
        ),
      ) as { type: string; name: string; sql: string }[];
      for (const type of ["table", "view"])
        for (const object of objects.filter(
          (row) =>
            row.type === type &&
            [
              "neuron_daily_documents",
              "neuron_daily_members",
              "neuron_daily",
            ].includes(row.name),
        ))
          await db.prepare(object.sql).run();
    });
    beforeEach(async () => {
      await control.query(
        "TRUNCATE app.neuron_daily_documents,app.neuron_daily_members",
      );
      await db.prepare("DELETE FROM neuron_daily_documents").run();
      await db.prepare("DELETE FROM neuron_daily_members").run();
    });
    after(async () => {
      mock.timers.reset();
      await source.dispose();
      codec.close();
      binary.close();
      await runtime.close();
      if (ownApp) await control.query("DROP SCHEMA app CASCADE");
      else
        for (const table of [
          "_audit_neuron_docs_20260922",
          "_audit_neuron_members_20260922",
          "neurons_documents",
          "neurons_members",
          "neuron_daily_documents",
          "neuron_daily_members",
          "account_position_daily_documents",
          "account_position_daily_members",
          "neurons_capture_batches",
          "neurons_passes",
          "neuron_document_projections",
        ])
          await control.query(`DROP TABLE IF EXISTS app.${table} CASCADE`);
      await control.end();
    });
    it("matches empty history and no-window behavior", async () => {
      await compareRoutes();
    });
    it("matches sparse-day windows, first-key rows and route bytes beside optimized readers", async () => {
      for (const day of ["2026-10-24", "2026-10-31", "2026-11-01"]) {
        await insert(
          day,
          7,
          0,
          '{"8":{"stake_tao":4,"emission_tao":0.75,"validator_permit":0,"captured_at":1793491200000}}',
          [8],
        );
        await insert(
          day,
          7,
          1,
          '{"1":{"stake_tao":2,"emission_tao":0.5,"validator_permit":1,"captured_at":1793491200000},"1":{"stake_tao":9,"emission_tao":1,"validator_permit":1},"01":{"stake_tao":50},"2":null,"3":[]}',
          [1, 2, 3, 4],
        );
        await insert(
          day,
          8,
          0,
          '{"1":{"stake_tao":3,"emission_tao":0.25,"validator_permit":1,"captured_at":1793491200000}}',
          [1],
        );
      }
      await compareRoutes();
      const sql = createD1Sql(createD1Store(db));
      for (const days of [null, 0, 7, 30])
        for (const netuid of [undefined, 7, 9])
          assert.deepEqual(
            await native.window(days, netuid),
            await neuronDailyWindowBounds(sql, days, netuid ?? null),
          );
      for (const oldestFirst of [false, true])
        for (const limit of [1, 3, 50]) {
          const order = oldestFirst ? "ASC" : "DESC";
          const expected = await db
            .prepare(
              `SELECT snapshot_date,uid,hotkey,stake_tao FROM neuron_daily WHERE netuid=7 ORDER BY snapshot_date ${order}${oldestFirst ? ",uid" : ""} LIMIT ?`,
            )
            .bind(limit)
            .all();
          assert.deepEqual(
            await native.rows({
              netuid: 7,
              columns: ["snapshot_date", "uid", "hotkey", "stake_tao"],
              oldestFirst,
              limit,
            }),
            expected.results,
          );
        }
    });
    it("retains source window behavior for non-ISO stored dates", async () => {
      await insert("invalid-day", 7, 0, '{"1":{}}', [1]);
      await insert("2026-10-31", 7, 0, '{"1":{}}', [1]);
      const sql = createD1Sql(createD1Store(db));
      assert.deepEqual(
        await native.window(7, 7),
        await neuronDailyWindowBounds(sql, 7, 7),
      );
    });
  },
);
