import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  accountAxonRemovalRows,
  AXON_REMOVALS_LOOKBACK_DAYS,
  isoDaysAgo,
  loadAxonRemovals,
  subnetAxonRemovalRow,
} from "../src/axon-removals-loader.ts";
import { AXON_LOSS_SQL } from "../src/axon-transition.ts";

function day(
  date: string,
  {
    netuid = 25,
    uid = 1,
    hotkey = "hkA",
    axon = null as string | null,
  }: Partial<{
    netuid: number;
    uid: number;
    hotkey: string;
    axon: string | null;
  }> = {},
) {
  return { netuid, uid, snapshot_date: date, hotkey, axon };
}

/** A confirmed removal: announced, then absent for two readings. */
function removalSeries(netuid: number, uid: number, hotkey: string) {
  return [
    day("2026-08-01", { netuid, uid, hotkey, axon: "1.2.3.4:8091" }),
    day("2026-08-02", { netuid, uid, hotkey, axon: null }),
    day("2026-08-03", { netuid, uid, hotkey, axon: null }),
  ];
}

describe("loadAxonRemovals", () => {
  test("rolls removals up per subnet, most active first", async () => {
    const rows = [
      ...removalSeries(7, 1, "hkA"),
      ...removalSeries(7, 2, "hkB"),
      ...removalSeries(9, 1, "hkC"),
    ];
    const out = await loadAxonRemovals({}, { query: async () => rows });
    assert.deepEqual(out!.subnets, [
      { netuid: 7, distinct_removers: 2, removals: 2 },
      { netuid: 9, distinct_removers: 1, removals: 1 },
    ]);
  });

  test("DISTINCT REMOVERS is not the removal count — one operator, many miners", async () => {
    // The signal the builder's `removals_per_remover` exists to carry: one
    // hotkey tearing down two slots is ONE actor, not two. Verified against
    // production, where netuid 51 really is 5 removals from 4 hotkeys.
    const rows = [
      ...removalSeries(7, 1, "hkA"),
      ...removalSeries(7, 2, "hkA"),
      ...removalSeries(7, 3, "hkB"),
    ];
    const out = await loadAxonRemovals({}, { query: async () => rows });
    assert.deepEqual(out!.subnets, [
      { netuid: 7, distinct_removers: 2, removals: 3 },
    ]);
    assert.equal(out!.network.distinct_removers, 2);
  });

  test("carries the derivation block, so a consumer sees what was excluded", async () => {
    const rows = [
      ...removalSeries(7, 1, "hkA"),
      // a UID that changed hands: attributed to deregistration, not here
      day("2026-08-01", {
        netuid: 7,
        uid: 5,
        hotkey: "hkX",
        axon: "5.5.5.5:1",
      }),
      day("2026-08-02", { netuid: 7, uid: 5, hotkey: "hkY", axon: null }),
      day("2026-08-03", { netuid: 7, uid: 5, hotkey: "hkY", axon: null }),
    ];
    const out = await loadAxonRemovals({}, { query: async () => rows });
    assert.equal(out!.derivation.method, "axon-state-diff");
    assert.equal(out!.derivation.lookback_days, AXON_REMOVALS_LOOKBACK_DAYS);
    assert.equal(out!.derivation.excluded_uid_reuse, 1);
    assert.equal(out!.subnets.length, 1);
    assert.equal(out!.subnets[0]!.removals, 1);
  });

  test("newest_observed is the latest removal, not the latest row", async () => {
    const rows = [
      ...removalSeries(7, 1, "hkA"),
      // this slot never removed anything, and is newer
      day("2026-08-09", {
        netuid: 7,
        uid: 4,
        hotkey: "hkZ",
        axon: "9.9.9.9:1",
      }),
      day("2026-08-10", {
        netuid: 7,
        uid: 4,
        hotkey: "hkZ",
        axon: "9.9.9.9:1",
      }),
    ];
    const out = await loadAxonRemovals({}, { query: async () => rows });
    assert.equal(out!.network.newest_observed, "2026-08-02");
  });

  test("NO STORE is null, never an empty rollup", async () => {
    // The distinction this whole family exists to restore: "nothing to read
    // from" must not become "no removals happened". The caller keeps its
    // schema-stable empty; it does not publish a measurement it never made.
    assert.equal(await loadAxonRemovals(undefined), null);
    assert.equal(await loadAxonRemovals({}), null);
  });

  test("a store that answers nothing IS a measurement — an empty one", async () => {
    const out = await loadAxonRemovals({}, { query: async () => [] });
    assert.deepEqual(out!.subnets, []);
    assert.equal(out!.network.distinct_removers, 0);
    assert.equal(out!.network.newest_observed, null);
  });

  test("pulls exactly the declared lookback, and passes it as the bound", async () => {
    let params: unknown[] = [];
    await loadAxonRemovals(
      {},
      {
        query: async (_sql, p) => {
          params = p;
          return [];
        },
        now: () => Date.parse("2026-08-16T00:00:00Z"),
      },
    );
    assert.deepEqual(params, ["2026-07-17"]);
  });

  test("the narrowing query asks for candidate slots, not the whole table", async () => {
    // The cost control, pinned. Pulling `neuron_daily` unfiltered is ~936k
    // rows; restricting to slots that dropped an axon is ~43k. If this
    // predicate is ever dropped the query still returns correct answers, which
    // is exactly why it needs a test rather than a comment.
    let sql = "";
    await loadAxonRemovals(
      {},
      {
        query: async (s) => {
          sql = s;
          return [];
        },
      },
    );
    assert.match(sql, /WINDOW w AS \(PARTITION BY netuid, uid/);
    assert.match(sql, /JOIN dropped/);
    assert.match(sql, /snapshot_date >= \?/);
    // The predicate itself is the SHARED one, not a copy that reads the same
    // today. Pinning the literal is how the narrowing stayed on presence while
    // the derivation moved to reachability (#11394).
    assert.ok(sql.includes(`WHERE ${AXON_LOSS_SQL}`));
  });
});

describe("isoDaysAgo", () => {
  test("counts back in whole days, in UTC", () => {
    assert.equal(
      isoDaysAgo(Date.parse("2026-08-16T00:00:00Z"), 30),
      "2026-07-17",
    );
    assert.equal(
      isoDaysAgo(Date.parse("2026-08-16T23:59:59Z"), 0),
      "2026-08-16",
    );
  });
});

describe("subnetAxonRemovalRow", () => {
  const rollup = async () =>
    (await loadAxonRemovals(
      {},
      {
        query: async () => [
          ...removalSeries(7, 1, "hkA"),
          ...removalSeries(7, 2, "hkA"),
          ...removalSeries(9, 1, "hkB"),
        ],
      },
    ))!;

  test("counts only this subnet, and its own newest removal", async () => {
    const row = subnetAxonRemovalRow(await rollup(), 7);
    // Two removals by ONE hotkey: the card's removals_per_remover is what
    // turns that into "one operator", and it needs the distinct count to.
    assert.deepEqual(row, {
      distinct_removers: 1,
      removals: 2,
      newest_observed: "2026-08-02",
    });
  });

  test("A SUBNET WITH NO REMOVALS IS A ZEROED ROW, not null", async () => {
    // It was measured: we read 30 days and this subnet removed nothing. Null
    // is reserved for "no store", and conflating them is what this whole
    // change is undoing.
    assert.deepEqual(subnetAxonRemovalRow(await rollup(), 999), {
      distinct_removers: 0,
      removals: 0,
      newest_observed: null,
    });
  });

  test("no rollup is null, so the caller keeps its degraded empty", () => {
    assert.equal(subnetAxonRemovalRow(null, 7), null);
  });
});

describe("accountAxonRemovalRows", () => {
  test("groups one hotkey's removals per subnet, with its own first/last", async () => {
    const out = (await loadAxonRemovals(
      {},
      {
        query: async () => [
          ...removalSeries(7, 1, "hkA"),
          ...removalSeries(9, 1, "hkA"),
          ...removalSeries(7, 2, "hkB"),
        ],
      },
    ))!;
    assert.deepEqual(accountAxonRemovalRows(out, "hkA"), [
      {
        netuid: 7,
        removals: 1,
        first_observed: "2026-08-02",
        last_observed: "2026-08-02",
      },
      {
        netuid: 9,
        removals: 1,
        first_observed: "2026-08-02",
        last_observed: "2026-08-02",
      },
    ]);
  });

  test("an account with no removals is an empty list, not null", async () => {
    const out = (await loadAxonRemovals(
      {},
      { query: async () => removalSeries(7, 1, "hkA") },
    ))!;
    assert.deepEqual(accountAxonRemovalRows(out, "hkOther"), []);
  });

  test("no rollup is null", () => {
    assert.equal(accountAxonRemovalRows(null, "hkA"), null);
  });
});

describe("loadAxonRemovals — aggregation paths", () => {
  test("TWO REMOVALS ON ONE SUBNET widen the account's first/last window", async () => {
    // The multi-removal path: one hotkey tearing down two slots on the same
    // subnet is one row with removals: 2, and a window spanning both. Until
    // this test every fixture had at most one removal per (account, subnet),
    // so the branch that merges into an existing bucket never ran.
    const out = (await loadAxonRemovals(
      {},
      {
        query: async () => [
          ...removalSeries(7, 1, "hkA"),
          // a later teardown by the same hotkey on the same subnet
          day("2026-08-05", {
            netuid: 7,
            uid: 2,
            hotkey: "hkA",
            axon: "1.2.3.4:1",
          }),
          day("2026-08-06", { netuid: 7, uid: 2, hotkey: "hkA", axon: null }),
          day("2026-08-07", { netuid: 7, uid: 2, hotkey: "hkA", axon: null }),
        ],
      },
    ))!;
    assert.deepEqual(accountAxonRemovalRows(out, "hkA"), [
      {
        netuid: 7,
        removals: 2,
        first_observed: "2026-08-02",
        last_observed: "2026-08-06",
      },
    ]);
  });

  test("an EARLIER removal widens first_observed backwards", async () => {
    // The other half of the window update. The previous test only ever moved
    // `last` forward, so the `< first` comparison never ran.
    const out = (await loadAxonRemovals(
      {},
      {
        query: async () => [
          // uid 2 removes on the 6th...
          day("2026-08-05", {
            netuid: 7,
            uid: 2,
            hotkey: "hkA",
            axon: "1.2.3.4:1",
          }),
          day("2026-08-06", { netuid: 7, uid: 2, hotkey: "hkA", axon: null }),
          day("2026-08-07", { netuid: 7, uid: 2, hotkey: "hkA", axon: null }),
          // ...and uid 1 removed EARLIER, on the 2nd. Newest-first ordering
          // means this arrives second.
          ...removalSeries(7, 1, "hkA"),
        ],
      },
    ))!;
    assert.deepEqual(accountAxonRemovalRows(out, "hkA"), [
      {
        netuid: 7,
        removals: 2,
        first_observed: "2026-08-02",
        last_observed: "2026-08-06",
      },
    ]);
  });

  test("subnets with EQUAL removal counts tie-break by netuid, not insertion order", async () => {
    // Otherwise the leaderboard's order depends on which subnet the SQL
    // happened to return first, and two identical datasets could rank
    // differently.
    const out = (await loadAxonRemovals(
      {},
      {
        query: async () => [
          ...removalSeries(9, 1, "hkA"),
          ...removalSeries(3, 1, "hkB"),
        ],
      },
    ))!;
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [3, 9],
    );
  });
});

describe("accountAxonRemovalRows — order independence", () => {
  /** A rollup built by hand, so the ordering `loadAxonRemovals` guarantees is
   *  not the thing under test. */
  const rollupOf = (
    removals: Array<{
      netuid: number;
      uid: number;
      hotkey: string;
      removed_on: string;
    }>,
  ) => ({
    subnets: [],
    network: { distinct_removers: 0, newest_observed: null },
    derivation: {
      method: "axon-state-diff",
      lookback_days: 30,
      excluded_uid_reuse: 0,
      pending_confirmation: 0,
      moved_unroutable: 0,
    },
    removals: removals.map((r) => ({
      ...r,
      previous_axon: "1.2.3.4:8091",
      // These fixtures are all field-cleared removals; the move case has its
      // own coverage in axon-removal-derivation.test.ts (#11398).
      kind: "stopped-announcing" as const,
      current_axon: null,
    })),
  });

  test("widens the window in BOTH directions, whatever order rows arrive in", () => {
    // `loadAxonRemovals` emits newest-first, so in production the window only
    // ever widens backwards. This function does not require that, and both
    // comparisons are here because a caller holding a rollup from anywhere
    // else must still get the true first and last.
    const ascending = accountAxonRemovalRows(
      rollupOf([
        { netuid: 7, uid: 1, hotkey: "hkA", removed_on: "2026-08-02" },
        { netuid: 7, uid: 2, hotkey: "hkA", removed_on: "2026-08-09" },
      ]),
      "hkA",
    );
    const descending = accountAxonRemovalRows(
      rollupOf([
        { netuid: 7, uid: 2, hotkey: "hkA", removed_on: "2026-08-09" },
        { netuid: 7, uid: 1, hotkey: "hkA", removed_on: "2026-08-02" },
      ]),
      "hkA",
    );
    const expected = [
      {
        netuid: 7,
        removals: 2,
        first_observed: "2026-08-02",
        last_observed: "2026-08-09",
      },
    ];
    assert.deepEqual(ascending, expected, "ascending input");
    assert.deepEqual(descending, expected, "descending input");
  });
});
