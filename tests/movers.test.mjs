import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  computeMovers,
  buildMovers,
  loadSubnetMovers,
  DEFAULT_MOVERS_WINDOW,
  DEFAULT_MOVERS_SORT,
} from "../src/movers.mjs";

// Aggregate row helper: one neuron_daily GROUP BY netuid,snapshot_date row.
function agg(netuid, snapshot_date, { neurons, validators, stake, emission }) {
  return {
    netuid,
    snapshot_date,
    neuron_count: neurons,
    validator_count: validators,
    total_stake_tao: stake,
    total_emission_tao: emission,
  };
}

describe("buildMovers", () => {
  test("cold / missing-boundary inputs yield an empty, schema-stable leaderboard", () => {
    for (const opts of [
      { window: "30d", startDate: null, endDate: null },
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-01" }, // single snapshot
    ]) {
      const data = buildMovers([], [], opts);
      assert.equal(data.schema_version, 1);
      assert.equal(data.window, "30d");
      assert.equal(data.sort, DEFAULT_MOVERS_SORT);
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.movers, []);
    }
  });

  test("window/sort default to null/stake when omitted", () => {
    const data = buildMovers([], []);
    assert.equal(data.window, null);
    assert.equal(data.sort, "stake");
  });

  test("normalizes an unknown window/sort to schema-valid defaults", () => {
    const data = buildMovers([], [], { window: "bogus", sort: "bogus" });
    assert.equal(data.window, DEFAULT_MOVERS_WINDOW);
    assert.equal(data.sort, DEFAULT_MOVERS_SORT);
  });

  test("clamps a non-integer / negative / over-max limit", () => {
    const startRows = [
      agg(1, "s", { stake: 1 }),
      agg(2, "s", { stake: 2 }),
      agg(3, "s", { stake: 3 }),
    ];
    const endRows = [
      agg(1, "e", { stake: 30 }),
      agg(2, "e", { stake: 20 }),
      agg(3, "e", { stake: 10 }),
    ];
    const opts = { window: "30d", startDate: "x", endDate: "y" };
    const len = (limit) =>
      buildMovers(startRows, endRows, { ...opts, limit }).movers.length;
    assert.equal(len(1.9), 1); // floored to 1
    assert.equal(len(-5), 0); // negative clamps to 0
    assert.equal(len(999), 3); // over-max clamps to MOVERS_LIMIT_MAX, capped by data
    assert.equal(len(Number.NaN), 3); // non-finite -> default (>= data length here)
  });
});

describe("computeMovers", () => {
  const startRows = [
    agg(1, "s", { neurons: 10, validators: 3, stake: 100, emission: 5 }),
    agg(2, "s", { neurons: 8, validators: 2, stake: 50, emission: 4 }),
  ];
  const endRows = [
    agg(1, "e", { neurons: 12, validators: 4, stake: 250, emission: 9 }), // big gainer
    agg(2, "e", { neurons: 8, validators: 2, stake: 30, emission: 4 }), // loser
  ];

  test("computes per-subnet deltas, pct changes, and counts", () => {
    const m = computeMovers(startRows, endRows, { sort: "stake" });
    const s1 = m.find((x) => x.netuid === 1);
    assert.equal(s1.stake_start_tao, 100);
    assert.equal(s1.stake_end_tao, 250);
    assert.equal(s1.stake_delta_tao, 150);
    assert.equal(s1.stake_pct_change, 150); // +150%
    assert.equal(s1.emission_delta_tao, 4);
    assert.equal(s1.validators_delta, 1);
    assert.equal(s1.neurons_delta, 2);
    const s2 = m.find((x) => x.netuid === 2);
    assert.equal(s2.stake_delta_tao, -20);
    assert.equal(s2.stake_pct_change, -40);
  });

  test("ranks by the chosen metric's signed delta, gainers first", () => {
    assert.deepEqual(
      computeMovers(startRows, endRows, { sort: "stake" }).map((x) => x.netuid),
      [1, 2],
    );
    // emission: subnet 1 +4, subnet 2 +0 -> 1 first
    assert.deepEqual(
      computeMovers(startRows, endRows, { sort: "emission" }).map(
        (x) => x.netuid,
      ),
      [1, 2],
    );
  });

  test("a brand-new subnet (only at end) starts from zero with a null pct", () => {
    const m = computeMovers(
      [],
      [agg(7, "e", { neurons: 5, validators: 1, stake: 80, emission: 2 })],
      { sort: "stake" },
    );
    assert.equal(m[0].stake_start_tao, 0);
    assert.equal(m[0].stake_delta_tao, 80);
    assert.equal(m[0].stake_pct_change, null); // growth from zero is undefined
  });

  test("a removed subnet (only at start) ends at zero with a negative delta", () => {
    const m = computeMovers(
      [agg(9, "s", { neurons: 4, validators: 1, stake: 60, emission: 3 })],
      [],
      { sort: "stake" },
    );
    assert.equal(m[0].stake_end_tao, 0);
    assert.equal(m[0].stake_delta_tao, -60);
    assert.equal(m[0].stake_pct_change, -100);
  });

  test("rounds TAO deltas to rao precision (no IEEE-754 dust)", () => {
    const m = computeMovers(
      [agg(1, "s", { neurons: 1, validators: 0, stake: 0.1, emission: 0 })],
      [agg(1, "e", { neurons: 1, validators: 0, stake: 0.3, emission: 0 })],
      { sort: "stake" },
    );
    assert.equal(m[0].stake_delta_tao, 0.2); // 0.3 - 0.1, not 0.199999...
  });

  test("buildMovers caps movers to limit but counts all subnets", () => {
    const data = buildMovers(startRows, endRows, {
      window: "30d",
      startDate: "s",
      endDate: "e",
      sort: "stake",
      limit: 1,
    });
    assert.equal(data.subnet_count, 2);
    assert.equal(data.movers.length, 1);
    assert.equal(data.movers[0].netuid, 1);
  });

  test("ties on the sort metric break by netuid ascending", () => {
    const m = computeMovers(
      [
        agg(5, "s", { neurons: 1, validators: 0, stake: 100, emission: 0 }),
        agg(3, "s", { neurons: 1, validators: 0, stake: 100, emission: 0 }),
      ],
      [
        agg(5, "e", { neurons: 1, validators: 0, stake: 110, emission: 0 }),
        agg(3, "e", { neurons: 1, validators: 0, stake: 110, emission: 0 }),
      ],
      { sort: "stake" },
    );
    assert.deepEqual(
      m.map((x) => x.netuid),
      [3, 5],
    );
  });

  test("an unknown sort falls back to ranking by stake", () => {
    const m = computeMovers(startRows, endRows, { sort: "bogus" });
    assert.equal(m[0].netuid, 1);
  });

  test("skips rows with a malformed netuid and coerces non-finite cells to zero", () => {
    const m = computeMovers(
      [
        agg(1, "s", { neurons: 1, validators: 0, stake: "oops", emission: 0 }),
        {
          netuid: "bad",
          snapshot_date: "s",
          neuron_count: 1,
          validator_count: 0,
          total_stake_tao: 9,
          total_emission_tao: 0,
        },
      ],
      [agg(1, "e", { neurons: 1, validators: 0, stake: 50, emission: 0 })],
      { sort: "stake" },
    );
    assert.equal(m.length, 1); // the "bad" netuid row is dropped
    assert.equal(m[0].netuid, 1);
    assert.equal(m[0].stake_start_tao, 0); // "oops" coerced to 0
    assert.equal(m[0].stake_delta_tao, 50);
  });

  test("skips rows with a null or blank netuid instead of coercing to subnet 0", () => {
    const m = computeMovers(
      [
        agg(0, "s", { neurons: 1, validators: 0, stake: 10, emission: 0 }),
        {
          netuid: null,
          snapshot_date: "s",
          neuron_count: 5,
          validator_count: 0,
          total_stake_tao: 99,
          total_emission_tao: 0,
        },
        {
          netuid: "  ",
          snapshot_date: "s",
          neuron_count: 3,
          validator_count: 0,
          total_stake_tao: 88,
          total_emission_tao: 0,
        },
      ],
      [agg(0, "e", { neurons: 1, validators: 0, stake: 20, emission: 0 })],
      { sort: "stake" },
    );
    assert.equal(m.length, 1);
    assert.equal(m[0].netuid, 0);
    assert.equal(m[0].stake_start_tao, 10);
  });

  test("non-array inputs yield an empty ranking", () => {
    assert.deepEqual(computeMovers(null, undefined, { sort: "stake" }), []);
  });
});

describe("movers dominance shares", () => {
  const startRows = [
    agg(1, "s", { neurons: 10, validators: 3, stake: 100, emission: 5 }),
    agg(2, "s", { neurons: 8, validators: 2, stake: 50, emission: 4 }),
  ];
  const endRows = [
    agg(1, "e", { neurons: 12, validators: 4, stake: 250, emission: 9 }),
    agg(2, "e", { neurons: 8, validators: 2, stake: 30, emission: 4 }),
  ];

  test("each subnet carries its share of network stake/emission at the end", () => {
    const m = computeMovers(startRows, endRows, { sort: "stake" });
    const s1 = m.find((x) => x.netuid === 1);
    const s2 = m.find((x) => x.netuid === 2);
    // end stake total 280 -> 250/280 = 89.29%, 30/280 = 10.71%.
    assert.equal(s1.stake_share_pct, 89.29);
    assert.equal(s2.stake_share_pct, 10.71);
    // shares are over the whole network, so they sum to ~100.
    assert.equal(
      Math.round((s1.stake_share_pct + s2.stake_share_pct) * 100) / 100,
      100,
    );
    // end emission total 13 -> 9/13 = 69.23%, 4/13 = 30.77%.
    assert.equal(s1.emission_share_pct, 69.23);
    assert.equal(s2.emission_share_pct, 30.77);
  });

  test("share is null when the network end total is zero (share of nothing)", () => {
    // Every subnet removed by the end -> end totals are 0.
    const m = computeMovers(
      [agg(9, "s", { neurons: 4, validators: 1, stake: 60, emission: 3 })],
      [],
      { sort: "stake" },
    );
    assert.equal(m[0].stake_share_pct, null);
    assert.equal(m[0].emission_share_pct, null);
  });

  test("a near-total share does not round up to a flat 100 while another subnet holds stake", () => {
    // Subnet 1 holds 249990/250000 = 99.996% of network stake; subnet 2 still
    // holds the remaining 10 TAO. The 2dp rounding of 99.996 lands on 100.00,
    // which would report subnet 1 as owning the ENTIRE network — clamp it below.
    const near = { neurons: 1, validators: 0, stake: 249990, emission: 249990 };
    const rest = { neurons: 1, validators: 0, stake: 10, emission: 10 };
    const m = computeMovers(
      [agg(1, "s", near), agg(2, "s", rest)],
      [agg(1, "e", near), agg(2, "e", rest)],
      { sort: "stake" },
    );
    const s1 = m.find((x) => x.netuid === 1);
    const s2 = m.find((x) => x.netuid === 2);
    // 249990/250000 = 99.996% -> 2dp rounds to 100.00 without the clamp.
    assert.ok(s1.stake_share_pct < 100, "near-total share must stay below 100");
    assert.equal(s1.stake_share_pct, 99.99);
    assert.equal(s1.emission_share_pct, 99.99);
    // subnet 2's 0.004% rounds to 0.00 at 2dp, but it is a distinct subnet that
    // holds real stake — which is exactly why subnet 1 must not read as 100%.
    assert.equal(s2.stake_share_pct, 0);
  });

  test("a genuine single-subnet network keeps an exact 100 share", () => {
    const m = computeMovers(
      [agg(1, "s", { neurons: 1, validators: 0, stake: 100, emission: 5 })],
      [agg(1, "e", { neurons: 1, validators: 0, stake: 100, emission: 5 })],
      { sort: "stake" },
    );
    assert.equal(m[0].stake_share_pct, 100);
    assert.equal(m[0].emission_share_pct, 100);
  });
});

describe("movers network summary", () => {
  const startRows = [
    agg(1, "s", { neurons: 10, validators: 3, stake: 100, emission: 5 }),
    agg(2, "s", { neurons: 8, validators: 2, stake: 50, emission: 4 }),
  ];
  const endRows = [
    agg(1, "e", { neurons: 12, validators: 4, stake: 250, emission: 9 }),
    agg(2, "e", { neurons: 8, validators: 2, stake: 30, emission: 4 }),
  ];
  const opts = { window: "30d", startDate: "s", endDate: "e" };

  test("totals stake/emission/validators across all subnets with their deltas", () => {
    const { network } = buildMovers(startRows, endRows, opts);
    assert.equal(network.total_stake_start_tao, 150);
    assert.equal(network.total_stake_end_tao, 280);
    assert.equal(network.total_stake_delta_tao, 130);
    assert.equal(network.total_emission_start_tao, 9);
    assert.equal(network.total_emission_end_tao, 13);
    assert.equal(network.total_emission_delta_tao, 4);
    assert.equal(network.total_validators_start, 5);
    assert.equal(network.total_validators_end, 6);
    assert.equal(network.total_validators_delta, 1);
  });

  test("gainer/loser/unchanged counts follow the active sort metric", () => {
    // By stake: subnet 1 +150 (gainer), subnet 2 -20 (loser).
    const byStake = buildMovers(startRows, endRows, { ...opts, sort: "stake" });
    assert.deepEqual(
      [
        byStake.network.gainers,
        byStake.network.losers,
        byStake.network.unchanged,
      ],
      [1, 1, 0],
    );
    // By neurons: subnet 1 +2 (gainer), subnet 2 +0 (unchanged).
    const byNeurons = buildMovers(startRows, endRows, {
      ...opts,
      sort: "neurons",
    });
    assert.deepEqual(
      [
        byNeurons.network.gainers,
        byNeurons.network.losers,
        byNeurons.network.unchanged,
      ],
      [1, 0, 1],
    );
  });

  test("counts every subnet, not just the returned page", () => {
    // limit 1 returns one mover, but the summary still counts both subnets.
    const { network } = buildMovers(startRows, endRows, { ...opts, limit: 1 });
    assert.equal(network.gainers + network.losers + network.unchanged, 2);
  });

  test("empty / non-comparable inputs yield an all-zero network summary", () => {
    const { network } = buildMovers([], [], {
      window: "30d",
      startDate: null,
      endDate: null,
    });
    assert.equal(network.total_stake_end_tao, 0);
    assert.equal(network.total_validators_delta, 0);
    assert.equal(network.gainers, 0);
    assert.equal(network.losers, 0);
    assert.equal(network.unchanged, 0);
  });
});

describe("movers neurons sort", () => {
  test("ranks by neuron-count delta, gainers first", () => {
    const m = computeMovers(
      [
        agg(1, "s", { neurons: 10, validators: 0, stake: 0, emission: 0 }),
        agg(2, "s", { neurons: 8, validators: 0, stake: 0, emission: 0 }),
      ],
      [
        agg(1, "e", { neurons: 11, validators: 0, stake: 0, emission: 0 }), // +1
        agg(2, "e", { neurons: 20, validators: 0, stake: 0, emission: 0 }), // +12
      ],
      { sort: "neurons" },
    );
    assert.deepEqual(
      m.map((x) => x.netuid),
      [2, 1],
    );
  });
});

describe("loadSubnetMovers", () => {
  test("resolves global boundary dates then reads the cross-subnet aggregate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/MIN\(snapshot_date\)/.test(sql)) {
        return [{ start_date: "2026-05-31", end_date: "2026-06-30" }];
      }
      return [
        agg(1, "2026-05-31", {
          neurons: 10,
          validators: 3,
          stake: 100,
          emission: 5,
        }),
        agg(1, "2026-06-30", {
          neurons: 12,
          validators: 4,
          stake: 250,
          emission: 9,
        }),
      ];
    };
    const data = await loadSubnetMovers(d1, {
      windowLabel: "30d",
      sort: "stake",
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /MIN\(snapshot_date\)/);
    assert.match(calls[0].sql, /date\(MAX\(snapshot_date\), \?\)/); // anchored to stored MAX, not now
    assert.equal(calls[0].params[0], "-30 days");
    assert.match(calls[1].sql, /GROUP BY netuid, snapshot_date/);
    assert.deepEqual(calls[1].params, ["2026-05-31", "2026-06-30"]);
    assert.equal(data.window, "30d");
    assert.equal(data.start_date, "2026-05-31");
    assert.equal(data.end_date, "2026-06-30");
    assert.equal(data.subnet_count, 1);
    assert.equal(data.movers[0].stake_delta_tao, 150);
    vi.useRealTimers();
  });

  test("sort=neurons ranks by neuron-count delta through the public loader path", async () => {
    const d1 = async (sql) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        return [{ start_date: "2026-05-31", end_date: "2026-06-30" }];
      }
      return [
        agg(1, "2026-05-31", {
          neurons: 10,
          validators: 2,
          stake: 50,
          emission: 3,
        }),
        agg(2, "2026-05-31", {
          neurons: 8,
          validators: 2,
          stake: 50,
          emission: 3,
        }),
        agg(1, "2026-06-30", {
          neurons: 11, // +1
          validators: 2,
          stake: 50,
          emission: 3,
        }),
        agg(2, "2026-06-30", {
          neurons: 20, // +12
          validators: 2,
          stake: 50,
          emission: 3,
        }),
      ];
    };
    const data = await loadSubnetMovers(d1, {
      windowLabel: "30d",
      sort: "neurons",
    });
    assert.equal(data.sort, "neurons"); // the public query value is accepted + echoed
    assert.deepEqual(
      data.movers.map((m) => m.netuid),
      [2, 1], // biggest neuron gainer first
    );
    // both subnets gained neurons over the window -> 2 gainers, none lost or flat
    assert.deepEqual(
      [data.network.gainers, data.network.losers, data.network.unchanged],
      [2, 0, 0],
    );
  });

  test("defaults to the 30d window + stake sort", async () => {
    let boundsCutoff;
    const d1 = async (sql, params) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        boundsCutoff = params[0];
        return [{ start_date: null, end_date: null }];
      }
      return [];
    };
    const data = await loadSubnetMovers(d1, {});
    assert.equal(data.window, DEFAULT_MOVERS_WINDOW);
    assert.equal(data.sort, DEFAULT_MOVERS_SORT);
    assert.equal(typeof boundsCutoff, "string");
    assert.deepEqual(data.movers, []);
  });

  test("a single available snapshot (start === end) skips the read and returns empty", async () => {
    const calls = [];
    const d1 = async (sql) => {
      calls.push(sql);
      if (/MIN\(snapshot_date\)/.test(sql)) {
        return [{ start_date: "2026-06-30", end_date: "2026-06-30" }];
      }
      return [];
    };
    const data = await loadSubnetMovers(d1, { windowLabel: "7d" });
    assert.equal(calls.length, 1); // no second (aggregate) query
    assert.deepEqual(data.movers, []);
    assert.equal(data.start_date, "2026-06-30");
  });

  test("anchors the window to the newest stored snapshot, not the worker clock", async () => {
    // Worker clock is mid-2026 but the store's newest snapshot is months older; a now-relative
    // window would return empty. The loader must still compare the stored boundary snapshots.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
    let boundsParam;
    const d1 = async (sql, params) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        boundsParam = params[0];
        return [{ start_date: "2026-01-01", end_date: "2026-01-31" }];
      }
      return [
        agg(1, "2026-01-01", {
          neurons: 10,
          validators: 3,
          stake: 100,
          emission: 5,
        }),
        agg(1, "2026-01-31", {
          neurons: 12,
          validators: 4,
          stake: 250,
          emission: 9,
        }),
      ];
    };
    const data = await loadSubnetMovers(d1, { windowLabel: "7d" });
    assert.equal(boundsParam, "-7 days"); // cutoff computed in SQL relative to MAX(snapshot_date)
    assert.equal(data.start_date, "2026-01-01");
    assert.equal(data.end_date, "2026-01-31");
    assert.equal(data.subnet_count, 1);
    assert.equal(data.movers[0].stake_delta_tao, 150);
    vi.useRealTimers();
  });

  test("an unknown window label falls back to the 30d window", async () => {
    let boundsParam;
    const d1 = async (sql, params) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        boundsParam = params[0];
        return [{ start_date: null, end_date: null }];
      }
      return [];
    };
    await loadSubnetMovers(d1, { windowLabel: "bogus" });
    assert.equal(boundsParam, "-30 days");
  });

  test("a non-array aggregate result degrades to an empty leaderboard", async () => {
    const d1 = async (sql) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        return [{ start_date: "2026-05-31", end_date: "2026-06-30" }];
      }
      return null; // malformed aggregate read
    };
    const data = await loadSubnetMovers(d1, { windowLabel: "30d" });
    assert.deepEqual(data.movers, []);
    assert.equal(data.subnet_count, 0);
  });
});
