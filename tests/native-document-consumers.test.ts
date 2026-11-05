import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import { loadAccountRegistrationsFromStore } from "../src/account-summary-card.ts";
import { loadAccountWeightSettersColdTier } from "../src/account-feeds-cold-tier.ts";
import {
  ledgerCapturedAt,
  loadAccountPositionsColdTier,
  neuronStakeByHotkeys,
} from "../src/nominator-positions-cold-tier.ts";
import * as weights from "../src/account-weight-setters-native.ts";
import { runSubnetLifecycleLane } from "../src/subnet-lifecycle.ts";
import { loadSubnetLifecycle } from "../src/subnet-lifecycle-read.ts";
import {
  buildSubnetValidatorEconomicsPayload,
  buildSubnetValidatorEconomicsHistoryPayload,
  buildValidatorEconomicsRankingPayload,
} from "../workers/request-handlers/entities.ts";

const account = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
type Row = Record<string, unknown>;
function relational(
  tables: string[],
  answer: (text: string, values: unknown[]) => Row[] = () => [],
) {
  const calls: { text: string; values: unknown[] }[] = [];
  const query = async <T>(text: string, values: unknown[] = []) => {
    assert(
      !/\b(?:FROM|JOIN) (?:neurons|neuron_daily)\b/.test(text),
      "native relational store must not receive logical document SQL",
    );
    calls.push({ text, values });
    return answer(text, values) as T[];
  };
  return {
    calls,
    NATIVE_PROJECTIONS: "enabled",
    NATIVE_READ_STORE: {
      tables,
      store: {
        query,
        first: async <T>(text: string, values?: unknown[]) =>
          (await query<T>(text, values))[0] ?? null,
      },
    },
  };
}
afterEach(() => vi.restoreAllMocks());

test("the existing D1 lifecycle writer still records a complete capture", async () => {
  const fixture = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await fixture.getD1Database("DB");
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
          "subnet_lifecycle",
        ].includes(row.name),
    ))
      await db.prepare(object.sql).run();
    await db
      .prepare(
        "INSERT INTO neurons_documents VALUES(7,'',0,1800000000000,jsonb(?))",
      )
      .bind('{"1":{"captured_at":1800000000000,"block_number":100}}')
      .run();
    await db
      .prepare("INSERT INTO neurons_members VALUES(7,1,'fixture',NULL,0)")
      .run();
    await db
      .prepare(
        "INSERT INTO neurons_passes VALUES(1800000000000,1,1,1800000000000)",
      )
      .run();
    const result = await runSubnetLifecycleLane(
      {
        D1_STATE: db,
        D1_STATE_TABLES: "neurons,neurons_passes,subnet_lifecycle",
      },
      { coverageFloor: 1, now: () => 1800000000000 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.events, 1);
    const rows = (
      await db
        .prepare("SELECT netuid,event,predates_capture FROM subnet_lifecycle")
        .all()
    ).results;
    assert.deepEqual(rows, [
      { netuid: 7, event: "registered", predates_capture: 1 },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("native registration and weight-setter slots do not ask for logical SQL ownership", async () => {
  const rows = vi.fn(async (_query: unknown) => [
    { netuid: 7, uid: 3, stake_tao: 12, validator_permit: 1, active: 1 },
  ]);
  const env = { ...relational([]), NEURON_VIEW_STORE: { rows } };
  assert.equal(
    (await loadAccountRegistrationsFromStore(env as never, account))![0]!
      .stake_tao,
    12,
  );
  assert.deepEqual(rows.mock.calls[0], [
    {
      columns: ["netuid", "uid", "stake_tao", "validator_permit", "active"],
      hotkey: account,
      order: [{ column: "netuid" }],
    },
  ]);
  const loaded = vi
    .spyOn(weights, "loadNativeAccountWeightSetters")
    .mockResolvedValue([]);
  assert(await loadAccountWeightSettersColdTier(env, account));
  assert.deepEqual(loaded.mock.calls[0]![2], [{ netuid: 7, uid: 3 }]);
  rows.mockRejectedValue(new Error("unavailable"));
  assert.equal(
    await loadAccountRegistrationsFromStore(env as never, account),
    null,
  );
  assert.equal(await loadAccountWeightSettersColdTier(env, account), null);
});

test("native position pricing reads the real relational ledger and serializes bounded neuron chunks", async () => {
  const keys = Array.from({ length: 17 }, (_, index) => `key-${index}`);
  let active = 0;
  const rows = vi.fn(async (query: { hotkeys: readonly string[] }) => {
    assert.equal(++active, 1);
    await Promise.resolve();
    active--;
    return query.hotkeys.map((hotkey) => ({
      hotkey,
      netuid: 7,
      stake_tao: 10,
    }));
  });
  const db = relational(["nominator_positions"], (text) =>
    text.includes("MAX(captured_at)")
      ? [{ latest: "1785634702670" }]
      : [
          {
            hotkey: keys[0],
            netuid: 7,
            share_fraction: 0.25,
            captured_at: 1785634702670,
          },
        ],
  );
  const env = { ...db, NEURON_VIEW_STORE: { rows } };
  assert.equal((await neuronStakeByHotkeys(env, keys))!.size, 17);
  assert.deepEqual(
    rows.mock.calls.map(([query]) => query.hotkeys.length),
    [16, 1],
  );
  assert.equal(
    (await loadAccountPositionsColdTier(env, account))!.total_stake_alpha,
    2.5,
  );
  assert.equal(await ledgerCapturedAt(env), 1785634702670);
  rows.mockRejectedValue(new Error("unavailable"));
  assert.equal(await neuronStakeByHotkeys(env, keys), null);
  const incomplete = {
    ...env,
    NATIVE_READ_STORE: { ...env.NATIVE_READ_STORE, tables: [] },
  };
  assert.equal(await loadAccountPositionsColdTier(incomplete, account), null);
});

test("native lifecycle keeps invalidations and uses the declared producer", async () => {
  const db = relational(["subnet_lifecycle"], () => [
    { netuid: 1, event: "registered" },
  ]);
  const run = vi.fn(async (_text: string, _values?: unknown[]) => ({
    changes: 1,
  }));
  const completeRows = async () => [
    { netuid: 1, block_number: 100 },
    { netuid: 2, block_number: 100 },
  ];
  const env = {
    ...db,
    NEURON_SUMMARY_STORE: {
      completeRows,
      nominatorCounts: async () => [],
      dailyValidators: async () => [],
      dailyTotals: async () => [],
      subnetHistory: async () => [],
    },
    NATIVE_PRODUCER_STORE: {
      tables: ["subnet_lifecycle"],
      store: {
        ...db.NATIVE_READ_STORE.store,
        run,
        transaction: async () => [],
      },
    },
  };
  const result = await runSubnetLifecycleLane(env, {
    coverageFloor: 1,
    now: () => 1800000000000,
  });
  assert.equal(result.ok, true);
  assert.equal(run.mock.calls.length, 1);
  assert.deepEqual(run.mock.calls[0]![1], [
    2,
    "registered",
    100,
    1800000000000,
    false,
  ]);
  assert(
    db.calls.every(({ text }) => text.includes("_invalidated_at IS NULL")),
  );
  await loadSubnetLifecycle(env, 1, { limit: 10, offset: 0 });
  assert(db.calls.at(-1)!.text.includes("_invalidated_at IS NULL"));
  const missing = { ...env, NATIVE_PRODUCER_STORE: undefined };
  assert.equal(
    (await runSubnetLifecycleLane(missing, { coverageFloor: 1 })).ok,
    false,
  );
});

test("shared validator economics selects native documents and only relational SQL dependencies", async () => {
  const liveRows = [
    {
      netuid: 7,
      uid: 1,
      hotkey: "key",
      stake_tao: 5000,
      validator_permit: 1,
      active: 1,
      dividends: 0.5,
      take: 0.18,
    },
  ];
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dailyRows = [
    {
      snapshot_date: day,
      hotkey: "key",
      stake_tao: 5000,
      validator_permit: 1,
      active: 1,
      dividends: 0.5,
    },
  ];
  const db = relational(
    [
      "subnet_hyperparams",
      "subnet_hyperparams_history",
      "subnet_snapshots",
      "subnet_burn_history",
    ],
    (text) => {
      if (text.includes("subnet_snapshots"))
        return [{ snapshot_date: day, tao_in_emission_tao: 1 }];
      if (text.includes("subnet_hyperparams_history"))
        return [{ observed_at: Date.now() - 2 * 86400000, max_validators: 64 }];
      if (text.includes("subnet_hyperparams"))
        return [{ netuid: 7, max_validators: 64, min_childkey_take_ratio: 0 }];
      return [{ netuid: 7, burn_tao: 1 }];
    },
  );
  const economicsRows = vi.fn(async () => liveRows);
  const daily = vi.fn(async () => dailyRows);
  const env = {
    ...db,
    NEURON_LIVE_STORE: {
      economicsRows,
      newestCapture: async () => 1,
      directoryRows: async () => [],
    },
    NEURON_METRIC_STORE: { dailyRows: daily, performanceRows: async () => [] },
  };
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
  const one = await buildSubnetValidatorEconomicsPayload(env as never, 7, {
    loadParams: loadParams as never,
    loadBurn: (async () => ({ burn_tao: 1 })) as never,
    loadEconomicsRow: (async () => ({ row, generatedAt: null })) as never,
  });
  assert.equal(one.data.max_validators, 64);
  const history = await buildSubnetValidatorEconomicsHistoryPayload(
    env as never,
    7,
    "30d",
    { loadEconomicsRow: (async () => ({ row })) as never },
  );
  assert.equal((history.data.points as unknown[]).length, 1);
  const ranking = await buildValidatorEconomicsRankingPayload(
    env as never,
    { limit: 10, offset: 0 },
    {
      loadParams: loadParams as never,
      loadEconomics: (async () => ({
        rows: [row],
        generatedAt: null,
      })) as never,
    },
  );
  assert.equal((ranking.data.rows as unknown[]).length, 1);
  assert.equal(economicsRows.mock.calls.length, 2);
  assert.equal(daily.mock.calls.length, 1);
  assert(db.calls.length > 0);
});
