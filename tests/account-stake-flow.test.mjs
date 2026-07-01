import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildAccountStakeFlow,
  loadAccountStakeFlow,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
  DEFAULT_STAKE_FLOW_WINDOW,
} from "../src/account-stake-flow.mjs";

// One GROUP BY netuid, event_kind row.
function row(netuid, kind, tao, count, lastObserved) {
  return {
    netuid,
    event_kind: kind,
    total_tao: tao,
    event_count: count,
    last_observed: lastObserved,
  };
}
const added = (netuid, tao, count = 1, at = 1000) =>
  row(netuid, STAKE_ADDED_KIND, tao, count, at);
const removed = (netuid, tao, count = 1, at = 1000) =>
  row(netuid, STAKE_REMOVED_KIND, tao, count, at);

const ADDR = "5GReferenceAccountAddressForStakeFlowTestssssssss";

describe("buildAccountStakeFlow", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildAccountStakeFlow(rows, ADDR, { window: "30d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.address, ADDR);
      assert.equal(d.window, "30d");
      assert.equal(d.total_staked_tao, 0);
      assert.equal(d.net_flow_tao, 0);
      assert.equal(d.gross_flow_tao, 0);
      assert.equal(d.flow_ratio, null);
      assert.equal(d.direction, "idle");
      assert.equal(d.subnet_count, 0);
      assert.equal(d.concentration, null);
      assert.equal(d.dominant_netuid, null);
      assert.deepEqual(d.subnets, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildAccountStakeFlow([], ADDR).window, null);
  });

  test("folds per-(netuid, kind) rows into per-subnet net + gross flow", () => {
    const d = buildAccountStakeFlow(
      [added(1, 100, 3), removed(1, 40, 2), added(2, 10, 1)],
      ADDR,
      { window: "30d" },
    );
    const s1 = d.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.staked_tao, 100);
    assert.equal(s1.unstaked_tao, 40);
    assert.equal(s1.net_flow_tao, 60);
    assert.equal(s1.gross_flow_tao, 140);
    assert.equal(s1.stake_events, 3);
    assert.equal(s1.unstake_events, 2);
    // account totals
    assert.equal(d.total_staked_tao, 110);
    assert.equal(d.total_unstaked_tao, 40);
    assert.equal(d.net_flow_tao, 70);
    assert.equal(d.gross_flow_tao, 150);
    assert.equal(d.stake_events, 4);
    assert.equal(d.unstake_events, 2);
    assert.equal(d.subnet_count, 2);
  });

  test("classifies direction by the net/gross lean", () => {
    // accumulating: net>0 past the ratio
    assert.equal(
      buildAccountStakeFlow([added(1, 100)], ADDR).direction,
      "accumulating",
    );
    // exiting: net<0 past the ratio
    assert.equal(
      buildAccountStakeFlow([removed(1, 100)], ADDR).direction,
      "exiting",
    );
    // churning: both ways, small net lean (10/100 = 0.1 < 0.2)
    assert.equal(
      buildAccountStakeFlow([added(1, 55), removed(1, 45)], ADDR).direction,
      "churning",
    );
    // idle: a zero-sum subnet (gross 0) reads idle
    assert.equal(
      buildAccountStakeFlow([added(1, 0, 1)], ADDR).direction,
      "idle",
    );
  });

  test("flow_ratio is net/gross to 4dp, null when gross is 0", () => {
    assert.equal(
      buildAccountStakeFlow([added(1, 75), removed(1, 25)], ADDR).flow_ratio,
      0.5,
    );
    assert.equal(
      buildAccountStakeFlow([added(1, 0, 1)], ADDR).flow_ratio,
      null,
    );
  });

  test("concentration is the HHI of gross flow across subnets", () => {
    // all flow in one subnet -> 1
    assert.equal(buildAccountStakeFlow([added(1, 100)], ADDR).concentration, 1);
    // two equal-gross subnets -> (0.5^2)*2 = 0.5
    assert.equal(
      buildAccountStakeFlow([added(1, 100), added(2, 100)], ADDR).concentration,
      0.5,
    );
  });

  test("reports the dominant subnet by gross and ranks subnets by gross desc", () => {
    const d = buildAccountStakeFlow(
      [added(5, 10), added(9, 300), added(2, 50)],
      ADDR,
    );
    assert.equal(d.dominant_netuid, 9);
    assert.deepEqual(
      d.subnets.map((s) => s.netuid),
      [9, 2, 5],
    );
  });

  test("ties on gross break by netuid ascending", () => {
    const d = buildAccountStakeFlow([added(7, 100), added(3, 100)], ADDR);
    assert.deepEqual(
      d.subnets.map((s) => s.netuid),
      [3, 7],
    );
  });

  test("equal-gross subnets keep dominant_netuid deterministic (tie-break, not row order)", () => {
    // Rows arrive netuid 7 then 3 (D1 row order); equal gross must still resolve to the
    // netuid tie-break, and dominant_netuid must agree with the head of the sorted list.
    const d = buildAccountStakeFlow([added(7, 50), added(3, 50)], ADDR);
    assert.deepEqual(
      d.subnets.map((s) => s.netuid),
      [3, 7],
    );
    assert.equal(d.dominant_netuid, 3);
    assert.equal(d.dominant_netuid, d.subnets[0].netuid);
  });

  test("truncates a fractional event_count to an integer", () => {
    const d = buildAccountStakeFlow([added(1, 100, 2.9)], ADDR);
    assert.equal(d.stake_events, 2);
    assert.equal(d.subnets[0].stake_events, 2);
  });

  test("skips malformed netuid cells and non-stake event kinds", () => {
    const d = buildAccountStakeFlow(
      [
        added(null, 100),
        added(-1, 100),
        row(1, "Transfer", 100, 1, 1000),
        added(1, 25),
      ],
      ADDR,
    );
    assert.equal(d.subnet_count, 1);
    assert.equal(d.total_staked_tao, 25);
  });

  test("rounds tao output to rao precision", () => {
    const d = buildAccountStakeFlow([added(1, 0.1), removed(1, 0.2)], ADDR);
    assert.equal(d.net_flow_tao, -0.1);
  });

  test("coerces a non-numeric tao / count cell to 0", () => {
    const d = buildAccountStakeFlow(
      [{ netuid: 1, event_kind: STAKE_ADDED_KIND, total_tao: "n/a" }],
      ADDR,
    );
    assert.equal(d.total_staked_tao, 0);
    assert.equal(d.stake_events, 0); // undefined event_count -> 0
    assert.equal(d.subnet_count, 1);
  });
});

describe("loadAccountStakeFlow", () => {
  test("queries account_events by hotkey + stake kinds, shapes the result", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [added(1, 100, 2, 5000), removed(1, 30, 1, 6000)];
    };
    const d = await loadAccountStakeFlow(d1, ADDR, { windowLabel: "30d" });
    assert.match(calls[0].sql, /FROM account_events/);
    assert.match(calls[0].sql, /WHERE hotkey = \?/);
    assert.match(calls[0].sql, /GROUP BY netuid, event_kind/);
    assert.equal(calls[0].params[0], ADDR);
    assert.equal(calls[0].params[1], STAKE_ADDED_KIND);
    assert.equal(calls[0].params[2], STAKE_REMOVED_KIND);
    assert.equal(d.data.net_flow_tao, 70);
    // generatedAt = newest observed_at as ISO
    assert.equal(d.generatedAt, new Date(6000).toISOString());
  });

  test("defaults to the 30d window", async () => {
    const d1 = async () => [];
    const d = await loadAccountStakeFlow(d1, ADDR, {});
    assert.equal(d.data.window, DEFAULT_STAKE_FLOW_WINDOW);
  });

  test("an unknown window label falls back to the 30d cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let cutoff;
    const d1 = async (sql, params) => {
      cutoff = params[3];
      return [];
    };
    await loadAccountStakeFlow(d1, ADDR, { windowLabel: "bogus" });
    assert.equal(cutoff, Date.now() - 30 * 24 * 60 * 60 * 1000);
    vi.useRealTimers();
  });

  test("cold store yields zeros + generatedAt null", async () => {
    const d1 = async () => [];
    const d = await loadAccountStakeFlow(d1, ADDR, { windowLabel: "7d" });
    assert.equal(d.data.subnet_count, 0);
    assert.equal(d.generatedAt, null);
  });

  test("a non-array result degrades to an empty card", async () => {
    const d1 = async () => null;
    const d = await loadAccountStakeFlow(d1, ADDR, { windowLabel: "7d" });
    assert.deepEqual(d.data.subnets, []);
    assert.equal(d.generatedAt, null);
  });

  test("generatedAt picks the max observed_at regardless of row order or bad cells", async () => {
    const d1 = async () => [
      added(1, 10, 1, 9000), // newest, seen first
      removed(1, 5, 1, 3000), // older, must not overwrite
      added(2, 1, 1, Number.NaN), // non-finite, ignored
    ];
    const d = await loadAccountStakeFlow(d1, ADDR, { windowLabel: "7d" });
    assert.equal(d.generatedAt, new Date(9000).toISOString());
  });
});
