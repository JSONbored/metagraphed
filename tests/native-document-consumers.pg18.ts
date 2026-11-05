import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { before, after, describe, it, mock } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { prepareNeuronDocument } from "../src/neuron-document-preparation.ts";
import { createPgNeuronViewStore } from "../src/pg-neuron-view.ts";
import { createPgNeuronLiveStore } from "../src/pg-neuron-live.ts";
import { createPgNeuronMetricStore } from "../src/pg-neuron-metrics.ts";
import { createPgNeuronSummaryStore } from "../src/pg-neuron-summaries.ts";
import { createPgNeuronAggregateStore } from "../src/pg-neuron-aggregates.ts";
import { refreshLiveEconomics } from "../src/live-economics-refresh.ts";
import { loadAccountRegistrationsFromStore } from "../src/account-summary-card.ts";
import { loadAccountPositionsColdTier } from "../src/nominator-positions-cold-tier.ts";
import { runSubnetLifecycleLane } from "../src/subnet-lifecycle.ts";
import { loadSubnetLifecycle } from "../src/subnet-lifecycle-read.ts";
import {
  buildSubnetValidatorEconomicsPayload,
  buildSubnetValidatorEconomicsHistoryPayload,
  buildValidatorEconomicsRankingPayload,
} from "../workers/request-handlers/entities.ts";

const account = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const original = pg18FixtureUrl();
const database = "document_consumers_" + randomUUID().replaceAll("-", "");
const target = new URL(original);
target.pathname = "/" + database;
target.searchParams.set("options", "-c search_path=app,pg_catalog");
const admin = new Client({
  connectionString: original.toString(),
  statement_timeout: 5000,
});
const control = new Client({
  connectionString: target.toString(),
  statement_timeout: 5000,
});
const runtime = createPgStoreRuntime({
  connectionString: target.toString(),
  maxConnections: 5,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const relational = [
  "nominator_positions",
  "subnet_lifecycle",
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "subnet_snapshots",
  "subnet_burn_history",
];
const environment = {
  NATIVE_PROJECTIONS: "enabled",
  NATIVE_READ_STORE: { tables: relational, store: runtime.read },
  NATIVE_PRODUCER_STORE: {
    tables: ["subnet_lifecycle"],
    store: runtime.producer,
  },
  NEURON_VIEW_STORE: createPgNeuronViewStore(runtime, decoder),
  NEURON_LIVE_STORE: createPgNeuronLiveStore(runtime, decoder),
  NEURON_METRIC_STORE: createPgNeuronMetricStore(runtime, decoder),
  NEURON_SUMMARY_STORE: createPgNeuronSummaryStore(runtime, decoder),
};
const stamp = 1793491200000;
const day = "2026-10-31";
let created = false;
const originalFetch = globalThis.fetch;

async function putDocument(
  table: "neurons_documents" | "neuron_daily_documents",
  netuid: number,
  day: string,
  payload: Uint8Array,
) {
  const value = prepareNeuronDocument(decoder, table, payload);
  await control.query("BEGIN");
  try {
    await control.query(
      "INSERT INTO app.neuron_document_projections(source_table,netuid,day,shard,payload_sha256,payload_json,decode_status,decode_error,axon_values,decoder_version,decoder_source_id) VALUES($1,$2,$3,0,$4,$5,$6,$7,$8::json,$9,$10)",
      [
        table,
        netuid,
        day,
        value.payloadSha256,
        value.json,
        value.decodeStatus,
        value.decodeError,
        JSON.stringify(value.axonValues),
        value.decoderVersion,
        value.decoderSourceId,
      ],
    );
    await control.query(`INSERT INTO app.${table} VALUES($1,$2,0,$3,$4)`, [
      netuid,
      day,
      stamp,
      payload,
    ]);
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

describe(
  "shared native document consumers on actual PostgreSQL",
  { concurrency: false },
  () => {
    before(async () => {
      mock.timers.enable({ apis: ["Date"], now: stamp });
      globalThis.fetch = async () => {
        throw new Error(
          "Document consumer fixture must not make network requests",
        );
      };
      await admin.connect();
      assert.equal(
        (await admin.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await admin.query(`CREATE DATABASE ${database}`);
      created = true;
      await control.connect();
      const directory = new URL("../migrations/postgres/", import.meta.url);
      for (const file of readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        await control.query("BEGIN");
        try {
          if (file === "0019_raw_capture_activate.sql")
            await control.query(
              "INSERT INTO app.raw_capture_budget(id) VALUES(1)",
            );
          await control.query(readFileSync(new URL(file, directory), "utf8"));
          await control.query("COMMIT");
        } catch (error) {
          await control.query("ROLLBACK");
          throw error;
        }
      }
      for (const netuid of [7, 8]) {
        const metrics = {
          captured_at: stamp,
          block_number: 100,
          stake_tao: 5000,
          validator_permit: 1,
          active: 1,
          dividends: 0.5,
          take: 0.18,
        };
        const payload = decoder.encode(JSON.stringify({ "1": metrics }));
        await putDocument("neurons_documents", netuid, "", payload);
        await control.query(
          "INSERT INTO app.neurons_members VALUES($1,1,$2,NULL,0)",
          [netuid, account],
        );
        await putDocument("neuron_daily_documents", netuid, day, payload);
        await control.query(
          "INSERT INTO app.neuron_daily_members VALUES($1,1,$2,$3,NULL,0,NULL,false)",
          [netuid, day, account],
        );
        await control.query(
          "INSERT INTO app.subnet_hyperparams(netuid,max_validators,min_childkey_take_ratio,captured_at) VALUES($1,64,0,$2)",
          [netuid, stamp],
        );
        await control.query(
          "INSERT INTO app.subnet_hyperparams_history(netuid,observed_at,max_validators,hyperparams_hash) VALUES($1,$2,64,'fixture')",
          [netuid, stamp - 2 * 86400000],
        );
        await control.query(
          "INSERT INTO app.subnet_snapshots(netuid,snapshot_date,tao_in_emission_tao) VALUES($1,$2,1)",
          [netuid, day],
        );
        await control.query(
          "INSERT INTO app.subnet_burn_history VALUES($1,$2,1)",
          [netuid, stamp],
        );
      }
      await control.query("INSERT INTO app.neurons_passes VALUES($1,2,2,$1)", [
        stamp,
      ]);
      await control.query(
        "INSERT INTO app.nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES($1,$1,7,0.25,$2)",
        [account, stamp],
      );
    });
    after(async () => {
      globalThis.fetch = originalFetch;
      mock.timers.reset();
      decoder.close();
      await runtime.close();
      await control.end();
      if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    });

    it("returns real registrations and prices real positions without logical table ownership", async () => {
      const registrations = await loadAccountRegistrationsFromStore(
        environment as never,
        account,
      );
      assert.deepEqual(
        registrations?.map((row) => row.netuid),
        [7, 8],
      );
      assert.equal(registrations?.[0]?.stake_tao, 5000);
      const positions = await loadAccountPositionsColdTier(
        environment,
        account,
      );
      assert.equal(positions?.position_count, 1);
      assert.equal(positions?.total_stake_alpha, 1250);
    });

    it("composes each validator economics family with real native and relational reads", async () => {
      const row = {
        netuid: 7,
        max_validators: 64,
        tao_in_pool_tao: 1000,
        alpha_in_pool: 100000,
        tao_in_emission_tao: 1,
      };
      const loadParams = async () => ({
        stake_threshold_tao: 1000,
        tao_weight: 0.18,
      });
      const one = await buildSubnetValidatorEconomicsPayload(
        environment as never,
        7,
        {
          loadParams: loadParams as never,
          loadBurn: (async () => ({ burn_tao: 1 })) as never,
          loadEconomicsRow: (async () => ({ row, generatedAt: null })) as never,
        },
      );
      assert.equal(one.data.max_validators, 64);
      assert.equal(
        (one.data.composition as { permitted: number }).permitted,
        1,
      );
      const history = await buildSubnetValidatorEconomicsHistoryPayload(
        environment as never,
        7,
        "30d",
        { loadEconomicsRow: (async () => ({ row })) as never },
      );
      assert.equal((history.data.points as unknown[]).length, 1);
      const ranking = await buildValidatorEconomicsRankingPayload(
        environment as never,
        {},
        {
          loadParams: loadParams as never,
          loadEconomics: async () => ({
            rows: [row, { ...row, netuid: 8 }],
            generatedAt: null,
          }),
        },
      );
      assert.equal((ranking.data.rows as unknown[]).length, 2);
    });

    it("writes lifecycle changes through the native producer and excludes invalidated history", async () => {
      await control.query(
        "INSERT INTO app.subnet_lifecycle(netuid,event,observed_at) VALUES(7,'registered',$1)",
        [stamp - 1],
      );
      await control.query(
        "INSERT INTO app.subnet_lifecycle(netuid,event,observed_at,_invalidated_at) VALUES(9,'registered',$1,$1)",
        [stamp - 1],
      );
      const result = await runSubnetLifecycleLane(environment, {
        coverageFloor: 1,
      });
      assert.equal(result.ok, true);
      assert.equal(result.events, 1);
      const rows = (
        await control.query(
          "SELECT netuid,event FROM app.subnet_lifecycle WHERE _invalidated_at IS NULL ORDER BY netuid",
        )
      ).rows;
      assert.deepEqual(rows, [
        { netuid: 7, event: "registered" },
        { netuid: 8, event: "registered" },
      ]);
      assert.deepEqual(
        await loadSubnetLifecycle(environment, 9, { limit: 10, offset: 0 }),
        [],
      );
    });
    it("publishes live economics from the real native aggregate and relational history", async () => {
      const writes: string[] = [];
      const blockHash = "0x" + "a".repeat(64);
      const fetchImpl: typeof fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
          params: unknown[];
        };
        let result: unknown;
        if (request.method === "chain_getBlockHash") result = blockHash;
        else if (request.method === "chain_getHeader")
          result = { number: "0x64", parentHash: blockHash };
        else if (request.method === "state_queryStorageAt")
          result = [
            {
              block: blockHash,
              changes: (request.params[0] as string[]).map((key) => [
                key,
                "0x0100000000000000",
              ]),
            },
          ];
        else if (request.method === "state_getStorage")
          result = "0x0100000000000000";
        else throw new Error("Unexpected fixture RPC method");
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      };
      const result = await refreshLiveEconomics(
        {
          ...environment,
          NEURON_AGGREGATE_STORE: createPgNeuronAggregateStore(
            runtime,
            decoder,
          ),
          METAGRAPH_CONTROL: {
            put: async (_key: string, value: string) => {
              writes.push(value);
            },
          },
        } as never,
        {
          readArtifact: async () =>
            ({
              ok: true,
              data: {
                network: "finney",
                subnets: [{ netuid: 7, name: "Fixture" }],
              },
            }) as never,
          fetchImpl,
          now: () => stamp,
          timeoutMs: 1000,
        },
      );
      assert.equal(result.ok, true);
      assert.equal(writes.length, 1);
      assert.equal(JSON.parse(writes[0]!).subnets[0].total_stake_alpha, 5000);
    });
  },
);
