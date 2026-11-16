import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronSummaryStore } from "../src/pg-neuron-summaries.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import {
  readCompleteNeuronRows,
  readDirectoryNominatorCounts,
  readNeuronDailyValidators,
  readNeuronDailyTotals,
  readSubnetDailyHistory,
} from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";
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
const native = createPgNeuronSummaryStore(runtime, codec);
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
  day = "",
) {
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  const documents = day ? "neuron_daily_documents" : "neurons_documents";
  const members = day ? "neuron_daily_members" : "neurons_members";
  await db
    .prepare(`INSERT INTO ${documents} VALUES(?,?,?,1793491200000,jsonb(?))`)
    .bind(netuid, day, shard, json)
    .run();
  await control.query(
    `INSERT INTO app.${documents} VALUES($1,$2,$3,1793491200000,$4)`,
    [netuid, day, shard, payload],
  );
  for (const member of uids) {
    const [uid, hotkey] = Array.isArray(member)
      ? member
      : [member, `key-${member}`];
    if (day) {
      await db
        .prepare(`INSERT INTO ${members} VALUES(?,?,?,?,NULL,?,NULL,0)`)
        .bind(netuid, uid, day, hotkey, shard)
        .run();
      await control.query(
        `INSERT INTO app.${members} VALUES($1,$2,$3,$4,NULL,$5,NULL,false)`,
        [netuid, uid, day, hotkey, shard],
      );
    } else {
      await db
        .prepare(`INSERT INTO ${members} VALUES(?,?,?,NULL,?)`)
        .bind(netuid, uid, hotkey, shard)
        .run();
      await control.query(
        `INSERT INTO app.${members} VALUES($1,$2,$3,NULL,$4)`,
        [netuid, uid, hotkey, shard],
      );
    }
  }
}

const legacy = () => ({
  D1_STATE: db,
  D1_STATE_TABLES:
    "neurons,neurons_passes,neuron_daily,validator_nominator_counts",
});
const environment = { NEURON_SUMMARY_STORE: native };
const unexpected = {} as PgSql;
async function compareDaily() {
  const start = "2026-01-01",
    end = "2026-01-02";
  assert.deepEqual(
    await readNeuronDailyValidators(unexpected, environment, start, end),
    await readNeuronDailyValidators(unexpected, legacy(), start, end),
  );
  assert.deepEqual(
    await readNeuronDailyTotals(unexpected, environment, start, end),
    await readNeuronDailyTotals(unexpected, legacy(), start, end),
  );
  for (const [cutoff, limit, before] of [
    [null, 10, null],
    [start, 1, null],
    [start, 10, end],
    [null, 10, end],
  ] as const)
    assert.deepEqual(
      await readSubnetDailyHistory(
        unexpected,
        environment,
        7,
        cutoff,
        limit,
        before,
      ),
      await readSubnetDailyHistory(
        unexpected,
        legacy(),
        7,
        cutoff,
        limit,
        before,
      ),
    );
}
async function compareComplete() {
  const expected = await readCompleteNeuronRows(legacy());
  const actual = await readCompleteNeuronRows(environment);
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  return actual;
}
async function receipt(
  captured: number,
  expected: number,
  received: number,
  completed: number | null,
) {
  await control.query(
    "INSERT INTO app.neurons_passes VALUES($1,$2,$3,$4) ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,received_rows=excluded.received_rows,completed_at=excluded.completed_at",
    [captured, expected, received, completed],
  );
  await db
    .prepare("INSERT OR REPLACE INTO neurons_passes VALUES(?,?,?,?)")
    .bind(captured, expected, received, completed)
    .run();
}

describe(
  "native neuron summaries on PostgreSQL18 and actual D1",
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
      await control.query(
        "CREATE TABLE app.validator_nominator_counts(hotkey text PRIMARY KEY,nominator_count bigint NOT NULL,captured_at bigint NOT NULL)",
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
          [
            "neurons_documents",
            "neurons_members",
            "neuron_daily_documents",
            "neuron_daily_members",
            "neurons_passes",
            "validator_nominator_counts",
          ].includes(row.name),
      ))
        await db.prepare(object.sql).run();
    });
    beforeEach(async () => {
      await control.query(
        "TRUNCATE app.neurons_documents,app.neurons_members,app.neuron_daily_documents,app.neuron_daily_members,app.neurons_passes,app.validator_nominator_counts",
      );
      for (const table of [
        "neurons_documents",
        "neurons_members",
        "neuron_daily_documents",
        "neuron_daily_members",
        "neurons_passes",
        "validator_nominator_counts",
      ])
        await db.prepare(`DELETE FROM ${table}`).run();
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
          "validator_nominator_counts",
        ])
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
      await control.end();
    });
    it("retains daily cast-key multiplicity, strict validators and compensated totals", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":1e20,"emission_tao":1,"validator_permit":true},"01":{"stake_tao":1,"emission_tao":"2x","validator_permit":"1x"},"1":{"stake_tao":-1e20,"validator_permit":1},"3":{"stake_tao":8}}',
        [1, 2],
        "2026-01-01",
      );
      await insert(
        7,
        1,
        '[{"stake_tao":2,"validator_permit":true}]',
        [[0, null]],
        "2026-01-02",
      );
      await insert(
        8,
        0,
        '{"1":{"stake_tao":null,"emission_tao":3,"validator_permit":0}}',
        [1],
        "2026-01-02",
      );
      await insert(7, 0, '{"1":{"stake_tao":99}}', [1], "2026-01-03");
      await compareDaily();
    });
    it("retains receipt-backed completeness and refuses partial newer captures", async () => {
      const capture = 1000000000000;
      await insert(
        7,
        0,
        `{"1":{"captured_at":${capture},"block_number":2},"01":{"captured_at":${capture},"block_number":3}}`,
        [1],
      );
      await receipt(capture, 2, 2, capture);
      assert.deepEqual(await compareComplete(), [
        { netuid: 7, block_number: 3 },
      ]);
      await receipt(capture, 1, 2, capture);
      assert.deepEqual(await compareComplete(), []);
      await receipt(capture, 2, 1, capture);
      assert.deepEqual(await compareComplete(), []);
      await receipt(capture, 2, 2, null);
      assert.deepEqual(await compareComplete(), []);
      await receipt(capture, 2, 2, capture);
      await insert(
        8,
        0,
        `{"2":{"captured_at":${capture + 1},"block_number":4}}`,
        [2],
      );
      assert.deepEqual(await compareComplete(), []);
    });
    it("compares capture values before wire conversion and applies receipt numeric affinity", async () => {
      const capture = 1000000000000;
      await receipt(capture, 1, 1, capture);
      await insert(
        7,
        0,
        `{"1":{"captured_at":" ${capture} ","block_number":"\\ud800"}}`,
        [1],
      );
      await compareComplete();
      const json = '{"1":{"captured_at":"1x","block_number":4}}';
      await control.query("UPDATE app.neurons_documents SET payload=$1", [
        binary.prepare("SELECT jsonb(?) AS value").get(json)!.value,
      ]);
      await db
        .prepare("UPDATE neurons_documents SET payload=jsonb(?)")
        .bind(json)
        .run();
      assert.deepEqual(await compareComplete(), []);
    });
    it("uses whole-table nominator stamp, deduplicates input keys and preserves missing values", async () => {
      for (const [key, count, stamp] of [
        ["a", 0, 2],
        ["b", 4, 3],
        ["unrequested", 99, 8],
      ] as const) {
        await control.query(
          "INSERT INTO app.validator_nominator_counts VALUES($1,$2,$3)",
          [key, count, stamp],
        );
        await db
          .prepare("INSERT INTO validator_nominator_counts VALUES(?,?,?)")
          .bind(key, count, stamp)
          .run();
      }
      for (const keys of [[], ["b", "missing", "a", "b"]])
        assert.deepEqual(
          await readDirectoryNominatorCounts(unexpected, environment, keys),
          await readDirectoryNominatorCounts(unexpected, legacy(), keys),
        );
    });
    it("preserves integer overflow and malformed orphan validator predicate failures", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":9223372036854775807},"2":{"stake_tao":1}}',
        [1, 2],
        "2026-01-01",
      );
      await assert.rejects(
        native.dailyTotals("2026-01-01", "2026-01-02"),
        /overflow/i,
      );
      await assert.rejects(
        readNeuronDailyTotals(unexpected, legacy(), "2026-01-01", "2026-01-02"),
        /overflow/i,
      );
      await insert(8, 0, '{"1":"malformed"}', [], "2026-01-01");
      await assert.rejects(
        native.dailyValidators("2026-01-01", "2026-01-02"),
        /malformed/i,
      );
      await assert.rejects(
        readNeuronDailyValidators(
          unexpected,
          legacy(),
          "2026-01-01",
          "2026-01-02",
        ),
        /malformed/i,
      );
    });
  },
);
