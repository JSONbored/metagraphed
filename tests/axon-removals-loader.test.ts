import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  AXON_REMOVALS_LOOKBACK_DAYS,
  isoDaysAgo,
  loadAxonRemovals,
} from "../src/axon-removals-loader.ts";

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
    assert.match(sql, /lag\(axon\) OVER \(PARTITION BY netuid, uid/);
    assert.match(sql, /JOIN dropped/);
    assert.match(sql, /snapshot_date >= \?/);
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
