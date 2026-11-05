import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { before, beforeEach, after, describe, it, mock } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgSubnetEnrichmentStore } from "../src/pg-subnet-enrichment.ts";
import { createPgNeuronDailyViewStore } from "../src/pg-neuron-daily-view.ts";
import { createPgNeuronViewStore } from "../src/pg-neuron-view.ts";
import { createPgNeuronSnapshotStore } from "../src/pg-neuron-snapshot.ts";
import { createPgNeuronMetricStore } from "../src/pg-neuron-metrics.ts";
import worker from "../workers/data-api.ts";
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
  maxConnections: 8,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1048576 });
const binary = new DatabaseSync(":memory:");
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database,
  ownApp = false;
const stamp = 1793491200000;
const relationMigrations = [
  ["subnet_snapshots", "0022_closed_day_revisions.sql"],
  ["subnet_ownership", "0012_economic_history.sql"],
  ["compute_declarations", "0012_economic_history.sql"],
  ["treasury_readings", "0012_economic_history.sql"],
  ["tao_usd_index", "0012_economic_history.sql"],
  ["nominator_positions", "0014_account_observations.sql"],
];
const docTables = [
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
];
const tables =
  "neurons,neurons_passes,neuron_daily,account_position_daily,subnet_snapshots,subnet_ownership,subnet_hyperparams,validator_nominator_counts,nominator_positions,tao_usd_index,treasury_readings,compute_declarations";
const enrichment = createPgSubnetEnrichmentStore(runtime, decoder);
function nativeEnv(store = enrichment) {
  return {
    ...dataApiEnv(),
    SUBNET_ENRICHMENT_STORE: store,
    NEURON_DAILY_VIEW_STORE: createPgNeuronDailyViewStore(runtime, decoder),
    NEURON_VIEW_STORE: createPgNeuronViewStore(runtime, decoder),
    NEURON_SNAPSHOT_STORE: createPgNeuronSnapshotStore(runtime, decoder),
    NEURON_METRIC_STORE: createPgNeuronMetricStore(runtime, decoder),
  };
}
function sourceEnv() {
  return dataApiEnv({ D1_STATE: db, D1_STATE_TABLES: tables });
}
const ctx = { waitUntil() {} };
const routes = [
  "concentration/history",
  "miner-fairness",
  "emission-split/history",
  "owner-capture",
  "cost-to-participate",
  "treasury",
];
async function compare() {
  for (const route of routes) {
    const request = new Request(
      `https://example.com/api/v1/subnets/7/${route}`,
    );
    const expected = await worker.fetch(request.clone(), sourceEnv(), ctx);
    const actual = await worker.fetch(request, nativeEnv(), ctx);
    assert.equal(actual.status, expected.status, route);
    assert.equal(await actual.text(), await expected.text(), route);
  }
}
async function insert(day: string, shard = 0, uids = [1, 2]) {
  const live = day === "";
  const documents = live ? "neurons_documents" : "neuron_daily_documents";
  const members = live ? "neurons_members" : "neuron_daily_members";
  const json = `{"${uids[0]}":{"validator_permit":1,"emission_tao":2,"take":0.1,"incentive":0.4,"captured_at":${stamp},"block_number":100},"${uids[0]}":{"validator_permit":0,"emission_tao":999},"${uids[1]}":{"validator_permit":0,"emission_tao":1,"incentive":0.6,"captured_at":${stamp},"block_number":100}}`;
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  await db
    .prepare(`INSERT INTO ${documents} VALUES(7,?,?,?,jsonb(?))`)
    .bind(day, shard, stamp, json)
    .run();
  await control.query(`INSERT INTO app.${documents} VALUES(7,$1,$2,$3,$4)`, [
    day,
    shard,
    stamp,
    payload,
  ]);
  for (const uid of uids) {
    const values = live
      ? [7, uid, `hot-${uid}`, uid === uids[0] ? "owner" : "foreign", shard]
      : [
          7,
          day,
          uid,
          `hot-${uid}`,
          uid === uids[0] ? "owner" : "foreign",
          shard,
        ];
    await db
      .prepare(
        `INSERT INTO ${members}(${live ? "netuid,uid,hotkey,coldkey,shard" : "netuid,snapshot_date,uid,hotkey,coldkey,shard"}) VALUES(${values.map(() => "?").join(",")})`,
      )
      .bind(...values)
      .run();
    await control.query(
      `INSERT INTO app.${members}(${live ? "netuid,uid,hotkey,coldkey,shard" : "netuid,snapshot_date,uid,hotkey,coldkey,shard"}) VALUES(${values.map((_, index) => `$${index + 1}`).join(",")})`,
      values,
    );
  }
}
async function seed() {
  await insert("");
  await insert("2026-10-15");
  await insert("2026-11-01");
  for (const prefix of ["", "app."]) {
    const query = async (sql: string) =>
      prefix ? control.query(sql) : db.prepare(sql).run();
    await query(
      `INSERT INTO ${prefix}subnet_snapshots(netuid,snapshot_date,alpha_out_emission,alpha_price_tao,miner_burned_fraction) VALUES(7,'2026-11-01',100,2,0.1)`,
    );
    await query(
      `INSERT INTO ${prefix}subnet_ownership(netuid,owner_hotkey,owner_coldkey,captured_at) VALUES(7,'hot-2','owner',${stamp})`,
    );
    await query(
      `INSERT INTO ${prefix}nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES('owner','hot-1',7,0.5,${stamp}),('foreign','hot-1',7,0.5,${stamp}),('old','old-hot',7,1,${stamp - 1})`,
    );
    await query(
      `INSERT INTO ${prefix}tao_usd_index(block_number,observed_at,usd_per_tao,price_basis,pool_count,pools) VALUES(99,${stamp - 60000},300,'wrapped_onchain_median',1,'[]'),(100,${stamp - 60000},320,'wrapped_onchain_median',1,'[]'),(101,${stamp},340,'wrapped_onchain_median',1,'[]')`,
    );
    await query(
      `INSERT INTO ${prefix}compute_declarations(netuid,source_url,read_at_sha,observed_at,first_seen,found,spec_version) VALUES(7,'https://example.com/source','revision',${stamp},${stamp},${prefix ? "false" : "0"},'1')`,
    );
    await query(
      `INSERT INTO ${prefix}treasury_readings(netuid,source_url,read_at_sha,observed_at,first_seen,found,declared_share,review_state,reviewed_at) VALUES(7,'https://example.com/source','revision',${stamp},${stamp},${prefix ? "true" : "1"},0.1,'reviewed',${stamp})`,
    );
  }
}

describe(
  "native subnet economics on PostgreSQL18 and actual D1",
  { concurrency: false },
  () => {
    before(async () => {
      mock.timers.enable({ apis: ["Date"], now: stamp });
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
      const migration = (name: string) =>
        readFileSync(
          new URL(`../migrations/postgres/${name}`, import.meta.url),
          "utf8",
        );
      await control.query(migration("0024_neuron_documents.sql"));
      for (const [name, file] of relationMigrations) {
        const definition = migration(file).match(
          new RegExp(`CREATE TABLE app\\.${name} \\([\\s\\S]*?\\n\\);`),
        );
        assert.ok(definition, name);
        await control.query(definition[0]);
      }
      db = await source.getD1Database("DB");
      const root = new URL("../migrations/d1/", import.meta.url);
      for (const file of readdirSync(root)
        .filter((name) => name.endsWith(".sql"))
        .sort())
        for (const sql of readFileSync(new URL(file, root), "utf8").split(
          "-- statement-breakpoint",
        ))
          if (sql.trim()) await db.prepare(sql).run();
    });
    beforeEach(async () => {
      for (const name of [
        "neurons_documents",
        "neurons_members",
        "neuron_daily_documents",
        "neuron_daily_members",
        ...relationMigrations.map(([name]) => name),
      ]) {
        await control.query(`DELETE FROM app.${name}`);
        await db.prepare(`DELETE FROM ${name}`).run();
      }
    });
    after(async () => {
      mock.timers.reset();
      await source.dispose();
      decoder.close();
      binary.close();
      await runtime.close();
      if (ownApp) await control.query("DROP SCHEMA app CASCADE");
      else
        for (const name of [
          ...relationMigrations.map(([name]) => name),
          ...docTables,
        ])
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
      await control.end();
    });
    it("matches cold economics and history routes", compare);
    it("matches duplicate-key rows, missing daily snapshots, burn and owner enrichment", async () => {
      await seed();
      const sourcePositions = await db
        .prepare(
          "SELECT np.coldkey,np.hotkey,np.share_fraction FROM nominator_positions np WHERE np.netuid=7 AND np.captured_at=(SELECT MAX(captured_at) FROM nominator_positions WHERE netuid=7)",
        )
        .all();
      assert.deepEqual(
        await enrichment.ownerPositions(7),
        sourcePositions.results,
      );
      await compare();
    });
    it("retains the source cap boundary across multiple shards", async () => {
      await seed();
      await insert("2026-11-01", 1, [0, 3]);
      const expected = await db
        .prepare(
          "SELECT nd.snapshot_date,nd.uid,nd.hotkey,nd.validator_permit,nd.emission_tao,ss.alpha_out_emission,ss.alpha_price_tao FROM neuron_daily nd LEFT JOIN subnet_snapshots ss ON ss.netuid=nd.netuid AND ss.snapshot_date=nd.snapshot_date WHERE nd.netuid=7 AND nd.snapshot_date>='2026-10-01' ORDER BY nd.snapshot_date DESC LIMIT 2",
        )
        .all();
      assert.deepEqual(
        await enrichment.dailyRows(7, "2026-10-01", "emission", 2),
        expected.results,
      );
      const concentration = await db
        .prepare(
          "SELECT snapshot_date,stake_tao,emission_tao FROM neuron_daily WHERE netuid=7 AND snapshot_date>='2026-10-01' ORDER BY snapshot_date DESC LIMIT 2",
        )
        .all();
      const canonical = createPgNeuronDailyViewStore(runtime, decoder);
      assert.deepEqual(
        await canonical.rows({
          netuid: 7,
          fromDay: "2026-10-01",
          columns: ["snapshot_date", "stake_tao", "emission_tao"],
          sameDayOrder: "shard",
          limit: 2,
        }),
        concentration.results,
      );
    });
    it("keeps joined metadata on the same snapshot during a concurrent update", async () => {
      await seed();
      let updated = false;
      const transaction: typeof runtime.transaction = (callback, options) =>
        runtime.transaction(
          (scope) =>
            callback({
              ...scope,
              async query<Row>(sql: string, values?: unknown[]) {
                const rows = await scope.query<Row>(sql, values);
                if (!updated && sql.includes("WITH selected")) {
                  updated = true;
                  await control.query(
                    "UPDATE app.subnet_snapshots SET alpha_out_emission=999 WHERE netuid=7",
                  );
                }
                return rows;
              },
            }),
          options,
        );
      const isolated = createPgSubnetEnrichmentStore(
        { ...runtime, transaction },
        decoder,
      );
      const expected = await db
        .prepare(
          "SELECT nd.snapshot_date,nd.uid,nd.hotkey,nd.validator_permit,nd.emission_tao,ss.alpha_out_emission,ss.alpha_price_tao FROM neuron_daily nd LEFT JOIN subnet_snapshots ss ON ss.netuid=nd.netuid AND ss.snapshot_date=nd.snapshot_date WHERE nd.netuid=7 AND nd.snapshot_date>='2026-10-01' ORDER BY nd.snapshot_date DESC,nd.uid LIMIT 50000",
        )
        .all();
      assert.deepEqual(
        await isolated.dailyRows(7, "2026-10-01", "emission", 50000),
        expected.results,
      );
      assert.equal(updated, true);
    });
  },
);
