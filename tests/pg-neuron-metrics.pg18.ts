import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronMetricStore } from "../src/pg-neuron-metrics.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import {
  readNeuronDailyMetricRows,
  readNeuronPerformanceRows,
} from "../src/neuron-snapshot-read.ts";
import { createD1Store } from "../src/d1-store.ts";
import type { ProducerStore } from "../src/producer-store.ts";
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
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const native = createPgNeuronMetricStore(runtime, decoder);
const binary = new DatabaseSync(":memory:");
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const objects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; name: string; sql: string }[];
const names = new Set([
  "neurons_documents",
  "neurons_members",
  "neurons",
  "neuron_daily_documents",
  "neuron_daily_members",
  "neuron_daily",
]);
let db: D1Database;
let read: ProducerStore;
let sourceEnv: DataApiEnv;
const nativeEnv = { ...dataApiEnv(), NEURON_METRIC_STORE: native };
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
let ownApp = false;

describe(
  "native metric entry reads on PostgreSQL 18.6",
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
      read = createD1Store(db);
      sourceEnv = {
        ...dataApiEnv(),
        D1_STATE: db,
        D1_STATE_TABLES: objects
          .filter((o) => o.type === "table" || o.type === "view")
          .map((o) => o.name)
          .join(",") as DataApiEnv["D1_STATE_TABLES"],
      };
      for (const type of ["table", "view"])
        for (const object of objects.filter(
          (o) => o.type === type && names.has(o.name),
        ))
          await db.prepare(object.sql).run();
      const json =
        '{"2":{"incentive":0.1,"incentive":88,"active":true,"validator_permit":true,"captured_at":1793491200000,"axon":"a\\u0000b"},"02":{"incentive":99},"2":{"incentive":0.2,"active":false,"captured_at":1793491200000},"3":{},"9":"unmatched-primitive"}';
      const payload = binary.prepare("SELECT jsonb(?) AS payload").get(json)!
        .payload as Uint8Array;
      for (const day of ["2026-11-01", "2026-11-02"]) {
        await db
          .prepare(
            "INSERT INTO neuron_daily_documents VALUES(7,?,0,1793491200000,jsonb(?))",
          )
          .bind(day, json)
          .run();
        await control.query(
          "INSERT INTO app.neuron_daily_documents VALUES(7,$1,0,1793491200000,$2)",
          [day, payload],
        );
        for (const uid of [2, 3, 4]) {
          await db
            .prepare(
              "INSERT INTO neuron_daily_members VALUES(7,?,?,?,NULL,0,NULL,0)",
            )
            .bind(uid, day, `member-${uid}`)
            .run();
          await control.query(
            "INSERT INTO app.neuron_daily_members VALUES(7,$1,$2,$3,NULL,0,NULL,false)",
            [uid, day, `member-${uid}`],
          );
        }
      }
      await db
        .prepare(
          "INSERT INTO neurons_documents VALUES(7,'',0,1793491200000,jsonb(?))",
        )
        .bind(json)
        .run();
      await control.query(
        "INSERT INTO app.neurons_documents VALUES(7,'',0,1793491200000,$1)",
        [payload],
      );
      for (const uid of [2, 3, 4]) {
        await db
          .prepare("INSERT INTO neurons_members VALUES(7,?,?,NULL,0)")
          .bind(uid, `member-${uid}`)
          .run();
        await control.query(
          "INSERT INTO app.neurons_members VALUES(7,$1,$2,NULL,0)",
          [uid, `member-${uid}`],
        );
      }
      await db
        .prepare("INSERT INTO neurons_members VALUES(7,5,'wrong-shard',NULL,9)")
        .run();
      await control.query(
        "INSERT INTO app.neurons_members VALUES(7,5,'wrong-shard',NULL,9)",
      );
    });
    after(async () => {
      await runtime.close();
      decoder.close();
      binary.close();
      await source.dispose();
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
    it("preserves live entry multiplicity, member joins and exact source scalars", async () => {
      const expected = await readNeuronPerformanceRows(read, sourceEnv);
      const actual = await readNeuronPerformanceRows(runtime.read, nativeEnv);
      assert.deepEqual(actual, expected);
      assert.equal(actual.length, 4);
      assert.deepEqual(
        actual.map((row) => row.incentive),
        [0.1, 0.2, null, null],
      );
    });
    it("limits memberships before duplicate expansion and preserves all projections", async () => {
      for (const columns of [
        "snapshot_date,uid,hotkey",
        "snapshot_date,uid,incentive,active,axon",
        "snapshot_date,validator_permit,captured_at",
      ])
        for (const cutoff of ["2026-11-01", "2026-11-02", "2099-01-01", null])
          for (const limit of [1, 4, 20]) {
            const expected = await readNeuronDailyMetricRows(
              read,
              sourceEnv,
              7,
              cutoff,
              columns,
              limit,
            );
            const actual = await readNeuronDailyMetricRows(
              runtime.read,
              nativeEnv,
              7,
              cutoff,
              columns,
              limit,
            );
            assert.deepEqual(actual, expected, `${columns}/${cutoff}/${limit}`);
          }
    });
    it("keeps the actual REST performance response bytes", async () => {
      for (const path of [
        "chain/performance",
        "subnets/7/performance/history?window=all",
      ]) {
        const request = new Request(`https://example.com/api/v1/${path}`);
        const expected = await worker.fetch(request.clone(), sourceEnv, ctx);
        const actual = await worker.fetch(request.clone(), nativeEnv, ctx);
        assert.equal(expected.status, 200);
        assert.equal(actual.status, expected.status);
        assert.equal(await actual.text(), await expected.text());
      }
    });
  },
);
