import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgProducerBindings } from "../src/pg-producer-store.ts";
import { producerStore } from "../workers/api.ts";
import { persistSweep } from "../src/attribution-sweep.ts";
import { persistComputeDeclaration } from "../src/compute-declarations-lane.ts";
import { captureSubnetBurnHistory } from "../src/subnet-burn-history.ts";
import { mirrorLedgerToNeon } from "../src/ledger-neon-write.ts";
import { mirrorFamilyToNeon } from "../src/hyperparams-identity-neon-write.ts";
import { mirrorNominatorPositionsToNeon } from "../src/nominator-positions-neon-write.ts";
import { mirrorChainDetailToNeon } from "../src/chain-detail-neon-write.ts";
import {
  mirrorBlocksHeadToNeon,
  mirrorRawCaptureStateToNeon,
} from "../src/capture-state-neon-write.ts";
import dataApi, { writeTaoUsdIndexRow } from "../workers/data-api.ts";
import { mockEnv } from "./row-type.ts";
import { dataApiEnv } from "../scripts/lib/worker-env.ts";

const schema = "native_producer_fixture";
const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  statement_timeout: 5000,
  connectionTimeoutMillis: 2000,
});
const connection = new URL(connectionString);
connection.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
connection.searchParams.set("application_name", "native-producer-fixture");
const runtime = createPgStoreRuntime({
  connectionString: connection.toString(),
  maxConnections: 1,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const stamp = 1790000000000;
const lanes = [
  "blocks-head",
  "raw-capture-state",
  "chain-detail",
  "account-balances",
  "hotkey-alpha",
  "validator-nominator-counts",
  "subnet-hyperparams",
  "account-identity",
  "subnet-identity",
  "subnet-ownership",
  "nominator-positions",
  "self-stake",
  "tao-usd-index",
];
let relations: string[];
let bindings: ReturnType<typeof createPgProducerBindings>;
let ownsSchema = false;
const deps = { laneHealthDb: null };
const pass = {
  capturedAt: stamp,
  expectedRows: 1,
  receivedRows: 1,
  nowMs: stamp,
};

describe(
  "native producer selectors on PostgreSQL 18",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query(`CREATE SCHEMA ${schema}`);
      ownsSchema = true;
      // Exact source DDL, with only the task-owned namespace changed.
      for (const name of [
        "0012_economic_history.sql",
        "0014_account_observations.sql",
        "0016_chain_control.sql",
      ]) {
        const ddl = readFileSync(
          new URL(`../migrations/postgres/${name}`, import.meta.url),
          "utf8",
        );
        await control.query(
          ddl
            .replaceAll("app.", `${schema}.`)
            .replaceAll(
              "CREATE SCHEMA IF NOT EXISTS app;",
              `CREATE SCHEMA IF NOT EXISTS ${schema};`,
            ),
        );
      }
      const captureDdl = readFileSync(
        new URL("../migrations/postgres/0018_raw_capture.sql", import.meta.url),
        "utf8",
      );
      const rawState = captureDdl.match(
        /CREATE TABLE app\.raw_capture_state \([\s\S]*?\n\);/,
      )?.[0];
      assert.ok(rawState);
      await control.query(rawState.replaceAll("app.", `${schema}.`));
      relations = (
        await control.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
          [schema],
        )
      ).rows.map((row) => row.table_name);
      bindings = createPgProducerBindings(
        { ...runtime, relations, access: "read-write" },
        lanes,
      );
    });
    beforeEach(async () => {
      await control.query(
        `TRUNCATE ${relations.map((table) => `${schema}.${table}`).join(",")}`,
      );
    });
    after(async () => {
      await runtime.close();
      if (ownsSchema) await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    });

    it("persists probe metadata, PostgreSQL booleans and atomic counted burn writes through one pool", async () => {
      const owner = producerStore(mockEnv(bindings), undefined, [
        "attribution_sweeps",
        "attribution_candidates",
        "compute_declarations",
        "subnet_burn_history",
      ]);
      const store = bindings.NATIVE_PRODUCER_STORE.store;
      assert.equal(owner.db, store);
      assert.deepEqual(
        await persistSweep(store, {
          netuid: 7,
          swept_at: stamp,
          sources_checked: 1,
          sources_read: 1,
          candidates: [
            { ss58: "public-account", source_url: "https://example.com/team" },
          ],
          verdict: "candidates-found",
        }),
        { ok: true },
      );
      assert.deepEqual(
        await persistComputeDeclaration(store, {
          netuid: 7,
          source_url: "https://example.com/requirements",
          read_at_sha: "fixture",
          observed_at: stamp,
          found: true,
          spec_version: "1",
          miner: { cpu: "arm64" },
          validator: null,
          unscoped: null,
        }),
        { ok: true },
      );
      const result = await captureSubnetBurnHistory(mockEnv(bindings), {
        db: store,
        now: () => stamp,
        load: async () => ({
          subnets: [
            { netuid: 7, burn_tao: 1.5 },
            { netuid: 8, burn_tao: 0 },
          ],
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.captured, 2);
      const compute = await store.first<{ found: boolean; miner: string }>(
        "SELECT found,miner FROM compute_declarations WHERE netuid=?",
        [7],
      );
      assert.deepEqual(compute, { found: true, miner: '{"cpu":"arm64"}' });
      await assert.rejects(
        store.transaction([
          {
            text: "INSERT INTO subnet_burn_history VALUES (9,?,2)",
            values: [stamp],
          },
          { text: "INSERT INTO table_that_does_not_exist VALUES (1)" },
        ]),
      );
      assert.equal(
        await store.first("SELECT 1 FROM subnet_burn_history WHERE netuid=9"),
        null,
      );
      owner.close();
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='native-producer-fixture'",
          )
        ).rows[0].count,
        1,
      );
      assert.throws(
        () =>
          producerStore(mockEnv(bindings), undefined, [
            "neuron_daily",
            "chain_concentration_daily",
          ]),
        /does not own/,
      );
    });

    it("executes every supported relational mirror with native source types and direct verdicts", async () => {
      const outcomes = [];
      outcomes.push(
        await mirrorLedgerToNeon(
          bindings,
          null,
          "account-balances",
          [{ ss58: "a", free_tao: 2, reserved_tao: 0, captured_at: stamp }],
          deps,
          pass,
        ),
      );
      await bindings.NATIVE_PRODUCER_STORE.store.run(
        "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES('c','h',1,1,?,'alpha')",
        [stamp],
      );
      outcomes.push(
        await mirrorLedgerToNeon(
          bindings,
          null,
          "hotkey-alpha",
          [{ hotkey: "h", netuid: 1, total_alpha: 2, captured_at: stamp }],
          deps,
          pass,
        ),
      );
      outcomes.push(
        await mirrorLedgerToNeon(
          bindings,
          null,
          "validator-nominator-counts",
          [{ hotkey: "h", nominator_count: 1, captured_at: stamp }],
          deps,
          pass,
        ),
      );
      const families = [
        {
          lane: "subnet-hyperparams",
          row: {
            netuid: 1,
            captured_at: stamp,
            block_number: 1,
            registration_allowed: true,
          },
          history: {
            netuid: 1,
            observed_at: stamp,
            block_number: 1,
            registration_allowed: true,
            hyperparams_hash: "a",
          },
        },
        {
          lane: "account-identity",
          row: { account: "a", captured_at: stamp, name: "test" },
          history: {
            account: "a",
            observed_at: stamp,
            identity_hash: "a",
            name: "test",
          },
        },
        {
          lane: "subnet-identity",
          row: {
            netuid: 1,
            captured_at: stamp,
            block_number: 1,
            identity_hash: "a",
          },
          history: {
            netuid: 1,
            observed_at: stamp,
            block_number: 1,
            identity_hash: "a",
          },
        },
        {
          lane: "subnet-ownership",
          row: {
            netuid: 1,
            captured_at: stamp,
            owner_hotkey: "h",
            owner_coldkey: "c",
          },
          history: {
            netuid: 1,
            captured_at: stamp,
            owner_hotkey: "h",
            owner_coldkey: "c",
          },
        },
      ];
      for (const family of families) {
        const result = await mirrorFamilyToNeon(
          bindings,
          null,
          family.lane,
          { rows: [family.row], historyRows: [family.history] },
          deps,
        );
        assert.ok(
          Object.values(result.results).every((row) => row.ok),
          JSON.stringify(result),
        );
      }
      for (const lane of ["nominator-positions", "self-stake"]) {
        const result = await mirrorNominatorPositionsToNeon(
          bindings,
          null,
          {
            lane,
            rows: [
              {
                coldkey: "c",
                hotkey: "h",
                netuid: 1,
                share_fraction: 1,
                captured_at: stamp,
              },
            ],
            coldkeyMaxCapturedAt: new Map(),
            pass,
          },
          deps,
        );
        assert.equal(result.write?.ok, true, JSON.stringify(result));
      }
      for (const outcome of outcomes)
        assert.equal(outcome.result?.ok, true, JSON.stringify(outcome));
      assert.equal(
        (
          await runtime.read.first<{ registration_allowed: boolean }>(
            "SELECT registration_allowed FROM subnet_hyperparams WHERE netuid=1",
          )
        )?.registration_allowed,
        true,
      );
      assert.equal(
        (
          await runtime.read.first<{ total_alpha: number }>(
            "SELECT total_alpha FROM hotkey_alpha WHERE hotkey='h'",
          )
        )?.total_alpha,
        2,
      );
    });

    it("preserves chain coverage order, head coalescing, raw watermark monotonicity and TAO JSON text", async () => {
      const head = {
        block_number: 1,
        block_hash: "0x1",
        parent_hash: "0x0",
        extrinsic_count: 1,
        event_count: 3,
        author: "author",
        observed_at: stamp,
      };
      assert.equal(
        (await mirrorBlocksHeadToNeon(bindings, null, head, deps)).result?.ok,
        true,
      );
      assert.equal(
        (
          await mirrorBlocksHeadToNeon(
            bindings,
            null,
            { ...head, event_count: null, author: null },
            deps,
          )
        ).result?.ok,
        true,
      );
      for (const height of [10, 9])
        assert.equal(
          (
            await mirrorRawCaptureStateToNeon(
              bindings,
              null,
              "mainnet",
              height,
              stamp,
              deps,
            )
          ).result?.ok,
          true,
        );
      const detail = await mirrorChainDetailToNeon(
        bindings,
        null,
        {
          blockRows: [
            {
              block_number: 1,
              block_hash: "0x1",
              extrinsic_count: 1,
              chain_event_count: 0,
              account_event_count: 0,
              observed_at: stamp,
              synced_at: stamp,
              subnet_ids: "[]",
              economics_complete: 1,
            },
          ],
          extrinsicRows: [
            {
              block_number: 1,
              extrinsic_index: 0,
              success: 1,
              observed_at: stamp,
            },
          ],
          chainEventRows: [],
          accountEventRows: [],
        },
        deps,
      );
      assert.ok(
        Object.values(detail.results).every((row) => row.ok),
        JSON.stringify(detail),
      );
      const pools = [
        { address: "pool", included: true, eth_per_tao: 1, liquidity_usd: 2 },
      ];
      assert.equal(
        (
          await writeTaoUsdIndexRow(dataApiEnv(bindings), {
            block_number: 1,
            observed_at: stamp,
            usd_per_tao: 2,
            price_basis: "wrapped_onchain_median",
            eth_usd: 2,
            pool_count: 2,
            pools,
          })
        ).written,
        true,
      );
      assert.deepEqual(
        await runtime.read.first(
          "SELECT event_count,author FROM blocks_head WHERE block_number=1",
        ),
        { event_count: 3, author: "author" },
      );
      assert.equal(
        (
          await runtime.read.first<{ last_contiguous_block: number }>(
            "SELECT last_contiguous_block FROM raw_capture_state WHERE network='mainnet'",
          )
        )?.last_contiguous_block,
        10,
      );
      assert.equal(
        (
          await runtime.read.first<{ success: boolean }>(
            "SELECT success FROM chain_detail_extrinsics WHERE block_number=1",
          )
        )?.success,
        true,
      );
      assert.equal(
        (
          await runtime.read.first<{ pools: string }>(
            "SELECT pools FROM tao_usd_index WHERE block_number=1",
          )
        )?.pools,
        JSON.stringify(pools),
      );
      const response = await dataApi.fetch(
        new Request(
          "https://fixture.invalid/api/v1/internal/chain-detail-sync/head",
          { headers: { "x-chain-detail-sync-token": "fixture" } },
        ),
        dataApiEnv({ ...bindings, CHAIN_DETAIL_SYNC_SECRET: "fixture" }),
        { waitUntil() {} },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { head: 1 });
    });

    it("performs capture diff reads and writes through the native HTTP producer", async () => {
      const pending: Promise<unknown>[] = [];
      const env = dataApiEnv({
        ...bindings,
        ACCOUNT_IDENTITY_SYNC_SECRET: "fixture",
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await dataApi.fetch(
          new Request(
            "https://fixture.invalid/api/v1/internal/account-identity-sync",
            {
              method: "POST",
              headers: {
                "x-account-identity-sync-token": "fixture",
                "content-type": "application/json",
              },
              body: JSON.stringify([
                { account: "a", captured_at: stamp + attempt, name: "same" },
              ]),
            },
          ),
          env,
          { waitUntil: (promise) => pending.push(promise) },
        );
        assert.equal(response.status, 200, await response.clone().text());
        await response.text();
      }
      await Promise.all(pending);
      assert.equal(
        (
          await runtime.read.first<{ count: number }>(
            "SELECT count(*) AS count FROM account_identity_history",
          )
        )?.count,
        1,
      );
      assert.equal(
        (
          await runtime.read.first<{ name: string }>(
            "SELECT name FROM account_identity WHERE account='a'",
          )
        )?.name,
        "same",
      );
    });
  },
);
