import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  selectedNativeProducerStore,
  selectedNativeWriteRunner,
  selectedNativeProducerSql,
} from "../src/native-producer-store.ts";
import { createPgProducerBindings } from "../src/pg-producer-store.ts";
import { producerStore } from "../workers/api.ts";
import {
  neonWriteRunner,
  neonWriteBufferEnabled,
} from "../src/neon-write-buffer.ts";
import {
  mirrorBlocksHeadToNeon,
  mirrorRawCaptureStateToNeon,
} from "../src/capture-state-neon-write.ts";
import { mirrorChainDetailToNeon } from "../src/chain-detail-neon-write.ts";
import { mirrorLedgerToNeon } from "../src/ledger-neon-write.ts";
import { mirrorFamilyToNeon } from "../src/hyperparams-identity-neon-write.ts";
import { mirrorNominatorPositionsToNeon } from "../src/nominator-positions-neon-write.ts";
import { mirrorNeuronSnapshotToNeon } from "../src/neurons-neon-write.ts";
import dataApi, {
  writeTaoUsdIndexRow,
  neonOwnsLedger,
  neonOwnsFamily,
  neonOwnsNominatorPositions,
  neonOwnsChainDetail,
} from "../workers/data-api.ts";
import type { PgSql } from "../src/pg-sql.ts";
import { mockEnv } from "./row-type.ts";
import { dataApiEnv } from "../scripts/lib/worker-env.ts";

const tables = [
  "attribution_sweeps",
  "attribution_candidates",
  "subnet_burn_history",
  "compute_declarations",
  "blocks_head",
  "raw_capture_state",
  "chain_detail_extrinsics",
  "chain_detail_chain_events",
  "chain_detail_account_events",
  "chain_detail_blocks",
  "account_balances",
  "account_balances_passes",
  "hotkey_alpha",
  "hotkey_alpha_passes",
  "validator_nominator_counts",
  "validator_nominator_counts_passes",
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "account_identity",
  "account_identity_history",
  "subnet_identity",
  "subnet_identity_history",
  "subnet_ownership",
  "subnet_ownership_history",
  "nominator_positions",
  "nominator_positions_passes",
  "nominator_scan_receipts",
  "tao_usd_index",
];
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

function fixture() {
  const calls: { text: string; values: unknown[] }[] = [];
  const query = async <Row>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> => {
    calls.push({ text, values });
    return [];
  };
  const source = {
    access: "read-write" as const,
    relations: tables,
    producer: {
      query,
      async first() {
        return null;
      },
      async run(text: string, values: unknown[] = []) {
        await query(text, values);
        return { changes: 1 };
      },
      async transaction(
        statements: readonly { text: string; values?: unknown[] }[],
      ) {
        return Promise.all(
          statements.map((statement) =>
            this.run(statement.text, statement.values),
          ),
        );
      },
    },
    sql: Object.assign(async () => [], { unsafe: query }) as PgSql,
  };
  const bindings = createPgProducerBindings(source, lanes);
  const env = {
    ...bindings,
    D1_STATE_TABLES: tables.join(","),
    D1_STATE: {
      prepare() {
        throw new Error("legacy D1 touched");
      },
      batch() {
        throw new Error("legacy D1 touched");
      },
    },
    HYPERDRIVE: {
      connectionString: "postgresql://unreachable.invalid/database",
    },
    NEON_WRITE_BUFFER_LANES: lanes.join(","),
    NEON_WRITE_BUFFER: {
      idFromName() {
        throw new Error("legacy buffer touched");
      },
    },
  };
  return { source, bindings, env, calls };
}

describe("native producer ownership", () => {
  test("keeps the actual shared source handles and exposes no pool closer", async () => {
    const f = fixture();
    const selected = selectedNativeProducerStore(f.env, [
      "subnet_burn_history",
    ]);
    assert.ok(selected);
    assert.equal("close" in selected, false);
    assert.equal(Object.isFrozen(selected), true);
    const owner = producerStore(mockEnv(f.env), undefined, [
      "subnet_burn_history",
    ]);
    await selected.run("INSERT", [true]);
    owner.close();
    assert.deepEqual(f.calls, [{ text: "INSERT", values: [true] }]);
    assert.equal(owner.db, selected);
    assert.throws(
      () =>
        producerStore(mockEnv(f.env), undefined, [
          "neuron_daily",
          "chain_concentration_daily",
        ]),
      /does not own/,
    );
    assert.throws(() => selectedNativeProducerStore(f.env, []), /does not own/);
    assert.equal(
      selectedNativeProducerStore({}, ["subnet_burn_history"]),
      undefined,
    );
    assert.throws(
      () =>
        selectedNativeProducerStore({ NATIVE_WRITE_RUNNERS: {} }, [
          "subnet_burn_history",
        ]),
      /unavailable/,
    );
  });

  test.each([
    null,
    {},
    { tables: [] },
    { tables: [1], store: {} },
    { tables: ["x"], store: {} },
  ])("refuses malformed producer selection %#", (value) => {
    assert.throws(
      () =>
        selectedNativeProducerStore({ NATIVE_PRODUCER_STORE: value }, ["x"]),
      /invalid/,
    );
  });

  test("makes a missing native lane fail instead of falling back", () => {
    const f = fixture();
    assert.equal(
      neonWriteRunner(f.env, null, "tao-usd-index", f.env.HYPERDRIVE),
      f.bindings.NATIVE_WRITE_RUNNERS["tao-usd-index"],
    );
    assert.equal(neonWriteBufferEnabled(f.env, "tao-usd-index"), false);
    assert.throws(
      () => neonWriteRunner(f.env, null, "neurons", f.env.HYPERDRIVE),
      /unavailable/,
    );
    assert.throws(
      () => neonWriteBufferEnabled(f.env, "missing"),
      /unavailable/,
    );
    assert.equal(selectedNativeWriteRunner({}, "tao-usd-index"), undefined);
    assert.throws(
      () =>
        selectedNativeWriteRunner(
          { NATIVE_PRODUCER_STORE: f.bindings.NATIVE_PRODUCER_STORE },
          "tao-usd-index",
        ),
      /unavailable/,
    );
    for (const value of [
      null,
      {},
      { x: null },
      { x: {} },
      { x: { unsafe: 1 } },
    ])
      assert.throws(
        () => selectedNativeWriteRunner({ NATIVE_WRITE_RUNNERS: value }, "x"),
        /unavailable/,
      );
  });

  test("capture caller gates and tagged diff reads select native ownership", async () => {
    const f = fixture();
    const env = dataApiEnv(f.env);
    assert.equal(neonOwnsLedger(dataApiEnv(), "account-balances"), false);
    assert.equal(neonOwnsFamily(dataApiEnv(), "account-identity"), false);
    assert.equal(neonOwnsNominatorPositions(dataApiEnv()), false);
    assert.equal(neonOwnsChainDetail(dataApiEnv()), false);
    assert.equal(neonOwnsLedger(env, "account-balances"), true);
    assert.equal(neonOwnsFamily(env, "account-identity"), true);
    assert.equal(neonOwnsNominatorPositions(env), true);
    assert.equal(neonOwnsChainDetail(env), true);
    assert.throws(() => neonOwnsFamily(env, "unknown"), /unavailable/);
    const sql = selectedNativeProducerSql(f.env, ["account_identity"]);
    assert.ok(sql);
    await sql`SELECT name FROM account_identity WHERE account=${"a"}`;
    await sql.unsafe("SELECT name FROM account_identity");
    assert.deepEqual(f.calls, [
      {
        text: "SELECT name FROM account_identity WHERE account=$1",
        values: ["a"],
      },
      { text: "SELECT name FROM account_identity", values: [] },
    ]);
    assert.equal(
      selectedNativeProducerSql({}, ["account_identity"]),
      undefined,
    );
  });

  test("validates writable source, known complete lanes and stable snapshots", () => {
    const f = fixture();
    assert.throws(
      () => createPgProducerBindings({ ...f.source, access: "read" }, lanes),
      /writable/,
    );
    assert.throws(
      () => createPgProducerBindings({ ...f.source, relations: [] }, lanes),
      /writable/,
    );
    assert.throws(
      () => createPgProducerBindings(f.source, ["blocks-head", "blocks-head"]),
      /unique/,
    );
    assert.throws(
      () =>
        createPgProducerBindings(
          f.source,
          Array.from({ length: 21 }, (_, i) => String(i)),
        ),
      /bounded/,
    );
    assert.throws(
      () => createPgProducerBindings(f.source, ["neurons"]),
      /does not own/,
    );
    assert.throws(
      () =>
        createPgProducerBindings({ ...f.source, relations: ["hotkey_alpha"] }, [
          "hotkey-alpha",
        ]),
      /does not own/,
    );
    const requested = ["blocks-head"];
    const bindings = createPgProducerBindings(f.source, requested);
    requested.push("unknown");
    assert.deepEqual(Object.keys(bindings.NATIVE_WRITE_RUNNERS), [
      "blocks-head",
    ]);
    assert.equal(Object.isFrozen(bindings.NATIVE_WRITE_RUNNERS), true);
  });

  test("native capture writers bypass D1 and buffering with no request context", async () => {
    const f = fixture();
    const deps = { laneHealthDb: null };
    await mirrorBlocksHeadToNeon(
      f.env,
      null,
      {
        block_number: 1,
        block_hash: "0x1",
        parent_hash: "0x0",
        extrinsic_count: 1,
        event_count: null,
        author: null,
        observed_at: 1790000000000,
      },
      deps,
    );
    await mirrorRawCaptureStateToNeon(
      f.env,
      null,
      "mainnet",
      1,
      1790000000000,
      deps,
    );
    await mirrorChainDetailToNeon(
      f.env,
      null,
      {
        blockRows: [{ block_number: 1, economics_complete: 1 }],
        extrinsicRows: [{ block_number: 1, extrinsic_index: 0, success: 1 }],
        chainEventRows: [],
        accountEventRows: [],
      },
      deps,
    );
    assert.ok(f.calls.some((call) => call.text.includes("blocks_head")));
    assert.ok(f.calls.some((call) => call.text.includes("raw_capture_state")));
    const extrinsic = f.calls.find((call) =>
      call.text.includes("chain_detail_extrinsics"),
    );
    assert.ok(extrinsic?.values.includes(true));
    const block = f.calls.find((call) =>
      call.text.includes("chain_detail_blocks"),
    );
    assert.ok(block?.values.includes(true));
    await assert.rejects(
      mirrorNeuronSnapshotToNeon(
        f.env,
        null,
        { rows: [], dailyRows: [], positionRows: [] },
        deps,
      ),
      /capture store is required/,
    );
  });

  test("native ledger and family writers bypass old bindings", async () => {
    const f = fixture();
    const deps = { laneHealthDb: null };
    await mirrorLedgerToNeon(
      f.env,
      null,
      "account-balances",
      [{ ss58: "a", free_tao: 1, reserved_tao: 0, captured_at: 1790000000000 }],
      deps,
    );
    await mirrorFamilyToNeon(
      f.env,
      null,
      "subnet-ownership",
      {
        rows: [
          {
            netuid: 1,
            owner_hotkey: "h",
            owner_coldkey: "c",
            captured_at: 1790000000000,
          },
        ],
        historyRows: [],
      },
      deps,
    );
    await mirrorNominatorPositionsToNeon(
      f.env,
      null,
      {
        rows: [
          {
            coldkey: "c",
            hotkey: "h",
            netuid: 1,
            share_fraction: 1,
            captured_at: 1790000000000,
          },
        ],
        coldkeyMaxCapturedAt: new Map(),
      },
      deps,
    );
    assert.ok(f.calls.some((call) => call.text.includes("account_balances")));
    assert.ok(f.calls.some((call) => call.text.includes("subnet_ownership")));
    assert.ok(
      f.calls.some((call) => call.text.includes("nominator_positions")),
    );
  });

  test("native TAO/USD writes persist through the selected runner", async () => {
    const f = fixture();
    const result = await writeTaoUsdIndexRow(dataApiEnv(f.env), {
      block_number: 1,
      observed_at: 1790000000000,
      usd_per_tao: 1,
      price_basis: "wrapped_onchain_median",
      eth_usd: 1,
      pool_count: 2,
      pools: [],
    });
    assert.equal(result.written, true);
    assert.ok(f.calls.some((call) => call.text.includes("tao_usd_index")));
  });

  test("native resume reads preserve numbers, empty heads and failures", async () => {
    for (const value of [
      null,
      "15",
      "invalid",
      undefined,
      new Error("query failed"),
    ]) {
      const f = fixture();
      const env = dataApiEnv({
        ...f.env,
        CHAIN_DETAIL_SYNC_SECRET: "fixture",
        NATIVE_PRODUCER_STORE: {
          ...f.bindings.NATIVE_PRODUCER_STORE,
          store: {
            ...f.bindings.NATIVE_PRODUCER_STORE.store,
            first: async () => {
              if (value instanceof Error) throw value;
              return value === undefined ? null : { head: value };
            },
          },
        },
      });
      const response = await dataApi.fetch(
        new Request(
          "https://fixture.invalid/api/v1/internal/chain-detail-sync/head",
          { headers: { "x-chain-detail-sync-token": "fixture" } },
        ),
        env,
        { waitUntil() {} },
      );
      assert.equal(
        response.status,
        value === null || value === "15" ? 200 : 503,
      );
      if (response.status === 200)
        assert.deepEqual(await response.json(), {
          head: value === null ? null : 15,
        });
    }
  });

  test("native identity sync performs its diff read without Hyperdrive", async () => {
    const f = fixture();
    const env = dataApiEnv({
      ...f.env,
      ACCOUNT_IDENTITY_SYNC_SECRET: "fixture",
    });
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
            { account: "a", name: "name", captured_at: 1790000000000 },
          ]),
        },
      ),
      env,
      { waitUntil() {} },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok(f.calls.some((call) => call.text.includes("SELECT h.account")));
    assert.ok(
      f.calls.some((call) =>
        call.text.includes("INSERT INTO account_identity"),
      ),
    );
  });
});
