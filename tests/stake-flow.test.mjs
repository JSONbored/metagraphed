import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildStakeFlow,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/stake-flow.mjs";

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

  test("skips blank total_tao rows instead of counting phantom stake events", () => {
    for (const blank of ["", "   "]) {
      const data = buildStakeFlow(
        [
          {
            event_kind: STAKE_ADDED_KIND,
            total_tao: blank,
            event_count: 4,
          },
          {
            event_kind: STAKE_REMOVED_KIND,
            total_tao: blank,
            event_count: 2,
          },
          { event_kind: STAKE_ADDED_KIND, total_tao: 10, event_count: 1 },
          { event_kind: STAKE_REMOVED_KIND, total_tao: 5, event_count: 1 },
        ],
        1,
        {},
      );
      assert.equal(
        data.stake_events,
        1,
        `stake_events for total_tao ${JSON.stringify(blank)}`,
      );
      assert.equal(data.unstake_events, 1);
      assert.equal(data.total_staked_tao, 10);
      assert.equal(data.total_unstaked_tao, 5);
    }
  });

  test("skips null/blank/non-numeric total_tao rows instead of coercing to zero flow", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: null, event_count: 2 },
      { event_kind: STAKE_REMOVED_KIND, total_tao: "nope", event_count: 3 },
    ];
    const data = buildStakeFlow(rows, 1, {});
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.total_unstaked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
    assert.equal(data.stake_events, 0);
    assert.equal(data.unstake_events, 0);
  });
});
