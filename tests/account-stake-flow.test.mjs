import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountStakeFlow,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/account-stake-flow.ts";

// One GROUP BY netuid, event_kind row.
function row(netuid, kind, tao, count) {
  return {
    netuid,
    event_kind: kind,
    total_tao: tao,
    event_count: count,
  };
}
const added = (netuid, tao, count = 1) =>
  row(netuid, STAKE_ADDED_KIND, tao, count);
const removed = (netuid, tao, count = 1) =>
  row(netuid, STAKE_REMOVED_KIND, tao, count);

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

  test("a near-pure flow_ratio does not round up to an exact +/-1 while counter-flow exists", () => {
    // Accumulation with a sliver of counter-flow: net 99999 / gross 100001 =
    // 0.99998, which a bare 4dp round lifts to exactly 1 (reads as pure
    // one-directional flow with zero outflow). Clamp holds it below 1.
    const acc = buildAccountStakeFlow([added(1, 100000), removed(1, 1)], ADDR);
    assert.equal(acc.flow_ratio, 0.9999);
    // The mirror case on the exit side must not round to a flat -1 either.
    const exit = buildAccountStakeFlow([added(1, 1), removed(1, 100000)], ADDR);
    assert.equal(exit.flow_ratio, -0.9999);
    // A genuinely one-directional wallet still reports a true, unclamped +/-1.
    assert.equal(buildAccountStakeFlow([added(9, 5)], ADDR).flow_ratio, 1);
    assert.equal(buildAccountStakeFlow([removed(9, 5)], ADDR).flow_ratio, -1);
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

  test("a near-monopoly across >1 subnet never rounds up to a perfect 1", () => {
    // HHI = (100000^2 + 1^2) / 100001^2 = 0.99998... which a bare 4dp round would
    // lift to exactly 1 — falsely reading as single-subnet concentration. The
    // anti-overstatement clamp holds it at the largest sub-1 value (#2327).
    const d = buildAccountStakeFlow([added(0, 100000), added(1, 1)], ADDR);
    assert.equal(d.subnet_count, 2);
    assert.equal(d.concentration, 0.9999);
    // A genuine single-subnet wallet still reports a true, unclamped 1.
    assert.equal(buildAccountStakeFlow([added(9, 5)], ADDR).concentration, 1);
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
        row(1, "Transfer", 100, 1),
        added(1, 25),
      ],
      ADDR,
    );
    assert.equal(d.subnet_count, 1);
    assert.equal(d.total_staked_tao, 25);
  });

  test("skips blank netuid cells instead of coercing to subnet 0", () => {
    // Mirrors the blank-cell guard in turnover.mjs (#3026): Number("") is 0.
    for (const blank of ["", "   "]) {
      const d = buildAccountStakeFlow([added(blank, 100), added(1, 25)], ADDR);
      assert.equal(
        d.subnet_count,
        1,
        `subnet_count for netuid ${JSON.stringify(blank)}`,
      );
      assert.equal(d.total_staked_tao, 25);
      assert.equal(d.subnets[0].netuid, 1);
    }
  });

  test("rounds tao output to rao precision", () => {
    const d = buildAccountStakeFlow([added(1, 0.1), removed(1, 0.2)], ADDR);
    assert.equal(d.net_flow_tao, -0.1);
  });

  test("skips blank total_tao rows instead of counting phantom stake events", () => {
    // Mirrors buildCounterparties #3059: blank total_tao must not inflate event_count.
    for (const blank of ["", "   "]) {
      const d = buildAccountStakeFlow(
        [
          {
            netuid: 1,
            event_kind: STAKE_ADDED_KIND,
            total_tao: blank,
            event_count: 5,
          },
          {
            netuid: 1,
            event_kind: STAKE_REMOVED_KIND,
            total_tao: blank,
            event_count: 3,
          },
          added(1, 25, 2),
          removed(1, 10, 1),
        ],
        ADDR,
      );
      assert.equal(
        d.stake_events,
        2,
        `stake_events for total_tao ${JSON.stringify(blank)}`,
      );
      assert.equal(d.unstake_events, 1);
      assert.equal(d.total_staked_tao, 25);
      assert.equal(d.total_unstaked_tao, 10);
      assert.equal(d.subnet_count, 1);
    }
    const zero = buildAccountStakeFlow([added(1, 0, 3)], ADDR);
    assert.equal(zero.total_staked_tao, 0);
    assert.equal(zero.stake_events, 3);
  });

  test("skips null/blank/non-numeric total_tao rows instead of coercing to zero flow", () => {
    const d = buildAccountStakeFlow(
      [
        {
          netuid: 1,
          event_kind: STAKE_ADDED_KIND,
          total_tao: null,
          event_count: 2,
        },
        {
          netuid: 1,
          event_kind: STAKE_REMOVED_KIND,
          total_tao: "nope",
          event_count: 3,
        },
      ],
      ADDR,
    );
    assert.equal(d.total_staked_tao, 0);
    assert.equal(d.total_unstaked_tao, 0);
    assert.equal(d.stake_events, 0);
    assert.equal(d.unstake_events, 0);
    assert.equal(d.subnet_count, 0);
  });
});
