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
  coverageOf,
  loadAccountPositionHistoryColdTier,
  loadValidatorHistoryColdTier,
  overlayAccountPositionHistoryColdTier,
  overlayNeuronHistoryColdTier,
  overlaySubnetHistoryColdTier,
  overlayValidatorHistoryColdTier,
} from "../src/neuron-daily-cold-tier.ts";
import { buildAccountPositionHistory } from "../src/account-position-history.ts";
import { buildValidatorHistory } from "../src/validator-history.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
} from "../src/neuron-history.ts";
import { R2_SQL_TOKEN_ENV, safeIsoDate } from "../src/r2-sql.ts";
import { shiftIsoDate } from "../src/iso-date-window.ts";

const ENV = { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env;
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

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

describe("the overlay, where the tiers converge", () => {
  const point = (d: string, n: number) => ({
    snapshot_date: d,
    neuron_count: n,
    validator_count: 1,
    total_stake_tao: 1,
    total_emission_tao: 1,
  });

  test("a hot payload that already covers the window is returned unchanged", async () => {
    const r = reader([]);
    // The hot series must reach the window's own start (08-11 minus 7d =
    // 08-04) for there to be nothing missing. An oldest_day ABOVE that start
    // is a genuine hole and correctly opens a cold read -- which is what an
    // earlier version of this fixture accidentally proved.
    const hot = buildSubnetHistory(
      [point("2026-08-11", 1), point("2026-08-04", 2)],
      64,
      { window: "7d" },
    );
    const out = await overlaySubnetHistoryColdTier(
      ENV,
      hot,
      64,
      { label: "7d", days: 7 },
      r.deps,
    );
    assert.equal(out, hot);
    // Not merely equal -- the engine was never asked.
    assert.deepEqual(r.seen, []);
  });

  test("a window the hot tier ran out of is extended, and the coverage fields follow", async () => {
    const r = reader([
      {
        snapshot_date: "2026-07-05",
        neuron_count: 250,
        validator_count: 10,
        total_stake_tao: 5,
        total_emission_tao: 2,
      },
    ]);
    const hot = buildSubnetHistory([point("2026-07-10", 256)], 64, {
      window: "1y",
    });
    assert.equal(hot.point_count, 1);
    const out = await overlaySubnetHistoryColdTier(
      ENV,
      hot,
      64,
      { label: "1y", days: 365 },
      r.deps,
    );
    assert.equal(out.point_count, 2);
    // REBUILT, not patched: the coverage fields describe what is served.
    assert.equal(out.oldest_day, "2026-07-05");
    assert.equal(out.newest_day, "2026-07-10");
    assert.equal(out.days_covered, 2);
    assert.equal(out.window, "1y");
  });

  test("a declining engine leaves the hot answer exactly as it was", async () => {
    const hot = buildSubnetHistory([point("2026-07-10", 256)], 64, {
      window: "all",
    });
    const out = await overlaySubnetHistoryColdTier(
      ENV,
      hot,
      64,
      { label: "all", days: null },
      reader(null).deps,
    );
    assert.equal(out, hot);
  });

  test("an empty cold answer is not mistaken for an extension", async () => {
    const hot = buildSubnetHistory([point("2026-07-10", 256)], 64, {
      window: "all",
    });
    const out = await overlaySubnetHistoryColdTier(
      ENV,
      hot,
      64,
      { label: "all", days: null },
      reader([]).deps,
    );
    assert.equal(out, hot);
  });

  test("the neuron overlay extends its own series the same way", async () => {
    const r = reader([
      { snapshot_date: "2026-07-05", uid: 12, hotkey: "5Hot" },
    ]);
    const hot = buildNeuronHistory(
      [{ snapshot_date: "2026-07-10", uid: 12, hotkey: "5Hot" }],
      5,
      12,
      { window: "all" },
    );
    const out = await overlayNeuronHistoryColdTier(
      ENV,
      hot,
      5,
      12,
      { label: "all", days: null },
      r.deps,
    );
    assert.equal(out.point_count, 2);
    assert.equal(out.oldest_day, "2026-07-05");
    assert.match(r.seen[0]!, /netuid = 5 AND uid = 12/);
  });

  test("the neuron overlay declines when the hot tier already reached the window", async () => {
    const r = reader([]);
    const hot = buildNeuronHistory(
      [
        { snapshot_date: "2026-08-11", uid: 12 },
        { snapshot_date: "2026-08-04", uid: 12 },
      ],
      5,
      12,
      { window: "7d" },
    );
    const out = await overlayNeuronHistoryColdTier(
      ENV,
      hot,
      5,
      12,
      { label: "7d", days: 7 },
      r.deps,
    );
    assert.equal(out, hot);
    assert.deepEqual(r.seen, []);
  });
});

describe("the edges the branch counter cares about", () => {
  test("a null seam bounds nothing above, and a null start nothing below", () => {
    assert.deepEqual(coldDateRange(null, null), { lo: null, hi: null });
    assert.deepEqual(coldDateRange("2026-06-01", null), {
      lo: "2026-06-01",
      hi: null,
    });
  });

  test("an unbounded range emits no date predicate at all", async () => {
    const r = reader([]);
    await loadSubnetHistoryColdTier(ENV, 7, null, null, 400, r.deps);
    assert.doesNotMatch(r.seen[0]!, /snapshot_date [<>]/);
  });

  test("a malformed SEAM is refused, not just a malformed start", () => {
    assert.equal(coldDateRange(null, "not-a-day"), null);
  });

  test("a bad uid never reaches the engine", async () => {
    const r = reader([]);
    assert.equal(
      await loadNeuronHistoryColdTier(ENV, 5, -1, null, null, 400, r.deps),
      null,
    );
    assert.deepEqual(r.seen, []);
  });

  test("the neuron leg refuses a malformed day too", async () => {
    const r = reader([]);
    assert.equal(
      await loadNeuronHistoryColdTier(
        ENV,
        5,
        12,
        "2026-02-31",
        null,
        400,
        r.deps,
      ),
      null,
    );
    assert.deepEqual(r.seen, []);
  });

  test("a declining engine on the NEURON leg is null as well", async () => {
    assert.equal(
      await loadNeuronHistoryColdTier(
        ENV,
        5,
        12,
        null,
        null,
        400,
        reader(null).deps,
      ),
      null,
    );
  });

  test("aggregate cells that are blank or unparseable become null, not NaN", async () => {
    const r = reader([
      {
        snapshot_date: "2026-07-01",
        neuron_count: "",
        validator_count: "nope",
        total_stake_tao: "1.5",
        total_emission_tao: null,
      },
    ]);
    const rows = await loadSubnetHistoryColdTier(
      ENV,
      1,
      null,
      null,
      400,
      r.deps,
    );
    assert.deepEqual(rows, [
      {
        snapshot_date: "2026-07-01",
        neuron_count: null,
        validator_count: null,
        // A numeric STRING is still a number -- some engines return them.
        total_stake_tao: 1.5,
        total_emission_tao: null,
      },
    ]);
  });

  test("a coverage field that is not a string is treated as absent", () => {
    // asDay's guard: a non-string would otherwise reach a date comparison and
    // compare as garbage rather than fail.
    assert.deepEqual(
      coldWindow(
        { oldest_day: "2026-07-10", newest_day: null },
        30,
        shiftIsoDate,
      ),
      // No newest_day to anchor on, so the seam anchors the window itself.
      { start: "2026-06-10", seam: "2026-07-10" },
    );
  });

  test("an unshiftable day declines rather than fetching unbounded", () => {
    assert.equal(
      coldWindow(
        { oldest_day: "garbage", newest_day: "garbage" },
        30,
        () => null,
      ),
      null,
    );
  });

  test("a payload with no points array at all still overlays", async () => {
    const r = reader([
      {
        snapshot_date: "2026-07-05",
        neuron_count: 1,
        validator_count: 1,
        total_stake_tao: 1,
        total_emission_tao: 1,
      },
    ]);
    const hot = { ...buildSubnetHistory([], 64, { window: "all" }) };
    delete (hot as Record<string, unknown>).points;
    (hot as Record<string, unknown>).oldest_day = "2026-07-10";
    (hot as Record<string, unknown>).newest_day = "2026-07-10";
    const out = await overlaySubnetHistoryColdTier(
      ENV,
      hot,
      64,
      { label: "all", days: null },
      r.deps,
    );
    assert.equal(out.point_count, 1);
  });
});

describe("safeIsoDate", () => {
  test("accepts a real day and refuses everything else", () => {
    assert.equal(safeIsoDate("2026-08-11"), "2026-08-11");
    assert.equal(safeIsoDate(" 2026-08-11 "), "2026-08-11");
    assert.equal(safeIsoDate(20260811), null);
    assert.equal(safeIsoDate(null), null);
    assert.equal(safeIsoDate("2026-8-1"), null);
    assert.equal(safeIsoDate("2026-02-31"), null);
    assert.equal(safeIsoDate("2026-13-01"), null);
    assert.equal(safeIsoDate("0000-00-00"), null);
  });
});

describe("the last three branches, on the neuron overlay", () => {
  test("a non-string coverage field reads as absent", async () => {
    // asDay's false arm: without it a number would reach a date comparison
    // and compare as garbage rather than fail.
    const r = reader([{ snapshot_date: "2026-07-05", uid: 1 }]);
    const hot = buildNeuronHistory([], 5, 1, { window: "all" });
    (hot as Record<string, unknown>).oldest_day = 20260710;
    (hot as Record<string, unknown>).newest_day = 20260710;
    const out = await overlayNeuronHistoryColdTier(
      ENV,
      hot,
      5,
      1,
      { label: "all", days: null },
      r.deps,
    );
    // oldest_day unusable -> seam null -> the cold side is the only side.
    assert.equal(out.point_count, 1);
  });

  test("an empty cold answer leaves the neuron payload alone", async () => {
    const hot = buildNeuronHistory(
      [{ snapshot_date: "2026-07-10", uid: 1 }],
      5,
      1,
      {
        window: "all",
      },
    );
    const out = await overlayNeuronHistoryColdTier(
      ENV,
      hot,
      5,
      1,
      { label: "all", days: null },
      reader([]).deps,
    );
    assert.equal(out, hot);
  });

  test("a neuron payload with no points array still overlays", async () => {
    const r = reader([{ snapshot_date: "2026-07-05", uid: 1 }]);
    const hot = { ...buildNeuronHistory([], 5, 1, { window: "all" }) };
    delete (hot as Record<string, unknown>).points;
    (hot as Record<string, unknown>).oldest_day = "2026-07-10";
    (hot as Record<string, unknown>).newest_day = "2026-07-10";
    const out = await overlayNeuronHistoryColdTier(
      ENV,
      hot,
      5,
      1,
      { label: "all", days: null },
      r.deps,
    );
    assert.equal(out.point_count, 1);
  });
});

describe("the other two families that reach 1y and all", () => {
  test("coverageOf reads the seam off the POINTS, for builders with no coverage fields", () => {
    // buildValidatorHistory and buildAccountPositionHistory publish no
    // oldest_day, so the seam is computed rather than read. This is the more
    // general form -- oldest_day is only ever a cached answer to it.
    assert.deepEqual(
      coverageOf([
        { snapshot_date: "2026-08-04" },
        { snapshot_date: "2026-07-10" },
        { snapshot_date: "2026-08-11" },
      ]),
      { oldest_day: "2026-07-10", newest_day: "2026-08-11" },
    );
    assert.deepEqual(coverageOf([]), {
      oldest_day: null,
      newest_day: null,
    });
    assert.deepEqual(coverageOf(undefined), {
      oldest_day: null,
      newest_day: null,
    });
    assert.deepEqual(coverageOf([{ snapshot_date: 7 }, null]), {
      oldest_day: null,
      newest_day: null,
    });
  });

  test("the account-position leg is keyed by account AND netuid", async () => {
    const r = reader([{ snapshot_date: "2026-07-01", uid: 3 }]);
    const rows = await loadAccountPositionHistoryColdTier(
      ENV,
      ADDR,
      64,
      null,
      "2026-07-10",
      400,
      r.deps,
    );
    assert.equal(rows?.length, 1);
    const sql = r.seen[0]!;
    assert.match(sql, /FROM chain\.account_position_daily/);
    assert.match(sql, new RegExp(`account = '${ADDR}'`));
    assert.match(sql, /netuid = 64/);
    assert.match(sql, /snapshot_date < '2026-07-10'/);
  });

  test("a malformed ss58 never reaches the engine", async () => {
    const r = reader([]);
    assert.equal(
      await loadAccountPositionHistoryColdTier(
        ENV,
        "not-an-address'; DROP",
        64,
        null,
        null,
        400,
        r.deps,
      ),
      null,
    );
    assert.equal(
      await loadAccountPositionHistoryColdTier(
        ENV,
        ADDR,
        "x",
        null,
        null,
        400,
        r.deps,
      ),
      null,
    );
    assert.deepEqual(r.seen, []);
  });

  test("the validator leg JOINs subnet_snapshots for the TAO pricing", async () => {
    const r = reader([{ snapshot_date: "2026-07-01", netuid: 1 }]);
    await loadValidatorHistoryColdTier(
      ENV,
      ADDR,
      null,
      null,
      "2026-07-10",
      400,
      r.deps,
    );
    const sql = r.seen[0]!;
    assert.match(sql, /FROM chain\.neuron_daily nd/);
    // Without this join the route can only serve alpha, never TAO -- which is
    // why metagraphed-infra#447 carries subnet_snapshots at all.
    assert.match(sql, /LEFT JOIN chain\.subnet_snapshots s/);
    assert.match(sql, new RegExp(`nd\\.hotkey = '${ADDR}'`));
    // The date bound must name nd's column: BOTH tables carry snapshot_date.
    assert.match(sql, /nd\.snapshot_date < '2026-07-10'/);
    assert.doesNotMatch(sql, /[^.]snapshot_date < '/);
  });

  test("the validator leg scopes to one subnet when asked, and refuses a bad one", async () => {
    const r = reader([]);
    await loadValidatorHistoryColdTier(ENV, ADDR, 7, null, null, 400, r.deps);
    assert.match(r.seen[0]!, /nd\.netuid = 7/);
    const r2 = reader([]);
    assert.equal(
      await loadValidatorHistoryColdTier(
        ENV,
        ADDR,
        -3,
        null,
        null,
        400,
        r2.deps,
      ),
      null,
    );
    assert.deepEqual(r2.seen, []);
  });

  test("a malformed hotkey never reaches the engine", async () => {
    const r = reader([]);
    assert.equal(
      await loadValidatorHistoryColdTier(
        ENV,
        "nope",
        null,
        null,
        null,
        400,
        r.deps,
      ),
      null,
    );
    assert.deepEqual(r.seen, []);
  });

  test("both new overlays extend, decline and pass through like the others", async () => {
    // Extends.
    const ext = reader([{ snapshot_date: "2026-07-05", uid: 1 }]);
    const hotAcct = buildAccountPositionHistory(
      [{ snapshot_date: "2026-07-10", uid: 1 }],
      ADDR,
      64,
      { window: "all" },
    );
    const out = await overlayAccountPositionHistoryColdTier(
      ENV,
      hotAcct,
      ADDR,
      64,
      { label: "all", days: null },
      ext.deps,
    );
    assert.equal(out.point_count, 2);

    // Declines -> unchanged.
    assert.equal(
      await overlayAccountPositionHistoryColdTier(
        ENV,
        hotAcct,
        ADDR,
        64,
        { label: "all", days: null },
        reader(null).deps,
      ),
      hotAcct,
    );

    // Empty cold -> unchanged.
    assert.equal(
      await overlayAccountPositionHistoryColdTier(
        ENV,
        hotAcct,
        ADDR,
        64,
        { label: "all", days: null },
        reader([]).deps,
      ),
      hotAcct,
    );

    // Window already satisfied -> no query at all.
    const none = reader([]);
    const wide = buildAccountPositionHistory(
      [{ snapshot_date: "2026-08-11" }, { snapshot_date: "2026-08-04" }],
      ADDR,
      64,
      { window: "7d" },
    );
    assert.equal(
      await overlayAccountPositionHistoryColdTier(
        ENV,
        wide,
        ADDR,
        64,
        { label: "7d", days: 7 },
        none.deps,
      ),
      wide,
    );
    assert.deepEqual(none.seen, []);
  });

  test("the validator overlay extends, declines and passes through too", async () => {
    const ext = reader([{ snapshot_date: "2026-07-05", netuid: 1 }]);
    const hotVal = buildValidatorHistory(
      [{ snapshot_date: "2026-07-10", netuid: 1 }],
      ADDR,
      { window: "all", netuid: null },
    );
    const out = await overlayValidatorHistoryColdTier(
      ENV,
      hotVal,
      ADDR,
      null,
      { label: "all", days: null },
      ext.deps,
    );
    assert.equal(out.point_count, 2);

    assert.equal(
      await overlayValidatorHistoryColdTier(
        ENV,
        hotVal,
        ADDR,
        null,
        { label: "all", days: null },
        reader(null).deps,
      ),
      hotVal,
    );
    assert.equal(
      await overlayValidatorHistoryColdTier(
        ENV,
        hotVal,
        ADDR,
        null,
        { label: "all", days: null },
        reader([]).deps,
      ),
      hotVal,
    );

    const none = reader([]);
    const wide = buildValidatorHistory(
      [{ snapshot_date: "2026-08-11" }, { snapshot_date: "2026-08-04" }],
      ADDR,
      { window: "7d", netuid: null },
    );
    assert.equal(
      await overlayValidatorHistoryColdTier(
        ENV,
        wide,
        ADDR,
        null,
        { label: "7d", days: 7 },
        none.deps,
      ),
      wide,
    );
    assert.deepEqual(none.seen, []);
  });
});

describe("the last edges on the two new legs", () => {
  test("a malformed day is refused on both new legs, before any query", async () => {
    const r = reader([]);
    assert.equal(
      await loadAccountPositionHistoryColdTier(
        ENV,
        ADDR,
        64,
        "2026-02-31",
        null,
        400,
        r.deps,
      ),
      null,
    );
    assert.equal(
      await loadValidatorHistoryColdTier(
        ENV,
        ADDR,
        null,
        "2026-13-01",
        null,
        400,
        r.deps,
      ),
      null,
    );
    assert.deepEqual(r.seen, []);
  });

  test("both new overlays cope with a payload carrying no points array", async () => {
    const acct = {
      ...buildAccountPositionHistory([], ADDR, 64, { window: "all" }),
    };
    delete (acct as Record<string, unknown>).points;
    const outA = await overlayAccountPositionHistoryColdTier(
      ENV,
      acct as ReturnType<typeof buildAccountPositionHistory>,
      ADDR,
      64,
      { label: "all", days: null },
      reader([{ snapshot_date: "2026-07-05", uid: 1 }]).deps,
    );
    assert.equal(outA.point_count, 1);

    const val = {
      ...buildValidatorHistory([], ADDR, { window: "all", netuid: null }),
    };
    delete (val as Record<string, unknown>).points;
    const outV = await overlayValidatorHistoryColdTier(
      ENV,
      val,
      ADDR,
      null,
      { label: "all", days: null },
      reader([{ snapshot_date: "2026-07-05", netuid: 1 }]).deps,
    );
    assert.equal(outV.point_count, 1);
  });
});
