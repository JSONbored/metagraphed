import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronLiveStore } from "../src/pg-neuron-live.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import {
  readNewestNeuronCapture,
  readNeuronEconomicsRows,
  readNeuronDirectoryRows,
} from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";
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
const native = createPgNeuronLiveStore(runtime, codec);
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

async function compare() {
  const legacy = { D1_STATE: db, D1_STATE_TABLES: "neurons" };
  const env = { NEURON_LIVE_STORE: native };
  const unexpected = {
    unsafe() {
      throw new Error("Unexpected legacy SQL");
    },
  } as unknown as PgSql;
  assert.equal(
    await readNewestNeuronCapture(unexpected, env),
    await readNewestNeuronCapture(unexpected, legacy),
  );
  for (const netuid of [undefined, 0, 7, 8, 999]) {
    const expected = await readNeuronEconomicsRows(
      createD1Store(db),
      legacy,
      netuid,
    );
    const actual = await readNeuronEconomicsRows(runtime.read, env, netuid);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  }
  for (const validators of [false, true]) {
    const expected = await readNeuronDirectoryRows(
      unexpected,
      legacy,
      validators,
    );
    const actual = await readNeuronDirectoryRows(unexpected, env, validators);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  }
}

describe(
  "native live neuron reads on PostgreSQL18 and actual D1",
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
    it("preserves canonical freshness, integer-cast entries, array keys, identities and ordering", async () => {
      await insert(
        7,
        1,
        '{"3":{"stake_tao":5,"validator_permit":1,"captured_at":4}}',
        [3],
      );
      await insert(0, 0, '{"1":{"stake_tao":999,"captured_at":3}}', [1]);
      await insert(
        7,
        0,
        '{"1":{"stake_tao":5,"validator_permit":true,"captured_at":2},"01":{"stake_tao":"8","validator_permit":2,"captured_at":99},"1":{"stake_tao":3,"validator_permit":1.0},"2.9":{"stake_tao":1,"validator_permit":"1"}}',
        [
          [1, "a"],
          [2, null],
        ],
      );
      await insert(
        8,
        0,
        '[{"stake_tao":1,"validator_permit":true,"captured_at":1000},{"active":false}]',
        [
          [0, "a"],
          [1, "b"],
        ],
      );
      await insert(9, 0, "{}", [5]);
      await compare();
    });
    it("preserves multi-path spelling and duplicate nested objects while scalar ordering uses original bytes", async () => {
      await insert(
        7,
        0,
        '{"1":{"stake_tao":"\\ud800","validator_permit":1,"captured_at":"24","take":{"x":1,"x":2},"active":true,"dividends":9e999},"2":{"stake_tao":"\\ue000","validator_permit":true,"captured_at":3,"take":[1,null],"active":false}}',
        [1, 2],
      );
      await insert(
        8,
        0,
        '{"1":{"stake_tao":9007199254740993,"validator_permit":1,"captured_at":-0.0},"2":{"stake_tao":9007199254740992.0,"validator_permit":true,"take":"\\ud800"},"3":{"stake_tao":9e999},"4":{"stake_tao":"a\\u0000b"}}',
        [1, 2, 3, 4],
      );
      await compare();
    });
    it("evaluates the validator predicate before membership, including malformed orphans", async () => {
      await insert(7, 0, '{"1":{},"2":"malformed"}', [1]);
      await insert(8, 0, '"malformed-top-level"', []);
      const legacy = { D1_STATE: db, D1_STATE_TABLES: "neurons" };
      await assert.rejects(native.directoryRows(true), /malformed/i);
      await assert.rejects(
        readNeuronDirectoryRows({} as PgSql, legacy, true),
        /malformed/i,
      );
      assert.deepEqual(
        await native.directoryRows(false),
        await readNeuronDirectoryRows({} as PgSql, legacy, false),
      );
    });
    it("keeps both empty reads and invalid selected metric failures", async () => {
      await compare();
      await insert(7, 0, '{"1":"malformed"}', [1]);
      await assert.rejects(native.newestCapture(), /malformed/i);
      await assert.rejects(
        readNewestNeuronCapture({} as PgSql, {
          D1_STATE: db,
          D1_STATE_TABLES: "neurons",
        }),
        /malformed/i,
      );
      await control.query("UPDATE app.neurons_documents SET payload=$1", [
        binary.prepare("SELECT jsonb(?) AS value").get('{"1":null}')!.value,
      ]);
      await db
        .prepare("UPDATE neurons_documents SET payload=jsonb(?)")
        .bind('{"1":null}')
        .run();
      await assert.rejects(native.economicsRows());
      await assert.rejects(
        readNeuronEconomicsRows(createD1Store(db), {
          D1_STATE: db,
          D1_STATE_TABLES: "neurons",
        }),
      );
    });
  },
);
