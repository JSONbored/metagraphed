// The date seam between Neon and the lakehouse for the daily rollups (#10797).
//
// The claims worth pinning are the ones that decide whether a served day is
// CORRECT, not that a query string was built:
//
//   * the seam is strict, so a day both stores hold is served once;
//   * a window that the hot tier already satisfied does NOT open a cold read;
//   * "we could not look" never becomes "there is nothing older";
//   * hot wins a disagreement, because the store the writer commits to is the
//     one to believe.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  coldDateRange,
  coldWindow,
  loadNeuronHistoryColdTier,
  loadSubnetHistoryColdTier,
  mergeHistoryDays,
  needsColdRead,
} from "../src/neuron-daily-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { shiftIsoDate } from "../src/iso-date-window.ts";

const ENV = { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env;

/** Stubs the engine and captures the statement the reader built. `null` rows
 * stand for a declining engine (the sibling cold tiers' idiom). */
function reader(rows: Record<string, unknown>[] | null) {
  const seen: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)).query);
    if (rows == null) {
      return { ok: false, status: 500, text: async () => "boom" } as never;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { seen, deps: {} };
}

describe("the seam decides which store owns a day (#10797)", () => {
  test("the cold leg stops STRICTLY below the seam", () => {
    const range = coldDateRange("2026-06-01", "2026-07-10");
    assert.deepEqual(range, { lo: "2026-06-01", hi: "2026-07-10" });
  });

  test("a window the hot tier already covers opens no cold read", () => {
    // Neon holds 07-10..08-11 and the caller asked for 7d. The hot series
    // stops at 08-04 because that is the window, not because the store ran
    // out -- reaching below it would answer a question nobody asked.
    assert.equal(
      coldWindow(
        { oldest_day: "2026-08-04", newest_day: "2026-08-11" },
        7,
        shiftIsoDate,
      ),
      null,
    );
  });

  test("a window the hot tier ran out of DOES open one, from its floor", () => {
    // Same store, but `1y`: the hot series ends at Neon's floor, so every day
    // below it is missing and the cold leg supplies exactly that range.
    assert.deepEqual(
      coldWindow(
        { oldest_day: "2026-07-10", newest_day: "2026-08-11" },
        365,
        shiftIsoDate,
      ),
      { start: "2025-08-11", seam: "2026-07-10" },
    );
  });

  test("`all` reaches below the floor with no lower bound", () => {
    assert.deepEqual(
      coldWindow(
        { oldest_day: "2026-07-10", newest_day: "2026-08-11" },
        null,
        shiftIsoDate,
      ),
      { start: null, seam: "2026-07-10" },
    );
  });

  test("an empty hot payload makes the cold side the only side", () => {
    assert.deepEqual(
      coldWindow({ oldest_day: null, newest_day: null }, 30, shiftIsoDate),
      { start: null, seam: null },
    );
  });

  test("needsColdRead agrees with the ranges above", () => {
    assert.equal(needsColdRead("2026-06-01", "2026-07-10"), true);
    assert.equal(needsColdRead("2026-08-04", "2026-07-10"), false);
    assert.equal(needsColdRead(null, "2026-07-10"), true);
    assert.equal(needsColdRead("2026-06-01", null), true);
  });
});

describe("a malformed day is refused, never inlined", () => {
  test("a date that parses but is not a day is rejected", () => {
    // 2026-02-31 satisfies the obvious regex and Date rolls it to March 3rd.
    // Inlining it would silently match no rows, and "no rows" is
    // indistinguishable from "no history" at this seam.
    assert.equal(coldDateRange("2026-02-31", "2026-07-10"), null);
    assert.equal(coldDateRange("2026-13-01", "2026-07-10"), null);
  });

  test("an injection attempt is refused rather than escaped", () => {
    assert.equal(coldDateRange("2026-01-01' OR '1'='1", "2026-07-10"), null);
  });

  test("a refused date declines the read instead of querying unbounded", async () => {
    const r = reader([]);
    const got = await loadSubnetHistoryColdTier(
      ENV,
      5,
      "2026-02-31",
      "2026-07-10",
      400,
      r.deps,
    );
    const seen = r.seen;
    assert.equal(got, null);
    assert.deepEqual(seen, []);
  });
});

describe("what the reader asks the lakehouse", () => {
  test("the subnet leg groups by day and bounds both ends", async () => {
    const r = reader([
      {
        snapshot_date: "2026-07-01",
        neuron_count: 256,
        validator_count: 18,
        total_stake_tao: 1.5,
        total_emission_tao: 0.25,
      },
    ]);
    const rows = await loadSubnetHistoryColdTier(
      ENV,
      64,
      "2026-06-01",
      "2026-07-10",
      400,
      r.deps,
    );
    assert.deepEqual(rows, [
      {
        snapshot_date: "2026-07-01",
        neuron_count: 256,
        validator_count: 18,
        total_stake_tao: 1.5,
        total_emission_tao: 0.25,
      },
    ]);
    const sql = r.seen[0]!;
    assert.match(sql, /FROM chain\.neuron_daily/);
    assert.match(sql, /netuid = 64/);
    assert.match(sql, /snapshot_date < '2026-07-10'/);
    assert.match(sql, /snapshot_date >= '2026-06-01'/);
    assert.match(sql, /GROUP BY snapshot_date/);
  });

  test("the neuron leg is keyed by both netuid and uid", async () => {
    const r = reader([{ snapshot_date: "2026-07-01", uid: 12 }]);
    await loadNeuronHistoryColdTier(
      ENV,
      5,
      12,
      null,
      "2026-07-10",
      400,
      r.deps,
    );
    const sql = r.seen[0]!;
    assert.match(sql, /netuid = 5 AND uid = 12/);
    // No lower bound on an `all` window, but the seam still bounds the top.
    assert.match(sql, /snapshot_date < '2026-07-10'/);
    assert.doesNotMatch(sql, /snapshot_date >=/);
  });

  test("a non-numeric netuid never reaches the engine", async () => {
    const r = reader([]);
    assert.equal(
      await loadSubnetHistoryColdTier(
        ENV,
        "5; DROP TABLE",
        null,
        "2026-07-10",
        400,
        r.deps,
      ),
      null,
    );
    assert.deepEqual(r.seen, []);
  });

  test("a grouped row with no day is dropped, not placed on a guess", async () => {
    const r = reader([
      { snapshot_date: null, neuron_count: 1 },
      { snapshot_date: "2026-07-01", neuron_count: 2 },
    ]);
    const rows = await loadSubnetHistoryColdTier(
      ENV,
      1,
      null,
      "2026-07-10",
      400,
      r.deps,
    );
    assert.deepEqual(
      rows?.map((x) => x.snapshot_date),
      ["2026-07-01"],
    );
  });

  test("a declining engine yields null, so the caller keeps the hot answer", async () => {
    const rows = await loadSubnetHistoryColdTier(
      ENV,
      1,
      null,
      "2026-07-10",
      400,
      reader(null).deps,
    );
    // null, NOT [] -- "we could not look" must not read as "nothing older".
    assert.equal(rows, null);
  });
});

describe("merging the two stores", () => {
  const day = (d: string, n: number) => ({ snapshot_date: d, neuron_count: n });

  test("each day appears once, newest first", () => {
    const merged = mergeHistoryDays(
      [day("2026-08-11", 1), day("2026-08-10", 2)],
      [day("2026-08-09", 3)],
      null,
      400,
      shiftIsoDate,
    );
    assert.deepEqual(
      merged.map((r) => r.snapshot_date),
      ["2026-08-11", "2026-08-10", "2026-08-09"],
    );
  });

  test("hot wins a day both stores claim", () => {
    // They should never disagree -- the reconciler exists to make that true --
    // but preferring the copy would hide exactly the drift it reports.
    const merged = mergeHistoryDays(
      [day("2026-08-02", 111)],
      [day("2026-08-02", 999)],
      null,
      400,
      shiftIsoDate,
    );
    assert.deepEqual(merged, [day("2026-08-02", 111)]);
  });

  test("the window is applied to the MERGED series, not to each leg", () => {
    // 7d anchored on the merged newest day: a caller gets 7 days whether they
    // came from one store or two.
    const merged = mergeHistoryDays(
      [day("2026-08-11", 1)],
      [day("2026-08-08", 2), day("2026-07-01", 3)],
      7,
      400,
      shiftIsoDate,
    );
    assert.deepEqual(
      merged.map((r) => r.snapshot_date),
      ["2026-08-11", "2026-08-08"],
    );
  });

  test("the point cap still bounds the response", () => {
    const merged = mergeHistoryDays(
      [day("2026-08-11", 1), day("2026-08-10", 2), day("2026-08-09", 3)],
      [],
      null,
      2,
      shiftIsoDate,
    );
    assert.equal(merged.length, 2);
  });

  test("a row without a usable day is dropped rather than sorted as one", () => {
    const merged = mergeHistoryDays(
      [{ snapshot_date: "" }, { snapshot_date: 7 }, day("2026-08-11", 1)],
      [],
      null,
      400,
      shiftIsoDate,
    );
    assert.deepEqual(merged, [day("2026-08-11", 1)]);
  });

  test("two empty legs are an empty series, not a throw", () => {
    assert.deepEqual(mergeHistoryDays([], [], 30, 400, shiftIsoDate), []);
  });
});
