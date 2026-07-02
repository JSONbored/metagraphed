import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildStakeFlow,
  loadSubnetStakeFlow,
  STAKE_FLOW_WINDOWS,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
  DEFAULT_STAKE_FLOW_WINDOW,
} from "../src/stake-flow.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildStakeFlow", () => {
  test("cold / empty / non-array inputs yield schema-stable zeros", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildStakeFlow(rows, 7, { window: "30d" });
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.window, "30d");
      assert.equal(data.total_staked_tao, 0);
      assert.equal(data.total_unstaked_tao, 0);
      assert.equal(data.net_flow_tao, 0);
      assert.equal(data.stake_events, 0);
      assert.equal(data.unstake_events, 0);
    }
  });

  test("window defaults to null when omitted", () => {
    assert.equal(buildStakeFlow([], 1).window, null);
  });

  test("sums StakeAdded as inflow and StakeRemoved as outflow; net = staked - unstaked", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: 100.5, event_count: 4 },
      { event_kind: STAKE_REMOVED_KIND, total_tao: 40.25, event_count: 3 },
    ];
    const data = buildStakeFlow(rows, 7, { window: "30d" });
    assert.equal(data.total_staked_tao, 100.5);
    assert.equal(data.total_unstaked_tao, 40.25);
    assert.equal(data.net_flow_tao, 60.25);
    assert.equal(data.stake_events, 4);
    assert.equal(data.unstake_events, 3);
  });

  test("net flow is negative when outflow exceeds inflow", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: 10, event_count: 1 },
      { event_kind: STAKE_REMOVED_KIND, total_tao: 25, event_count: 2 },
    ];
    assert.equal(buildStakeFlow(rows, 7, {}).net_flow_tao, -15);
  });

  test("only one kind present leaves the other side zero", () => {
    const added = buildStakeFlow(
      [{ event_kind: STAKE_ADDED_KIND, total_tao: 5, event_count: 1 }],
      7,
      {},
    );
    assert.equal(added.total_staked_tao, 5);
    assert.equal(added.total_unstaked_tao, 0);
    assert.equal(added.net_flow_tao, 5);
    const removed = buildStakeFlow(
      [{ event_kind: STAKE_REMOVED_KIND, total_tao: 5, event_count: 1 }],
      7,
      {},
    );
    assert.equal(removed.total_unstaked_tao, 5);
    assert.equal(removed.total_staked_tao, 0);
    assert.equal(removed.net_flow_tao, -5);
  });

  test("coerces numeric-string D1 cells and ignores unknown kinds", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: "12.5", event_count: "2" },
      { event_kind: "WeightsSet", total_tao: "999", event_count: "9" },
    ];
    const data = buildStakeFlow(rows, 1, {});
    assert.equal(data.total_staked_tao, 12.5);
    assert.equal(data.stake_events, 2);
    assert.equal(data.total_unstaked_tao, 0);
    assert.equal(data.unstake_events, 0);
  });

  test("rounds TAO sums to rao precision (no IEEE-754 dust)", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: 0.1 + 0.2, event_count: 1 },
    ];
    const data = buildStakeFlow(rows, 1, {});
    // 0.1 + 0.2 = 0.30000000000000004 -> rounded to rao (9dp) = 0.3
    assert.equal(data.total_staked_tao, 0.3);
    assert.equal(data.net_flow_tao, 0.3);
  });

  test("null / non-finite total_tao defaults to zero", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: null, event_count: 0 },
      { event_kind: STAKE_REMOVED_KIND, total_tao: "nope", event_count: 0 },
    ];
    const data = buildStakeFlow(rows, 1, {});
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.total_unstaked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
  });
});

describe("loadSubnetStakeFlow", () => {
  test("queries account_events for both stake kinds over the window cutoff and shapes the result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 200,
          event_count: 5,
          last_observed: 1717000000000,
        },
        {
          event_kind: STAKE_REMOVED_KIND,
          total_tao: 50,
          event_count: 2,
          last_observed: 1717900000000,
        },
      ];
    };
    const { data, generatedAt } = await loadSubnetStakeFlow(d1, 7, {
      windowLabel: "30d",
    });
    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.match(sql, /FROM account_events/);
    assert.match(sql, /GROUP BY event_kind/);
    assert.match(sql, /MAX\(observed_at\)/);
    assert.equal(params[0], 7);
    assert.equal(params[1], STAKE_ADDED_KIND);
    assert.equal(params[2], STAKE_REMOVED_KIND);
    assert.equal(params[3], Date.now() - 30 * DAY_MS);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.net_flow_tao, 150);
    // generated_at = the newest event's observed_at, rendered as an ISO string.
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
    vi.useRealTimers();
  });

  test("defaults to the 30d window when none is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let captured;
    const d1 = async (_sql, params) => {
      captured = params;
      return [];
    };
    const { data } = await loadSubnetStakeFlow(d1, 1, {});
    assert.equal(data.window, DEFAULT_STAKE_FLOW_WINDOW);
    assert.equal(captured[3], Date.now() - STAKE_FLOW_WINDOWS["30d"] * DAY_MS);
    vi.useRealTimers();
  });

  test("cold D1 (no rows) yields zeroed totals and a null generated_at", async () => {
    const d1 = async () => [];
    const { data, generatedAt } = await loadSubnetStakeFlow(d1, 99, {
      windowLabel: "7d",
    });
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.total_unstaked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
    assert.equal(data.window, "7d");
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to zeroed totals and null generated_at", async () => {
    const d1 = async () => null;
    const { data, generatedAt } = await loadSubnetStakeFlow(d1, 7, {});
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
    assert.equal(generatedAt, null);
  });

  test("a row without a finite observed_at leaves generated_at null", async () => {
    const d1 = async () => [
      { event_kind: STAKE_ADDED_KIND, total_tao: 5, event_count: 1 },
    ];
    const { data, generatedAt } = await loadSubnetStakeFlow(d1, 7, {});
    assert.equal(data.total_staked_tao, 5);
    assert.equal(generatedAt, null);
  });

  test("an unknown window label falls back to the default cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let captured;
    const d1 = async (_sql, params) => {
      captured = params;
      return [];
    };
    await loadSubnetStakeFlow(d1, 7, { windowLabel: "bogus" });
    assert.equal(captured[3], Date.now() - STAKE_FLOW_WINDOWS["30d"] * DAY_MS);
    vi.useRealTimers();
  });

  test("direction=in queries StakeAdded only", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 100,
          event_count: 3,
          last_observed: 1717000000000,
        },
      ];
    };
    const { data } = await loadSubnetStakeFlow(d1, 7, {
      windowLabel: "7d",
      direction: "in",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[1], STAKE_ADDED_KIND);
    assert.equal(calls[0].params.length, 3);
    assert.equal(data.total_staked_tao, 100);
    assert.equal(data.total_unstaked_tao, 0);
    assert.equal(data.net_flow_tao, 100);
  });

  test("direction=out queries StakeRemoved only", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          event_kind: STAKE_REMOVED_KIND,
          total_tao: 40,
          event_count: 2,
          last_observed: 1717000000000,
        },
      ];
    };
    const { data } = await loadSubnetStakeFlow(d1, 7, {
      windowLabel: "7d",
      direction: "out",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[1], STAKE_REMOVED_KIND);
    assert.equal(calls[0].params.length, 3);
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.total_unstaked_tao, 40);
    assert.equal(data.net_flow_tao, -40);
  });

  test("direction=all (default) queries both stake kinds", async () => {
    const calls = [];
    const d1 = async (_sql, params) => {
      calls.push(params);
      return [];
    };
    await loadSubnetStakeFlow(d1, 7, { direction: "all" });
    assert.deepEqual(calls[0].slice(1, 3), [
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
    ]);
  });
});
