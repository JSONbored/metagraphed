import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
  buildChainAxonRemovals,
} from "../src/chain-axon-removals.ts";
import {
  axonChangesCoverage,
  foldAxonChangeRows,
} from "../src/axon-reachability-changes.ts";

const coverage = axonChangesCoverage(
  "2026-07-10",
  "2026-08-16",
  30,
  "2026-08-16",
);

/** The network's measured 38-day shape, as grouped rows. */
const NETWORK_ROWS = [
  { netuid: 126, kind: "moved-unroutable", n: 160 },
  { netuid: 101, kind: "stopped-announcing", n: 76, removers: 38 },
  { netuid: 101, kind: "deregistered", n: 64 },
  { netuid: 25, kind: "deregistered", n: 67 },
];

describe("removals means STOPPED ANNOUNCING, network-wide", () => {
  test("the leaderboard ranks by removals, NOT by volume", () => {
    // SN126 has 160 changes and SN101 has 140, but SN126's are all moves --
    // its miners never went dark. Ranking by total would put the biggest
    // non-event on the network above the one real withdrawal.
    const result = buildChainAxonRemovals(foldAxonChangeRows(NETWORK_ROWS), {
      window: "30d",
      coverage,
      networkDistinctRemovers: 38,
    });
    assert.deepEqual(
      result.subnets.map((s) => s.netuid),
      [101, 126, 25],
    );
    assert.equal(result.subnets[0].removals, 76);
    assert.equal(result.subnets[1].removals, 0);
    assert.equal(result.subnets[2].removals, 0);
  });

  test("the network rollup keeps the three kinds separate", () => {
    const result = buildChainAxonRemovals(foldAxonChangeRows(NETWORK_ROWS), {
      coverage,
      networkDistinctRemovers: 38,
    });
    assert.deepEqual(result.changes, {
      deregistered: 131,
      moved_unroutable: 160,
      stopped_announcing: 76,
      total: 367,
    });
    // The headline number is the removals alone.
    assert.equal(result.network.removals, 76);
    assert.equal(result.network.distinct_removers, 38);
    assert.equal(result.network.removals_per_remover, 2);
  });

  test("distinct removers is the caller's COUNT DISTINCT, not a sum", () => {
    // One hotkey that stopped on three subnets is ONE remover; summing the
    // per-subnet counts would treble it. An absent value is 0, not a guess.
    const result = buildChainAxonRemovals(foldAxonChangeRows(NETWORK_ROWS), {
      coverage,
    });
    assert.equal(result.network.distinct_removers, 0);
    assert.equal(result.network.removals_per_remover, null);
  });
});

describe("the intensity distribution describes teardown, not churn", () => {
  test("subnets with no removals are EXCLUDED, not folded in as zeroes", () => {
    // A move-only subnet has no teardown intensity. Counting it as 0 would
    // drag the distribution toward a rate nobody exhibited.
    const result = buildChainAxonRemovals(
      foldAxonChangeRows([
        { netuid: 1, kind: "stopped-announcing", n: 4, removers: 2 },
        { netuid: 2, kind: "moved-unroutable", n: 99 },
      ]),
      { coverage, networkDistinctRemovers: 2 },
    );
    assert.equal(result.intensity_distribution?.count, 1);
    assert.equal(result.intensity_distribution?.min, 2);
    assert.equal(result.subnets[1].removals_per_remover, null);
  });

  test("no removals anywhere leaves the distribution null", () => {
    const result = buildChainAxonRemovals(
      foldAxonChangeRows([{ netuid: 2, kind: "moved-unroutable", n: 9 }]),
      { coverage },
    );
    assert.equal(result.intensity_distribution, null);
  });
});

describe("paging and limits", () => {
  test("the page truncates but the rollup and count do not", () => {
    const result = buildChainAxonRemovals(foldAxonChangeRows(NETWORK_ROWS), {
      coverage,
      limit: 1,
    });
    assert.equal(result.subnets.length, 1);
    assert.equal(result.subnet_count, 3);
    assert.equal(result.changes.total, 367);
  });

  test("the limit is clamped to the route's bounds", () => {
    const huge = buildChainAxonRemovals(foldAxonChangeRows(NETWORK_ROWS), {
      coverage,
      limit: 10_000,
    });
    assert.ok(huge.subnets.length <= CHAIN_AXON_REMOVALS_LIMIT_MAX);
    const defaulted = buildChainAxonRemovals(foldAxonChangeRows(NETWORK_ROWS), {
      coverage,
    });
    assert.ok(defaulted.subnets.length <= CHAIN_AXON_REMOVALS_LIMIT_DEFAULT);
  });
});

describe("nothing read is distinguishable from a quiet network", () => {
  test("a declined tier has NULL dates and no degraded marker", () => {
    const result = buildChainAxonRemovals(null, { window: "7d" });
    assert.equal(result.start_date, null);
    assert.equal(result.end_date, null);
    assert.equal(result.observed_at, null);
    assert.equal(result.window_truncated, null);
    assert.equal(result.subnet_count, 0);
    assert.deepEqual(result.changes, {
      deregistered: 0,
      moved_unroutable: 0,
      stopped_announcing: 0,
      total: 0,
    });
    assert.equal("degraded" in result, false);
  });

  test("a real read that found nothing carries its dates", () => {
    const result = buildChainAxonRemovals([], { window: "7d", coverage });
    assert.equal(result.start_date, "2026-07-10");
    assert.equal(result.observed_at, "2026-08-16T00:00:00.000Z");
    assert.equal(result.changes.total, 0);
  });

  test("the derivation is stated on every answer", () => {
    assert.equal(
      buildChainAxonRemovals([], { coverage }).derivation.source,
      "neuron_daily",
    );
  });
});
