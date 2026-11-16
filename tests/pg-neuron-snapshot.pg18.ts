import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronSnapshotStore } from "../src/pg-neuron-snapshot.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { readSubnetNeuronRows } from "../src/neuron-snapshot-read.ts";
import {
  createD1Sql,
  createD1Store,
  type D1StoreBinding,
} from "../src/d1-store.ts";
import worker, { loadSubnetSnapshotCards } from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const url = pg18FixtureUrl().toString();
const control = new Client({
  connectionString: url,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const runtime = createPgStoreRuntime({
  connectionString: url,
  maxConnections: 2,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const native = createPgNeuronSnapshotStore(runtime, decoder);
const source = new DatabaseSync(":memory:");
const objects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; name: string; sql: string }[];
const sourceNames = new Set([
  "neurons_documents",
  "neurons_members",
  "subnet_ownership",
  "subnet_snapshots",
]);
const binding = {
  prepare(text: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...supplied: (string | number | null)[]) {
        values = supplied;
        return this;
      },
      async all() {
        return {
          results: source.prepare(text).all(...values),
          success: true,
          meta: {},
        };
      },
    };
  },
  batch() {
    throw new Error("Read fixture does not accept writes");
  },
} as unknown as D1StoreBinding;
const sourceSql = createD1Sql(createD1Store(binding));
const sourceEnv = {
  ...dataApiEnv(),
  D1_STATE: binding as unknown as D1Database,
  D1_STATE_TABLES: objects
    .filter((item) => item.type === "table" || item.type === "view")
    .map((item) => item.name)
    .join(",") as DataApiEnv["D1_STATE_TABLES"],
};
const nativeEnv = { ...dataApiEnv(), NEURON_SNAPSHOT_STORE: native };
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
let ownApp = false;

describe(
  "native subnet snapshot handlers on PostgreSQL 18.6",
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
      for (const name of [
        "0012_economic_history.sql",
        "0022_closed_day_revisions.sql",
        "0024_neuron_documents.sql",
      ])
        await control.query(
          readFileSync(
            new URL(`../migrations/postgres/${name}`, import.meta.url),
            "utf8",
          ),
        );
      for (const object of objects.filter(
        (item) => item.type === "table" && sourceNames.has(item.name),
      ))
        source.exec(object.sql);
      const json =
        '{"1":{"validator_permit":1,"stake_tao":1},"1":{"validator_permit":0,"stake_tao":9,"active":1},"2":{"validator_permit":1,"stake_tao":null,"active":1},"99":{"validator_permit":1,"stake_tao":999}}';
      const payload = source.prepare("SELECT jsonb(?) AS payload").get(json)!
        .payload as Uint8Array;
      source
        .prepare("INSERT INTO neurons_documents VALUES(7,'',0,1000000000000,?)")
        .run(payload);
      await control.query(
        "INSERT INTO app.neurons_documents VALUES(7,'',0,1000000000000,$1)",
        [payload],
      );
      for (const [uid, hotkey, coldkey, shard] of [
        [2, "hot-2", null, 0],
        [1, "hot-1", "cold", 0],
        [3, "missing-shard", null, 9],
      ] as const) {
        source
          .prepare("INSERT INTO neurons_members VALUES(7,?,?,?,?)")
          .run(uid, hotkey, coldkey, shard);
        await control.query(
          "INSERT INTO app.neurons_members VALUES(7,$1,$2,$3,$4)",
          [uid, hotkey, coldkey, shard],
        );
      }
      source.exec(
        "INSERT INTO subnet_ownership(netuid,owner_hotkey,owner_coldkey,captured_at) VALUES(7,'hot-1','cold',1000); INSERT INTO subnet_snapshots(netuid,snapshot_date,miner_burned_fraction) VALUES(7,'2001-01-01',0.25)",
      );
      await control.query(
        "INSERT INTO app.subnet_ownership(netuid,owner_hotkey,owner_coldkey,captured_at) VALUES(7,'hot-1','cold',1000); INSERT INTO app.subnet_snapshots(netuid,snapshot_date,miner_burned_fraction) VALUES(7,'2001-01-01',0.25)",
      );
    });
    after(async () => {
      try {
        await runtime.close();
        if (ownApp) await control.query("DROP SCHEMA app CASCADE");
      } finally {
        await control.end();
        decoder.close();
        source.close();
      }
    });

    it("matches the existing D1 snapshot helper for last-key, filter and empty semantics", async () => {
      for (const netuid of [7, 8])
        for (const validatorsOnly of [false, true]) {
          assert.deepEqual(
            await readSubnetNeuronRows(
              runtime.sql,
              nativeEnv,
              netuid,
              validatorsOnly,
            ),
            await readSubnetNeuronRows(
              sourceSql,
              sourceEnv,
              netuid,
              validatorsOnly,
            ),
          );
        }
    });

    it("preserves byte-identical REST bodies and compound snapshot cards", async () => {
      for (const suffix of ["", "?validator_permit=true"]) {
        const request = () =>
          new Request(
            `https://example.com/api/v1/subnets/7/metagraph${suffix}`,
          );
        const expected = await worker.fetch(request(), sourceEnv, ctx);
        const observed = await worker.fetch(request(), nativeEnv, ctx);
        assert.equal(expected.status, 200);
        assert.equal(observed.status, expected.status);
        assert.equal(await observed.text(), await expected.text());
      }
      assert.deepEqual(
        await loadSubnetSnapshotCards(runtime.sql, nativeEnv, 7),
        await loadSubnetSnapshotCards(sourceSql, sourceEnv, 7),
      );
      assert.equal(await native.burnHotkey(7), "hot-1");
      assert.equal(await native.burnHotkey(8), null);
    });

    it("maps native read failure to the existing opaque REST error", async () => {
      await control.query(
        "ALTER TABLE app.neurons_documents RENAME TO unavailable_documents",
      );
      try {
        const response = await worker.fetch(
          new Request("https://example.com/api/v1/subnets/7/metagraph"),
          nativeEnv,
          ctx,
        );
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: "data query failed" });
      } finally {
        await control.query(
          "ALTER TABLE app.unavailable_documents RENAME TO neurons_documents",
        );
      }
    });
  },
);
