import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronViewStore } from "../src/pg-neuron-view.ts";
import { createPgNeuronLiveStore } from "../src/pg-neuron-live.ts";
import { createPgNeuronSummaryStore } from "../src/pg-neuron-summaries.ts";
import { createPgValidatorEnrichmentStore } from "../src/pg-validator-enrichment.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import worker, {
  refreshExplorerDirectoryMaterialization,
} from "../workers/data-api.ts";
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
const codec = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const binary = new DatabaseSync(":memory:");
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let ownApp = false;
const stamp = 1793491200000;
const relational = [
  "subnet_snapshots",
  "subnet_hyperparams",
  "account_identity",
  "validator_nominator_counts",
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
  "neurons,neurons_passes,neuron_daily,account_position_daily,subnet_snapshots,subnet_ownership,subnet_hyperparams,validator_nominator_counts,nominator_positions,tao_usd_index,treasury_readings,account_identity";
const view = createPgNeuronViewStore(runtime, codec);
const live = createPgNeuronLiveStore(runtime, codec);
const summary = createPgNeuronSummaryStore(runtime, codec);
const enrichment = createPgValidatorEnrichmentStore(runtime);
function nativeEnv(extra = {}) {
  return {
    ...dataApiEnv(),
    NEURON_VIEW_STORE: view,
    NEURON_LIVE_STORE: live,
    NEURON_SUMMARY_STORE: summary,
    VALIDATOR_ENRICHMENT_STORE: enrichment,
    ...extra,
  };
}
function sourceEnv(extra = {}) {
  return dataApiEnv({ D1_STATE: db, D1_STATE_TABLES: tables, ...extra });
}
const paths = [
  "validators/key-1",
  "validators/missing",
  "validators/key-1%00suffix",
  "validators/%ED%A0%80",
  "validators",
  "validators?sort=emission&limit=1",
  "validators?sort=bad&limit=-1",
  "validators/operators",
  "accounts",
  "accounts?sort=reach&limit=2",
  "accounts/directory",
  "accounts/key-1/portfolio",
  "accounts/missing/portfolio",
  "accounts/key-1%00suffix/portfolio",
  "internal/validator-details",
  "internal/neurons-snapshot-stamp",
];
async function compare() {
  for (const path of paths) {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(value: Promise<unknown>) {
        pending.push(value);
      },
    };
    const request = new Request(`https://example.com/api/v1/${path}`);
    const expected = await worker.fetch(request.clone(), sourceEnv(), ctx);
    const actual = await worker.fetch(request.clone(), nativeEnv(), ctx);
    assert.equal(actual.status, expected.status, path);
    assert.equal(await actual.text(), await expected.text(), path);
    await Promise.all(pending);
  }
}
async function insert(
  netuid: number,
  shard: number,
  json: string,
  uids: number[],
) {
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  await db
    .prepare("INSERT INTO neurons_documents VALUES(?,'',?,?,jsonb(?))")
    .bind(netuid, shard, stamp, json)
    .run();
  await control.query(
    "INSERT INTO app.neurons_documents VALUES($1,'',$2,$3,$4)",
    [netuid, shard, stamp, payload],
  );
  for (const uid of uids) {
    const hotkey = `key-${uid}`;
    await db
      .prepare("INSERT INTO neurons_members VALUES(?,?,?,?,?)")
      .bind(netuid, uid, hotkey, "cold", shard)
      .run();
    await control.query(
      "INSERT INTO app.neurons_members VALUES($1,$2,$3,'cold',$4)",
      [netuid, uid, hotkey, shard],
    );
  }
}
async function seed() {
  await insert(
    7,
    0,
    `{"1":{"validator_permit":1,"stake_tao":5,"emission_tao":2,"take":0.1,"validator_trust":0.5,"captured_at":${stamp},"block_number":100},"1":{"validator_permit":1,"stake_tao":999,"emission_tao":3,"captured_at":${stamp},"block_number":100},"01":{"validator_permit":1,"stake_tao":888,"captured_at":${stamp},"block_number":100},"2":{"validator_permit":1,"stake_tao":2,"emission_tao":1,"captured_at":${stamp},"block_number":100}}`,
    [1, 2],
  );
  await insert(
    0,
    0,
    `{"1":{"validator_permit":1,"stake_tao":2,"emission_tao":1,"captured_at":${stamp},"block_number":99}}`,
    [1],
  );
  for (const prefix of ["", "app."]) {
    const query = async (text: string, args: unknown[] = []) =>
      prefix
        ? control.query(text, args)
        : db
            .prepare(text)
            .bind(...args)
            .run();
    await query(
      `INSERT INTO ${prefix}subnet_snapshots(netuid,snapshot_date,tao_in_pool_tao,alpha_in_pool) VALUES(7,'2026-10-01',20,5),(7,'2026-11-01',30,5),(0,'2026-11-01',0,0)`,
    );
    await query(
      `INSERT INTO ${prefix}subnet_hyperparams(netuid,tempo,captured_at) VALUES(7,360,${stamp}),(0,100,${stamp})`,
    );
    await query(
      `INSERT INTO ${prefix}account_identity(account,name,captured_at) VALUES('cold','Example',${stamp})`,
    );
    await query(
      `INSERT INTO ${prefix}validator_nominator_counts(hotkey,nominator_count,captured_at) VALUES('key-1',3,${stamp})`,
    );
    await query(
      `INSERT INTO ${prefix}neurons_passes(captured_at,expected_rows,received_rows,completed_at) VALUES(${stamp},3,3,${stamp})`,
    );
  }
}
function kv() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value === null || type !== "json" ? value : JSON.parse(value);
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

describe(
  "native enriched validators and portfolios on PostgreSQL18 and actual D1",
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
      const sql = (file: string) =>
        readFileSync(
          new URL(`../migrations/postgres/${file}`, import.meta.url),
          "utf8",
        );
      await control.query(sql("0024_neuron_documents.sql"));
      for (const [name, file] of [
        ["subnet_snapshots", "0022_closed_day_revisions.sql"],
        ["subnet_hyperparams", "0012_economic_history.sql"],
        ["account_identity", "0014_account_observations.sql"],
        ["validator_nominator_counts", "0014_account_observations.sql"],
      ]) {
        const definition = sql(file).match(
          new RegExp(`CREATE TABLE app\\.${name} \\([\\s\\S]*?\\n\\);`),
        );
        assert.ok(definition, name);
        await control.query(definition[0]);
      }
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
            "neurons_passes",
            ...relational,
          ].includes(row.name),
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
      await control.query(
        `TRUNCATE ${["neurons_documents", "neurons_members", "neurons_passes", ...relational].map((name) => `app.${name}`).join(",")}`,
      );
      for (const name of [
        "neurons_documents",
        "neurons_members",
        "neurons_passes",
        ...relational,
      ])
        await db.prepare(`DELETE FROM ${name}`).run();
    });
    after(async () => {
      mock.timers.reset();
      await source.dispose();
      codec.close();
      binary.close();
      await runtime.close();
      if (ownApp) await control.query("DROP SCHEMA app CASCADE");
      else
        for (const name of [...relational, ...docTables])
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
      await control.end();
    });
    it("matches cold enriched routes", compare);
    it("matches first-key detail and duplicate-preserving directory rows with enrichments", async () => {
      await seed();
      await compare();
      const keys = ["key-1", "key-1\0suffix", "\ud800", "key-2"];
      assert.deepEqual(
        await view.rows({
          columns: ["uid", "hotkey"],
          hotkeys: keys,
          validatorsOnly: true,
          order: [
            { column: "hotkey" },
            { column: "netuid" },
            { column: "uid" },
          ],
        }),
        (
          await db
            .prepare(
              "SELECT uid,hotkey FROM neurons WHERE (hotkey=? OR hotkey=? OR hotkey=? OR hotkey=?) AND validator_permit=TRUE ORDER BY hotkey,netuid,uid",
            )
            .bind(...keys)
            .all()
        ).results,
      );
      const counts = await summary.nominatorCounts(keys);
      assert.deepEqual(
        counts.map((row) => [row.hotkey, row.nominator_count]),
        [
          ["key-1", 3],
          ["key-1\0suffix", null],
          ["\ud800", null],
          ["key-2", null],
        ],
      );
    });
    it("matches directory publication and preserves prior materialization during incomplete capture", async () => {
      await seed();
      const nativeKv = kv(),
        sourceKv = kv();
      const ctx = { waitUntil() {} };
      assert.equal(
        await refreshExplorerDirectoryMaterialization(
          nativeEnv({ METAGRAPH_CONTROL: nativeKv }),
          ctx,
          stamp,
        ),
        true,
      );
      assert.equal(
        await refreshExplorerDirectoryMaterialization(
          sourceEnv({ METAGRAPH_CONTROL: sourceKv }),
          ctx,
          stamp,
        ),
        true,
      );
      assert.deepEqual([...nativeKv.values], [...sourceKv.values]);
      for (const path of [
        "validators/operators",
        "accounts/directory",
        "internal/neurons-snapshot-stamp",
      ]) {
        const request = new Request(`https://example.com/api/v1/${path}`);
        const pending: Promise<unknown>[] = [];
        const context = {
          waitUntil(p: Promise<unknown>) {
            pending.push(p);
          },
        };
        const expected = await worker.fetch(
          request.clone(),
          sourceEnv({ METAGRAPH_CONTROL: sourceKv }),
          context,
        );
        const actual = await worker.fetch(
          request,
          nativeEnv({ METAGRAPH_CONTROL: nativeKv }),
          context,
        );
        assert.equal(actual.status, expected.status);
        assert.equal(await actual.text(), await expected.text());
        await Promise.all(pending);
      }
      await control.query(
        "UPDATE app.neurons_documents SET payload=$1 WHERE netuid=7",
        [codec.encode(`{"1":{"captured_at":${stamp + 1}}}`)],
      );
      assert.equal(
        await refreshExplorerDirectoryMaterialization(
          nativeEnv({ METAGRAPH_CONTROL: nativeKv }),
          ctx,
          stamp,
        ),
        true,
      );
      const blank = kv();
      assert.equal(
        await refreshExplorerDirectoryMaterialization(
          nativeEnv({ METAGRAPH_CONTROL: blank }),
          ctx,
          stamp,
        ),
        false,
      );
      assert.equal(blank.values.size, 0);
    });
  },
);
