import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  parseHistoryWindow,
  buildNeuronHistory,
  buildSubnetHistory,
  buildEconomicsTrends,
  HISTORY_WINDOWS,
  MAX_HISTORY_POINTS,
} from "../src/neuron-history.ts";
import { buildConcentrationHistory } from "../src/concentration.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A neuron_daily read row (NEURON_DAILY_READ_COLUMNS shape: snapshot_date + the
// live neuron columns) — formatNeuron consumes the same fields.
function dailyRow(overrides = {}) {
  return {
    snapshot_date: "2026-06-20",
    uid: 3,
    hotkey: "5Hot",
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    validator_trust: 0.8,
    consensus: 0.7,
    incentive: 0.6,
    dividends: 0.4,
    emission_tao: 1.23,
    stake_tao: 456.7,
    registered_at_block: 100,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the SQL.
function historyEnv(rows, captured = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        captured.sql = sql;
        return {
          bind(...params) {
            captured.params = params;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

const ctx = { waitUntil: (p) => p };

describe("parseHistoryWindow", () => {
  test("accepts the documented windows + defaults", () => {
    assert.deepEqual(parseHistoryWindow("7d"), { label: "7d", days: 7 });
    assert.deepEqual(parseHistoryWindow("1y"), { label: "1y", days: 365 });
    assert.deepEqual(parseHistoryWindow("all"), { label: "all", days: null });
    // Missing → the default window, not an error.
    assert.equal(parseHistoryWindow(undefined).label, "30d");
  });
  test("rejects an unsupported window (NOT silently coerced like analyticsWindow)", () => {
    assert.deepEqual(parseHistoryWindow("400d").error, {
      parameter: "window",
      message:
        '"400d" is not a supported window. Supported: 7d, 30d, 90d, 1y, all.',
    });
    assert.equal(parseHistoryWindow("bogus").error.parameter, "window");
  });
  test("every window is bounded under MAX_HISTORY_POINTS", () => {
    for (const days of Object.values(HISTORY_WINDOWS)) {
      if (days != null) assert.ok(days <= MAX_HISTORY_POINTS);
    }
  });
});

describe("history builders", () => {
  test("buildNeuronHistory shapes a per-UID series (live-shaped points + date)", () => {
    const out = buildNeuronHistory([dailyRow()], 7, 3, { window: "30d" });
    assert.equal(out.netuid, 7);
    assert.equal(out.uid, 3);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].snapshot_date, "2026-06-20");
    assert.equal(out.points[0].stake_tao, 456.7);
    assert.equal(out.points[0].validator_permit, true); // formatNeuron coerces 0/1
  });
  test("buildSubnetHistory shapes per-day aggregates", () => {
    const out = buildSubnetHistory(
      [
        {
          snapshot_date: "2026-06-20",
          neuron_count: 256,
          validator_count: 64,
          total_stake_tao: 1000,
          total_emission_tao: 12.3,
        },
      ],
      7,
      { window: "90d" },
    );
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].neuron_count, 256);
    assert.equal(out.points[0].validator_count, 64);
  });

  test("buildSubnetHistory rounds the per-day TAO sums to drop float noise (#2354)", () => {
    // A per-day SUM(stake_tao)/SUM(emission_tao) over many REAL UID cells
    // accumulates float noise; the builder must round it like buildEconomicsTrends
    // instead of leaking the long fractional tail. A null SUM stays null.
    const out = buildSubnetHistory(
      [
        {
          snapshot_date: "2026-06-20",
          neuron_count: 3,
          validator_count: 1,
          total_stake_tao: 0.1 + 0.2, // 0.30000000000000004
          total_emission_tao: 1.005 + 2.005, // 3.0100000000000002
        },
        {
          snapshot_date: "2026-06-19",
          neuron_count: 0,
          validator_count: 0,
          total_stake_tao: null,
          total_emission_tao: null,
        },
      ],
      7,
    );
    assert.equal(out.points[0].total_stake_tao, 0.3);
    assert.equal(out.points[0].total_emission_tao, 3.01);
    // A null SUM (cold/sparse day) stays null, never coerced to 0.
    assert.equal(out.points[1].total_stake_tao, null);
    assert.equal(out.points[1].total_emission_tao, null);
  });

  test("buildNeuronHistory defaults window + per-point captured_at/block_number to null", () => {
    // A point row with no captured_at/block_number (sparse / pre-block-tag rows)
    // must still produce a schema-stable point — null, never undefined — and an
    // omitted window option must surface as window:null.
    const out = buildNeuronHistory(
      [dailyRow({ captured_at: undefined })],
      7,
      3,
    );
    assert.equal(out.window, null);
    assert.equal(out.points[0].captured_at, null);
    const sparse = buildNeuronHistory(
      [{ snapshot_date: "2026-06-20", hotkey: "5Hk" }],
      7,
      3,
    );
    assert.equal(sparse.points[0].block_number, null);
  });

  test("buildNeuronHistory coerces string-typed block_number cells to integers", () => {
    const out = buildNeuronHistory(
      [dailyRow({ block_number: "5000000" })],
      7,
      3,
    );
    assert.equal(out.points[0].block_number, 5_000_000);
  });

  test("buildNeuronHistory rejects invalid block_number cells to null", () => {
    const out = buildNeuronHistory(
      [
        dailyRow({ block_number: -1 }),
        dailyRow({ block_number: 1.5 }),
        dailyRow({ block_number: "abc" }),
        dailyRow({ block_number: "" }),
        dailyRow({ block_number: " " }),
      ],
      7,
      3,
    );
    assert.equal(out.points[0].block_number, null);
    assert.equal(out.points[1].block_number, null);
    assert.equal(out.points[2].block_number, null);
    assert.equal(out.points[3].block_number, null);
    assert.equal(out.points[4].block_number, null);
  });

  test("buildNeuronHistory coerces string-typed captured_at cells to ISO timestamps", () => {
    const out = buildNeuronHistory(
      [dailyRow({ captured_at: "1780000000000" })],
      7,
      3,
    );
    assert.equal(
      out.points[0].captured_at,
      new Date(1780000000000).toISOString(),
    );
  });

  test("buildNeuronHistory preserves null captured_at as null (not epoch 1970)", () => {
    const out = buildNeuronHistory([dailyRow({ captured_at: null })], 7, 3);
    assert.equal(out.points[0].captured_at, null);
  });

  test("buildNeuronHistory drops invalid captured_at strings to null", () => {
    const out = buildNeuronHistory(
      [dailyRow({ captured_at: "not-a-timestamp" })],
      7,
      3,
    );
    assert.equal(out.points[0].captured_at, null);
  });

  test("buildNeuronHistory drops blank captured_at strings to null (not epoch 1970)", () => {
    const out = buildNeuronHistory([dailyRow({ captured_at: "" })], 7, 3);
    assert.equal(out.points[0].captured_at, null);
  });

  test("buildNeuronHistory drops out-of-range captured_at strings to null", () => {
    const out = buildNeuronHistory(
      [dailyRow({ captured_at: "8640000000000001" })],
      7,
      3,
    );
    assert.equal(out.points[0].captured_at, null);
  });

  test("buildSubnetHistory defaults window + every aggregate to null on sparse rows", () => {
    const out = buildSubnetHistory([{ snapshot_date: "2026-06-20" }], 7);
    assert.equal(out.window, null);
    assert.equal(out.points[0].neuron_count, null);
    assert.equal(out.points[0].validator_count, null);
    assert.equal(out.points[0].total_stake_tao, null);
    assert.equal(out.points[0].total_emission_tao, null);
  });

  test("buildSubnetHistory coerces string-typed aggregate counts to integers", () => {
    const out = buildSubnetHistory(
      [
        {
          snapshot_date: "2026-06-20",
          neuron_count: "256",
          validator_count: "64",
        },
      ],
      7,
    );
    assert.equal(out.points[0].neuron_count, 256);
    assert.equal(out.points[0].validator_count, 64);
  });

  test("buildSubnetHistory rejects invalid aggregate counts to null", () => {
    const out = buildSubnetHistory(
      [
        {
          snapshot_date: "2026-06-20",
          neuron_count: -1,
          validator_count: 1.5,
        },
        {
          snapshot_date: "2026-06-19",
          neuron_count: "abc",
          validator_count: null,
        },
      ],
      7,
    );
    assert.equal(out.points[0].neuron_count, null);
    assert.equal(out.points[0].validator_count, null);
    assert.equal(out.points[1].neuron_count, null);
    assert.equal(out.points[1].validator_count, null);
  });

  test("buildEconomicsTrends rolls per-subnet rows up to one network point per day", () => {
    const out = buildEconomicsTrends(
      [
        // newest first; day A has two subnets, day B one.
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 300,
          alpha_price_tao: 0.02,
          validator_count: 8,
          miner_count: 50,
          emission_share: 0.04,
        },
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 100,
          alpha_price_tao: 0.06,
          validator_count: 2,
          miner_count: 10,
          emission_share: 0.02,
        },
        {
          snapshot_date: "2026-06-01",
          total_stake_tao: 100,
          alpha_price_tao: 0.01,
          validator_count: 4,
          miner_count: 20,
          emission_share: 0.03,
        },
      ],
      { window: "7d" },
    );
    assert.equal(out.schema_version, 1);
    assert.equal(out.window, "7d");
    assert.equal(out.day_count, 2);
    const [recent] = out.days;
    assert.equal(recent.snapshot_date, "2026-06-02");
    assert.equal(recent.subnet_count, 2);
    assert.equal(recent.total_stake_tao, "400.000000000");
    // (0.02·300 + 0.06·100)/400 = 0.03 weighted; median([0.02,0.06]) = 0.04.
    assert.equal(recent.alpha_price_tao_weighted, 0.03);
    assert.equal(recent.alpha_price_tao_median, 0.04);
    assert.equal(recent.mean_emission_share, 0.03);
  });

  test("buildEconomicsTrends drops the partial oldest day when the read was capped", () => {
    // A row-capped read truncates the oldest snapshot_date mid-day (only some of
    // that day's subnets survive the LIMIT), so its network total is spuriously
    // small. capped:true must drop it, matching buildConcentrationHistory.
    const rows = [
      { snapshot_date: "2026-06-02", total_stake_tao: 300, validator_count: 8 },
      // 2026-06-01 really had the full network but only one subnet fell inside the cap.
      { snapshot_date: "2026-06-01", total_stake_tao: 5, validator_count: 1 },
    ];
    const capped = buildEconomicsTrends(rows, { window: "all", capped: true });
    assert.equal(capped.day_count, 1);
    assert.deepEqual(
      capped.days.map((d) => d.snapshot_date),
      ["2026-06-02"], // the partial oldest 2026-06-01 is dropped
    );
    // Without the cap flag the same rows keep every day (the default path).
    const full = buildEconomicsTrends(rows, { window: "all" });
    assert.equal(full.day_count, 2);
  });

  test("buildEconomicsTrends keeps a lone day even when capped (never empties the series)", () => {
    // Only one day present: there is no complete day behind it to fall back to, so
    // the guard keeps it rather than returning an empty series.
    const out = buildEconomicsTrends(
      [
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 100,
          validator_count: 4,
        },
      ],
      { capped: true },
    );
    assert.equal(out.day_count, 1);
    assert.equal(out.days[0].snapshot_date, "2026-06-02");
  });

  test("buildEconomicsTrends skips zero-stake rows from the weighted price, keeps them in the median", () => {
    const out = buildEconomicsTrends([
      {
        snapshot_date: "2026-06-05",
        total_stake_tao: 0,
        alpha_price_tao: 0.5,
        validator_count: 1,
        miner_count: 1,
        emission_share: 0.1,
      },
      {
        snapshot_date: "2026-06-05",
        total_stake_tao: 200,
        alpha_price_tao: 0.1,
        validator_count: 3,
        miner_count: 5,
        emission_share: 0.2,
      },
    ]);
    const [day] = out.days;
    // Only the staked row carries the weighted mean → 0.1.
    assert.equal(day.alpha_price_tao_weighted, 0.1);
    // Both prices count toward the unweighted median → median([0.1,0.5]) = 0.3.
    assert.equal(day.alpha_price_tao_median, 0.3);
    assert.equal(day.total_stake_tao, "200.000000000");
    assert.equal(day.window, undefined);
  });

  test("buildEconomicsTrends excludes blank-string cells from the day's aggregate", () => {
    const out = buildEconomicsTrends([
      {
        snapshot_date: "2026-06-05",
        total_stake_tao: "",
        alpha_price_tao: "",
        validator_count: "",
        miner_count: "",
        emission_share: "",
      },
      {
        snapshot_date: "2026-06-05",
        total_stake_tao: 200,
        alpha_price_tao: 0.1,
        validator_count: 3,
        miner_count: 5,
        emission_share: 0.2,
      },
    ]);
    const [day] = out.days;
    // Blank row contributes nothing: aggregates match the single real row, not
    // a 0-inflated/deflated blend.
    assert.equal(day.subnet_count, 2);
    assert.equal(day.total_stake_tao, "200.000000000");
    assert.equal(day.alpha_price_tao_weighted, 0.1);
    assert.equal(day.alpha_price_tao_median, 0.1);
    assert.equal(day.validator_count, 3);
    assert.equal(day.miner_count, 5);
    assert.equal(day.mean_emission_share, 0.2);
  });

  test("buildEconomicsTrends is empty + null-safe on no rows", () => {
    const out = buildEconomicsTrends([]);
    assert.equal(out.day_count, 0);
    assert.deepEqual(out.days, []);
    assert.equal(out.window, null);
  });

  test("buildNeuronHistory drops malformed rows and the count tracks the array (#1793)", () => {
    // A null/non-object row can't become a Neuron point, so it must not leak into
    // the array — and the count tracks the array (point_count === points.length),
    // mirroring the blocks/extrinsics/metagraph builders' .filter(Boolean). A
    // non-object element must also degrade gracefully, never throw.
    const out = buildNeuronHistory(
      [dailyRow(), null, dailyRow({ uid: 9 }), undefined, 0],
      7,
      3,
    );
    assert.equal(out.points.length, 2);
    assert.equal(out.point_count, 2);
    assert.ok(out.points.every(Boolean));
    assert.deepEqual(
      out.points.map((p) => p.uid),
      [3, 9],
    );
    // A null/undefined rows argument is tolerated (empty series, never throws).
    assert.deepEqual(buildNeuronHistory(null, 7, 3).points, []);
  });

  test("buildSubnetHistory drops malformed rows and the count tracks the array (#1793)", () => {
    const out = buildSubnetHistory(
      [{ snapshot_date: "2026-06-20", neuron_count: 256 }, null, undefined],
      7,
    );
    assert.equal(out.points.length, 1);
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].neuron_count, 256);
    assert.deepEqual(buildSubnetHistory(undefined, 7).points, []);
  });
});

describe("stake aggregates surface when the rolled rows carry stake (P7)", () => {
  // Locks the documented historical behaviour: a day whose neuron_daily rows have
  // a real per-UID stake distribution yields populated total_stake_tao / stake_gini
  // / stake_nakamoto, while a day backfilled with stake_tao = null yields nulls —
  // the exact split observed in production (stake populated from 2026-06-22, the
  // day the forward rollup began carrying it; null before, from the backfill).
  test("buildSubnetHistory: SUM(stake) day -> number, null-stake day -> null", () => {
    const out = buildSubnetHistory(
      [
        // A populated forward-rollup day (SQL SUM(stake_tao) is a number).
        {
          snapshot_date: "2026-06-22",
          neuron_count: 2,
          validator_count: 1,
          total_stake_tao: 150,
          total_emission_tao: 3,
        },
        // A backfilled day: SUM over all-null stake_tao -> SQLite returns NULL.
        {
          snapshot_date: "2026-06-21",
          neuron_count: 2,
          validator_count: 1,
          total_stake_tao: null,
          total_emission_tao: 3,
        },
      ],
      64,
      { window: "30d" },
    );
    assert.equal(out.points[0].total_stake_tao, 150);
    assert.equal(out.points[0].total_emission_tao, 3);
    // The backfilled day keeps emission but nulls stake (the production gap).
    assert.equal(out.points[1].total_stake_tao, null);
    assert.equal(out.points[1].total_emission_tao, 3);
  });

  test("buildConcentrationHistory: stake metrics null on a null-stake day, populated otherwise", () => {
    const out = buildConcentrationHistory(
      [
        // Forward-rollup day: real per-UID stake distribution.
        { snapshot_date: "2026-06-22", stake_tao: 100, emission_tao: 10 },
        { snapshot_date: "2026-06-22", stake_tao: 1, emission_tao: 1 },
        // Backfilled day: stake_tao null, emission present.
        { snapshot_date: "2026-06-21", stake_tao: null, emission_tao: 10 },
        { snapshot_date: "2026-06-21", stake_tao: null, emission_tao: 1 },
      ],
      64,
      { window: "30d" },
    );
    assert.equal(out.points[0].snapshot_date, "2026-06-22");
    assert.equal(typeof out.points[0].stake_gini, "number");
    assert.equal(out.points[0].stake_nakamoto_coefficient, 1);
    assert.equal(typeof out.points[0].stake_top_10pct_share, "number");
    // The backfilled day has no stake distribution -> stake metrics null, but
    // emission metrics still populate (proves it's a stake-data gap, not a builder
    // bug).
    assert.equal(out.points[1].snapshot_date, "2026-06-21");
    assert.equal(out.points[1].stake_gini, null);
    assert.equal(out.points[1].stake_nakamoto_coefficient, null);
    assert.equal(out.points[1].stake_top_10pct_share, null);
    assert.equal(typeof out.points[1].emission_gini, "number");
  });
});

describe("history endpoints (via the Worker dispatch)", () => {
  test("an unsupported ?window is a 400, never a silent coerce", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/neurons/3/history?window=400d",
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(
      body.error.message,
      '"400d" is not a supported window. Supported: 7d, 30d, 90d, 1y, all.',
    );
    assert.equal(body.meta.parameter, "window");
  });
});
