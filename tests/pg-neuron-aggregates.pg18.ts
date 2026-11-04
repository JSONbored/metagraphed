import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronAggregateStore } from "../src/pg-neuron-aggregates.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { readNeuronAggregates } from "../src/neuron-snapshot-read.ts";
import { createD1Store } from "../src/d1-store.ts";
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
const native = createPgNeuronAggregateStore(runtime, codec);
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
  uids: number[],
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
  for (const uid of uids) {
    await db
      .prepare("INSERT INTO neurons_members VALUES(?,?,?,NULL,?)")
      .bind(netuid, uid, `key-${uid}`, shard)
      .run();
    await control.query(
      "INSERT INTO app.neurons_members VALUES($1,$2,$3,NULL,$4)",
      [netuid, uid, `key-${uid}`, shard],
    );
  }
}

async function compare() {
  const expected = await readNeuronAggregates(createD1Store(db), {
    D1_STATE: db,
    D1_STATE_TABLES: "neurons",
  });
  const actual = await readNeuronAggregates(runtime.read, {
    NEURON_AGGREGATE_STORE: native,
  });
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  return actual;
}

describe(
  "native neuron aggregates on PostgreSQL18 and actual D1",
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
    });
    beforeEach(async () => {
      await control.query("TRUNCATE app.neurons_documents,app.neurons_members");
      await db.prepare("DELETE FROM neurons_documents").run();
      await db.prepare("DELETE FROM neurons_members").run();
    });
    after(async () => {
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
    it("counts accepted members separately from canonical duplicate entries and compensated sums", async () => {
      await insert(7, 2, '{"3":{"stake_tao":-1e20,"validator_permit":0}}', [3]);
      await insert(8, 0, "{}", [9]);
      await insert(
        7,
        0,
        '{"1":{"stake_tao":1e20,"validator_permit":1},"01":{"stake_tao":99},"8":"unmatched-primitive"}',
        [1],
      );
      await insert(
        7,
        1,
        '{"2":{"stake_tao":1,"validator_permit":1},"2":{"stake_tao":null,"validator_permit":1}}',
        [2],
      );
      await insert(9, 0, "{}", []);
      assert.deepEqual(await compare(), [
        {
          netuid: 7,
          uid_count: 3,
          validator_count: 3,
          total_stake_alpha: 1,
          max_stake_alpha: 1e20,
        },
        {
          netuid: 8,
          uid_count: 1,
          validator_count: 0,
          total_stake_alpha: null,
          max_stake_alpha: null,
        },
      ]);
    });
    it("preserves numeric coercion, mixed scalar MAX, text NUL and nonfinite wire values", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":"8","validator_permit":"1x"},"2":{"stake_tao":5,"validator_permit":"word"},"3":{"stake_tao":{"x":1},"validator_permit":true}}',
        [1, 2, 3],
      );
      await insert(
        8,
        0,
        '{"1":{"stake_tao":"a\\u0000z"},"2":{"stake_tao":"a\\u0000y"}}',
        [1, 2],
      );
      await insert(
        9,
        0,
        '{"1":{"stake_tao":9e999},"2":{"stake_tao":1}}',
        [1, 2],
      );
      await insert(10, 0, '{"1":{"stake_tao":-0.0}}', [1]);
      // SQL compares the original UTF-8 bytes before the D1 wire replaces the
      // invalid surrogate sequence. Comparing replacement strings reverses MAX.
      await insert(
        11,
        0,
        '{"1":{"stake_tao":"\\ud800"},"2":{"stake_tao":"\\ue000"}}',
        [1, 2],
      );
      await compare();
    });
    it("refuses the same integer overflow and excludes memberships without their document", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":9223372036854775807},"2":{"stake_tao":1}}',
        [1, 2],
      );
      await assert.rejects(
        readNeuronAggregates(createD1Store(db), {
          D1_STATE: db,
          D1_STATE_TABLES: "neurons",
        }),
        /overflow/i,
      );
      await assert.rejects(native.aggregateRows(), /overflow/i);
      await control.query("DELETE FROM app.neurons_documents");
      await db.prepare("DELETE FROM neurons_documents").run();
      assert.deepEqual(await compare(), []);
    });
  },
);
