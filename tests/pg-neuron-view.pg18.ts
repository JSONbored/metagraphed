import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronViewStore } from "../src/pg-neuron-view.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
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
  maxConnections: 2,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const codec = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const binary = new DatabaseSync(":memory:");
const native = createPgNeuronViewStore(runtime, codec);
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let ownApp = false;

async function insert(
  netuid: number,
  shard: number,
  json: string,
  uids: (number | [number, string | null])[],
) {
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  await db
    .prepare(
      "INSERT INTO neurons_documents VALUES(?,'',?,1793491200000,jsonb(?))",
    )
    .bind(netuid, shard, json)
    .run();
  await control.query(
    "INSERT INTO app.neurons_documents VALUES($1,'',$2,1793491200000,$3)",
    [netuid, shard, payload],
  );
  for (const member of uids) {
    const [uid, hotkey] = Array.isArray(member)
      ? member
      : [member, `key-${member}`];
    await db
      .prepare("INSERT INTO neurons_members VALUES(?,?,?,NULL,?)")
      .bind(netuid, uid, hotkey, shard)
      .run();
    await control.query(
      "INSERT INTO app.neurons_members VALUES($1,$2,$3,NULL,$4)",
      [netuid, uid, hotkey, shard],
    );
  }
}

const paths = [
  "subnets/7/neurons/1",
  "subnets/7/neurons/999",
  "subnets/7/validators",
  "subnets/7/concentration",
  "subnets/7/performance",
  "subnets/7/idle-stake",
  "subnets/7/yield",
  "chain/concentration",
  "chain/idle-stake",
  "chain/yield",
  "accounts/key-1/subnets",
];
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
async function compare() {
  const sourceEnv = {
    ...dataApiEnv(),
    D1_STATE: db,
    D1_STATE_TABLES:
      "neurons,neurons_passes,neuron_daily,account_position_daily,subnet_snapshots,subnet_ownership,subnet_hyperparams,validator_nominator_counts,nominator_positions,tao_usd_index,treasury_readings",
  } as unknown as DataApiEnv;
  const nativeEnv = { ...dataApiEnv(), NEURON_VIEW_STORE: native };
  for (const path of paths) {
    const request = new Request(`https://example.com/api/v1/${path}`);
    const expected = await worker.fetch(request.clone(), sourceEnv, ctx);
    const actual = await worker.fetch(request.clone(), nativeEnv, ctx);
    assert.equal(actual.status, expected.status, path);
    assert.equal(await actual.text(), await expected.text(), path);
  }
}

describe(
  "native canonical-view routes on PostgreSQL18 and actual D1",
  { concurrency: false },
  () => {
    before(async () => {
      mock.timers.enable({ apis: ["Date"], now: 1793491200000 });
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
      for (const object of objects.filter(
        (row) =>
          row.type === "table" &&
          ["neurons_documents", "neurons_members"].includes(row.name),
      ))
        await db.prepare(object.sql).run();
      await db
        .prepare(
          objects.find((row) => row.type === "view" && row.name === "neurons")!
            .sql,
        )
        .run();
    });
    beforeEach(async () => {
      await control.query("TRUNCATE app.neurons_documents,app.neurons_members");
      await db.prepare("DELETE FROM neurons_documents").run();
      await db.prepare("DELETE FROM neurons_members").run();
    });
    after(async () => {
      mock.timers.reset();
      await source.dispose();
      codec.close();
      binary.close();
      await runtime.close();
      if (ownApp) await control.query("DROP SCHEMA app CASCADE");
      else
        for (const name of [
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
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
      await control.end();
    });
    it("matches actual route bytes for canonical first values, primitive members and missing metrics", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":5,"validator_permit":1,"emission_tao":2,"active":1,"dividends":0.1,"captured_at":1793491200000},"1":{"stake_tao":999},"01":{"stake_tao":888},"2":"not-json","3":null,"4":[]}',
        [1, 2, 3, 4, 5],
      );
      await insert(
        8,
        0,
        '{"1":{"stake_tao":2,"validator_permit":0,"captured_at":1793491200000}}',
        [1],
      );
      await insert(
        0,
        0,
        '{"1":{"stake_tao":1,"validator_permit":1,"captured_at":1793491200000}}',
        [1],
      );
      await compare();
    });
    it("retains account membership tie order across noncanonical shard placement", async () => {
      await insert(7, 0, '{"3":{"stake_tao":3,"active":1}}', [[3, "shared"]]);
      await insert(7, 1, '{"1":{"stake_tao":1,"active":1}}', [[1, "shared"]]);
      const expected = await db
        .prepare(
          "SELECT netuid,uid,stake_tao,validator_permit,active FROM neurons WHERE hotkey=? ORDER BY netuid",
        )
        .bind("shared")
        .all();
      assert.deepEqual(
        await native.rows({
          columns: ["netuid", "uid", "stake_tao", "validator_permit", "active"],
          hotkey: "shared",
          order: [{ column: "netuid" }],
        }),
        expected.results,
      );
    });
    it("retains empty-route behavior", async () => {
      await compare();
    });
    it("preserves exact raw scalar ordering before the wire boundary", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":9007199254740993,"validator_permit":1},"2":{"stake_tao":9007199254740992.0,"validator_permit":1},"3":{"stake_tao":"a\\u0000b","validator_permit":1},"4":{"stake_tao":"\\ud800","validator_permit":1},"5":{"stake_tao":"\\ue000","validator_permit":1}}',
        [1, 2, 3, 4, 5],
      );
      const expected = await db
        .prepare(
          "SELECT uid,stake_tao FROM neurons WHERE netuid=7 AND validator_permit=TRUE ORDER BY stake_tao DESC,uid",
        )
        .all();
      assert.deepEqual(
        await native.rows({
          columns: ["uid", "stake_tao"],
          netuid: 7,
          validatorsOnly: true,
          order: [{ column: "stake_tao", descending: true }, { column: "uid" }],
        }),
        expected.results,
      );
      const none = await native.rows({
        columns: ["uid"],
        hotkey: "key-1\0suffix",
      });
      assert.deepEqual(none, []);
    });
  },
);
