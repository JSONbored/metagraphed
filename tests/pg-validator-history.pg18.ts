import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { before, beforeEach, after, describe, it, mock } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgValidatorHistoryStore } from "../src/pg-validator-history.ts";
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
const native = createPgValidatorHistoryStore(runtime, decoder);
const nativeEnv = () => ({ ...dataApiEnv(), VALIDATOR_HISTORY_STORE: native });
const tables =
  "neurons,neurons_passes,neuron_daily,account_position_daily,subnet_snapshots,subnet_ownership,subnet_hyperparams,validator_nominator_counts,nominator_positions,tao_usd_index,treasury_readings";
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
const paths = [
  "validators/validator/history?window=all",
  "validators/validator/history?window=all&netuid=7",
  "validators/validator/history?window=all&netuid=0",
  "validators/validator/history?window=7d",
  "validators/validator/history?window=7d&netuid=7",
  "validators/validator/history?netuid=999&window=all",
  "validators/missing/history?window=all",
  "validators/validator%00suffix/history?window=all",
  "validators/validator/history?netuid=1.5&window=all",
];
async function compare() {
  for (const path of paths) {
    const request = new Request(`https://example.com/api/v1/${path}`);
    const expected = await worker.fetch(
      request.clone(),
      dataApiEnv({ D1_STATE: db, D1_STATE_TABLES: tables }),
      { waitUntil() {} },
    );
    const actual = await worker.fetch(request, nativeEnv(), { waitUntil() {} });
    assert.equal(actual.status, expected.status, path);
    assert.equal(await actual.text(), await expected.text(), path);
  }
}
async function insert(
  netuid: number,
  day: string,
  shard: number,
  json: string,
  uids: number[],
) {
  const payload = binary.prepare("SELECT jsonb(?) AS value").get(json)!.value;
  await db
    .prepare(
      "INSERT INTO neuron_daily_documents(netuid,day,shard,stamp,payload) VALUES(?,?,?,?,jsonb(?))",
    )
    .bind(netuid, day, shard, stamp, json)
    .run();
  await control.query(
    "INSERT INTO app.neuron_daily_documents(netuid,day,shard,stamp,payload) VALUES($1,$2,$3,$4,$5)",
    [netuid, day, shard, stamp, payload],
  );
  for (const uid of uids) {
    await db
      .prepare(
        "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,hotkey,coldkey,shard) VALUES(?,?,?,'validator','owner',?)",
      )
      .bind(netuid, uid, day, shard)
      .run();
    await control.query(
      "INSERT INTO app.neuron_daily_members(netuid,uid,snapshot_date,hotkey,coldkey,shard) VALUES($1,$2,$3,'validator','owner',$4)",
      [netuid, uid, day, shard],
    );
  }
}
async function snapshot(
  netuid: number,
  day: string,
  tao: number,
  alpha: number,
) {
  await db
    .prepare(
      "INSERT INTO subnet_snapshots(netuid,snapshot_date,total_stake_tao,tao_in_pool_tao,alpha_in_pool) VALUES(?,?,100,?,?)",
    )
    .bind(netuid, day, tao, alpha)
    .run();
  await control.query(
    "INSERT INTO app.subnet_snapshots(netuid,snapshot_date,total_stake_tao,tao_in_pool_tao,alpha_in_pool) VALUES($1,$2,100,$3,$4)",
    [netuid, day, tao, alpha],
  );
}

describe(
  "native validator arithmetic history on PostgreSQL18 and actual D1",
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
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0024_neuron_documents.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const snapshots = readFileSync(
        new URL(
          "../migrations/postgres/0022_closed_day_revisions.sql",
          import.meta.url,
        ),
        "utf8",
      ).match(/CREATE TABLE app\.subnet_snapshots \([\s\S]*?\n\);/);
      assert.ok(snapshots);
      await control.query(snapshots[0]);
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
        "neuron_daily_documents",
        "neuron_daily_members",
        "subnet_snapshots",
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
        for (const name of ["subnet_snapshots", ...docTables])
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
      await control.end();
    });
    it("matches cold validator histories", compare);
    it("preserves canonical scalars, missing prices, lost permits and root integer precision", async () => {
      await insert(
        0,
        "2026-11-01",
        0,
        '{"0":{"stake_tao":999999,"validator_permit":0},"1":{"stake_tao":9007199254740993,"emission_tao":1,"validator_permit":1},"1":{"stake_tao":999}}',
        [0, 1],
      );
      await insert(
        7,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":"2x","emission_tao":3.5,"validator_permit":1,"take":0.1}}',
        [1],
      );
      await insert(
        8,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":100,"emission_tao":4,"validator_permit":1}}',
        [1],
      );
      await insert(
        9,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":5,"emission_tao":8,"validator_permit":1}}',
        [1],
      );
      await insert(
        7,
        "2026-10-31",
        0,
        '{"1":{"stake_tao":4,"emission_tao":2,"validator_permit":0}}',
        [1],
      );
      await insert(
        0,
        "2026-10-30",
        0,
        '{"1":{"stake_tao":2,"emission_tao":1,"validator_permit":1}}',
        [1],
      );
      await insert(
        0,
        "2026-10-01",
        0,
        '{"1":{"stake_tao":5,"emission_tao":5,"validator_permit":1}}',
        [1],
      );
      await snapshot(7, "2026-11-01", 2, 4);
      await snapshot(9, "2026-11-01", 1, 0);
      await snapshot(7, "2026-10-31", 10, 2);
      await compare();
      const expected = await db
        .prepare(
          "SELECT nd.snapshot_date AS snapshot_date,COUNT(DISTINCT nd.netuid) AS subnet_count,SUM(nd.stake_tao*CASE WHEN nd.netuid=0 THEN 1 ELSE s.tao_in_pool_tao/s.alpha_in_pool END) AS total_stake_tao,SUM(nd.emission_tao*CASE WHEN nd.netuid=0 THEN 1 ELSE s.tao_in_pool_tao/s.alpha_in_pool END) AS total_emission_tao FROM neuron_daily nd LEFT JOIN subnet_snapshots s ON s.netuid=nd.netuid AND s.snapshot_date=nd.snapshot_date WHERE nd.hotkey='validator' AND nd.validator_permit=TRUE GROUP BY nd.snapshot_date ORDER BY nd.snapshot_date DESC LIMIT 400",
        )
        .all();
      assert.deepEqual(
        await native.rows("validator", null, 400),
        expected.results,
      );
      const paged = createPgValidatorHistoryStore(runtime, decoder, {
        pageRows: 1,
      });
      assert.deepEqual(
        await paged.rows("validator", null, 400),
        expected.results,
      );
      assert.deepEqual(
        await paged.rows("validator", null, 1),
        expected.results.slice(0, 1),
      );
    });
    it("preserves scoped cap ordering across shards", async () => {
      await insert(
        7,
        "2026-11-01",
        0,
        '{"3":{"stake_tao":3,"emission_tao":3,"validator_permit":1}}',
        [3],
      );
      await insert(
        7,
        "2026-11-01",
        1,
        '{"1":{"stake_tao":1,"emission_tao":1,"validator_permit":0}}',
        [1],
      );
      await snapshot(7, "2026-11-01", 2, 1);
      const expected = await db
        .prepare(
          "SELECT nd.snapshot_date AS snapshot_date,1 AS subnet_count,nd.netuid AS netuid,nd.uid AS uid,nd.stake_tao AS stake_alpha,nd.emission_tao AS emission_alpha,nd.validator_trust AS validator_trust,nd.consensus AS consensus,nd.dividends AS dividends,nd.take AS take,nd.validator_permit AS validator_permit,s.total_stake_tao AS subnet_total_stake,nd.stake_tao*CASE WHEN nd.netuid=0 THEN 1 ELSE s.tao_in_pool_tao/s.alpha_in_pool END AS total_stake_tao,nd.emission_tao*CASE WHEN nd.netuid=0 THEN 1 ELSE s.tao_in_pool_tao/s.alpha_in_pool END AS total_emission_tao FROM neuron_daily nd LEFT JOIN subnet_snapshots s ON s.netuid=nd.netuid AND s.snapshot_date=nd.snapshot_date WHERE nd.hotkey='validator' AND nd.netuid=7 ORDER BY nd.snapshot_date DESC LIMIT 1",
        )
        .all();
      assert.deepEqual(
        await native.rows("validator", null, 1, 7),
        expected.results,
      );
    });
    it("keeps later pages on the original pool snapshot", async () => {
      await insert(
        0,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":1,"emission_tao":1,"validator_permit":1}}',
        [1],
      );
      await insert(
        7,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":2,"emission_tao":4,"validator_permit":1}}',
        [1],
      );
      await snapshot(7, "2026-11-01", 2, 4);
      let changed = false;
      const transaction: typeof runtime.transaction = (callback, options) =>
        runtime.transaction(
          (scope) =>
            callback({
              ...scope,
              async query<Row>(sql: string, values?: unknown[]) {
                const rows = await scope.query<Row>(sql, values);
                if (!changed) {
                  changed = true;
                  await control.query(
                    "UPDATE app.subnet_snapshots SET tao_in_pool_tao=200 WHERE netuid=7",
                  );
                }
                return rows;
              },
            }),
          options,
        );
      const paged = createPgValidatorHistoryStore({ transaction }, decoder, {
        pageRows: 1,
      });
      assert.deepEqual(await paged.rows("validator", null, 400), [
        {
          snapshot_date: "2026-11-01",
          subnet_count: 2,
          total_stake_tao: 2,
          total_emission_tao: 3,
        },
      ]);
      assert.equal(changed, true);
    });
    it("finishes a requested day across adaptively reduced pages", async () => {
      for (const day of ["2026-11-01", "2026-10-31"]) {
        await insert(
          0,
          day,
          0,
          '{"0":{"validator_permit":0},"1":{"stake_tao":1,"emission_tao":1,"validator_permit":1}}',
          [0, 1],
        );
        await insert(
          7,
          day,
          0,
          '{"1":{"stake_tao":2,"emission_tao":4,"validator_permit":1}}',
          [1],
        );
        await snapshot(7, day, 2, 4);
      }
      const bytes = Number(
        (
          await control.query(
            "SELECT max(octet_length(payload)) AS bytes FROM app.neuron_daily_documents",
          )
        ).rows[0].bytes,
      );
      const limited = createPgValidatorHistoryStore(runtime, decoder, {
        pageRows: 4,
        maxPageBytes: bytes + 1,
      });
      assert.deepEqual(await limited.rows("validator", null, 1), [
        {
          snapshot_date: "2026-11-01",
          subnet_count: 2,
          total_stake_tao: 2,
          total_emission_tao: 3,
        },
      ]);
    });
    it("retains integer-overflow recovery and compensated REAL cancellation", async () => {
      await insert(
        0,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":9223372036854775807,"validator_permit":1},"2":{"stake_tao":9223372036854775807,"validator_permit":1}}',
        [1, 2],
      );
      await insert(
        7,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":1.0,"validator_permit":1}}',
        [1],
      );
      await snapshot(7, "2026-11-01", 1, 1);
      await insert(
        0,
        "2026-10-31",
        0,
        '{"1":{"stake_tao":1,"validator_permit":1}}',
        [1],
      );
      await insert(
        7,
        "2026-10-31",
        0,
        '{"1":{"stake_tao":1e20,"validator_permit":1}}',
        [1],
      );
      await snapshot(7, "2026-10-31", 1, 1);
      await insert(
        8,
        "2026-10-31",
        0,
        '{"1":{"stake_tao":-1e20,"validator_permit":1}}',
        [1],
      );
      await snapshot(8, "2026-10-31", 1, 1);
      await compare();
      const expected = await db
        .prepare(
          "SELECT nd.snapshot_date AS snapshot_date,COUNT(DISTINCT nd.netuid) AS subnet_count,SUM(nd.stake_tao*CASE WHEN nd.netuid=0 THEN 1 ELSE s.tao_in_pool_tao/s.alpha_in_pool END) AS total_stake_tao,SUM(nd.emission_tao*CASE WHEN nd.netuid=0 THEN 1 ELSE s.tao_in_pool_tao/s.alpha_in_pool END) AS total_emission_tao FROM neuron_daily nd LEFT JOIN subnet_snapshots s ON s.netuid=nd.netuid AND s.snapshot_date=nd.snapshot_date WHERE nd.hotkey='validator' AND nd.validator_permit=TRUE GROUP BY nd.snapshot_date ORDER BY nd.snapshot_date DESC LIMIT 400",
        )
        .all();
      assert.deepEqual(
        await createPgValidatorHistoryStore(runtime, decoder, {
          pageRows: 1,
        }).rows("validator", null, 400),
        expected.results,
      );
    });
    it("matches SQLite scalar storage and values for numeric boundary pairs", async () => {
      const pairs = [
        ["7", "2"],
        ["7", "2.0"],
        ["-9223372036854775808", "-1"],
        ["9223372036854775807", "2"],
        ["1e-308", "0.1"],
        ["1e308", "1e308"],
        ["0", "0"],
        ["null", "2"],
        ['"2x"', "2"],
        ['"2\\u00003"', "2"],
        ['"7\\u00003"', "2"],
        ['"9223372036854775807\\u0000x"', "1"],
        ["7", '"2\\u0000x"'],
      ];
      for (const [left, right] of pairs)
        for (const [operator, symbol] of [
          ["multiply", "*"],
          ["divide", "/"],
        ] as const) {
          const expected = await db
            .prepare(
              `WITH cells AS (SELECT json_extract(?,'$') AS a,json_extract(?,'$') AS b) SELECT typeof(a${symbol}b) AS storage,a${symbol}b AS value FROM cells`,
            )
            .bind(left, right)
            .first<{ storage: string; value: number | null }>();
          const actual = decoder.arithmetic(
            operator,
            decoder.extract(decoder.encode(left), "$"),
            decoder.extract(decoder.encode(right), "$"),
          );
          const storage =
            actual === null
              ? "null"
              : typeof actual === "bigint"
                ? "integer"
                : "real";
          const value =
            typeof actual === "bigint"
              ? Number(actual)
              : actual === null || !Number.isFinite(actual)
                ? null
                : actual === 0
                  ? 0
                  : actual;
          assert.deepEqual(
            { storage, value },
            expected,
            `${left} ${symbol} ${right}`,
          );
        }
    });
    it("retains opaque integer SUM overflow errors", async () => {
      await insert(
        0,
        "2026-11-01",
        0,
        '{"1":{"stake_tao":9223372036854775807,"validator_permit":1},"2":{"stake_tao":9223372036854775807,"validator_permit":1}}',
        [1, 2],
      );
      const request = new Request(
        "https://example.com/api/v1/validators/validator/history?window=all",
      );
      const expected = await worker.fetch(
        request.clone(),
        dataApiEnv({ D1_STATE: db, D1_STATE_TABLES: tables }),
        { waitUntil() {} },
      );
      const actual = await worker.fetch(request, nativeEnv(), {
        waitUntil() {},
      });
      assert.equal(expected.status, 502);
      assert.equal(actual.status, 502);
      assert.equal(await actual.text(), await expected.text());
    });
    it("preserves D1 numeric text before aggregate wire conversion", async () => {
      await insert(
        0,
        "2026-11-01",
        0,
        '{"1":{"emission_tao":"9007199254740993\\u0000tail","validator_permit":1},"2":{"emission_tao":1,"validator_permit":1}}',
        [1, 2],
      );
      await compare();
      assert.equal(
        (await native.rows("validator", null, 400))[0].total_emission_tao,
        9007199254740994,
      );
    });
    it("preserves D1 SUM storage for numeric TEXT containing NUL", async () => {
      for (const input of [
        "7\0tail",
        "2.5\0tail",
        "9007199254740993\0tail",
        "9223372036854775807\0tail",
        "7",
        "7x",
      ]) {
        const expected = await db
          .prepare(
            "SELECT typeof(SUM(json_extract(?,'$'))) AS storage,SUM(json_extract(?,'$')) AS value",
          )
          .bind(JSON.stringify(input), JSON.stringify(input))
          .first<{ storage: string; value: number }>();
        const actual = decoder.numericAffinity(input);
        assert.deepEqual(
          {
            storage: typeof actual === "bigint" ? "integer" : "real",
            value: Number(actual),
          },
          expected,
        );
      }
    });
  },
);
