// The scan window that bounds every scattered-key read on
// `chain.account_events` (#11131).
//
// The property under test is not "it adds a WHERE clause" -- it is that adding
// one does not change the answer. A cold-tier read here either returns exactly
// what the unbounded query returned or declines, so the tests below compare the
// walk's output against the rows a single unbounded scan would have handed back
// over the same fixture.
//
// The column is the other half. Measured against production, the same page cost
// 957.7 MB bounded on `block_number` and 2.9 MB bounded on `observed_at`, so the
// tests that pin WHICH column the bound names are load-bearing, not cosmetic.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_EVENTS_WINDOW_MS,
  PROBE_STEPS,
  WINDOW_GROWTH,
  windowedFloorRead,
  windowedRowRead,
} from "../src/account-events-window.ts";

type Row = Record<string, unknown>;

/** A fixed "now", so every window boundary in these tests is arithmetic. */
const NOW = 1_786_600_000_000;
const now = () => NOW;
const DAY = 86_400_000;

/**
 * An engine that honours the window, so the walk is measured against a table
 * rather than against a stub that replays itself.
 */
function engine(rows: Row[], { fail = -1 }: { fail?: number } = {}) {
  const seen: string[] = [];
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (seen.length - 1 === fail) return null;
    const lo = Number(/observed_at >= (\d+)/.exec(sql)?.[1] ?? 0);
    const hiMatch = /observed_at <= (\d+)/.exec(sql);
    const hi = hiMatch ? Number(hiMatch[1]) : Number.POSITIVE_INFINITY;
    const limit = Number(/LIMIT (\d+)\s*$/.exec(sql)?.[1] ?? rows.length);
    return rows
      .filter((r) => Number(r.observed_at) >= lo && Number(r.observed_at) <= hi)
      .sort((a, b) => Number(b.observed_at) - Number(a.observed_at))
      .slice(0, limit);
  };
  return { query, seen };
}

/** Rows at the given ages, in days before NOW. */
function rowsAgedDays(...ages: number[]): Row[] {
  return ages.map((d) => ({ observed_at: NOW - d * DAY }));
}

const feed = (need: number, extra: Record<string, unknown> = {}) =>
  windowedRowRead<Row>({} as never, {
    table: "chain.account_events",
    columns: "observed_at",
    where: ["hotkey = 'x'"],
    order: " ORDER BY observed_at DESC",
    need,
    now,
    ...extra,
  });

describe("windowedRowRead", () => {
  test("BOUNDS ON observed_at, NOT block_number", async () => {
    // The correction that made this worth doing. Over the same one-day span the
    // engine scanned 60.2 MB via block_number and 0.6 MB via observed_at -- the
    // writer orders by observed_at, so file statistics are tight on it and loose
    // on block height. A bound on the wrong column looks identical in review and
    // costs 100x.
    const e = engine(rowsAgedDays(0.5));
    await feed(1, { query: e.query });
    assert.match(e.seen[0]!, /observed_at >= \d+/);
    assert.doesNotMatch(e.seen[0]!, /block_number/);
  });

  test("the first window is TWO DAYS wide", async () => {
    // Deliberately small, and the asymmetry is the design: overshooting costs
    // ~100x the bytes, undershooting costs one extra query at ~0.6 MB. One day
    // is too small only because the capture lane runs ~24h behind wall clock.
    const e = engine(rowsAgedDays(0.5));
    await feed(1, { query: e.query });
    assert.equal(
      Number(/observed_at >= (\d+)/.exec(e.seen[0]!)![1]),
      NOW - ACCOUNT_EVENTS_WINDOW_MS,
    );
    assert.equal(ACCOUNT_EVENTS_WINDOW_MS, 2 * DAY);
  });

  test("ONE window when the newest rows fill the page", async () => {
    // The common case and the whole point: a busy account never widens, so it
    // pays one 2.9 MB query where it used to pay a 1,933 MB scan.
    const e = engine(rowsAgedDays(0.1, 0.2, 0.3));
    const rows = await feed(2, { query: e.query });
    assert.equal(e.seen.length, 1);
    assert.deepEqual(rows, rowsAgedDays(0.1, 0.2));
  });

  test("the walk returns EXACTLY what one unbounded scan would have", async () => {
    // Rows scattered across four windows, so the concatenation has to span
    // slices for the result to be right.
    const table = rowsAgedDays(0.5, 6, 100, 900);
    const e = engine(table);
    const walked = await feed(4, { query: e.query });
    assert.deepEqual(walked, table, "the bound must not change the answer");
    assert.ok(e.seen.length > 1, "this fixture must exercise widening");
  });

  test("the newest slice carries NO ceiling; later slices do", async () => {
    // The capture lane writes behind wall clock, so a ceiling anchored on "now"
    // would exclude exactly the rows a newest-first feed exists to show. Later
    // slices need their ceiling to stay disjoint.
    const e = engine(rowsAgedDays(-1, 500)); // -1 day: newer than `now`
    const rows = await feed(2, { query: e.query });
    assert.doesNotMatch(e.seen[0]!, /observed_at <= /);
    assert.match(e.seen[1]!, /observed_at <= /);
    assert.deepEqual(
      rows,
      rowsAgedDays(-1, 500),
      "a row newer than now must still come back",
    );
  });

  test("slices are strictly disjoint and descending", async () => {
    // Every read after the first sits entirely below its predecessor's floor,
    // which is what lets the results be concatenated rather than merged -- and
    // what stops a row being returned by two of them.
    const e = engine(rowsAgedDays(5000));
    await feed(5, { query: e.query });
    const floors = e.seen
      .slice(0, PROBE_STEPS)
      .map((s) => Number(/observed_at >= (\d+)/.exec(s)![1]));
    const ceils = e.seen
      .slice(1)
      .map((s) => Number(/observed_at <= (\d+)/.exec(s)![1]));
    for (let i = 0; i < ceils.length; i++) {
      assert.ok(
        ceils[i]! < floors[i]!,
        `read ${i + 1} must sit below read ${i}'s floor`,
      );
    }
  });

  test("a failed slice fails the whole read", async () => {
    // A short page whose shortness has no visible cause is the silently-wrong
    // answer this family declines rather than serves.
    const e = engine(rowsAgedDays(0.5, 900), { fail: 1 });
    assert.equal(await feed(5, { query: e.query }), null);
  });

  test("a cursor resumes from ITS OWN observed_at, not from now", async () => {
    // cursor[0] of the 3-part token is `observed_at`, which is also the column
    // the walk slices on -- so a cursor page and a first page share one notion
    // of "where am I".
    const resume = NOW - 400 * DAY;
    const e = engine(rowsAgedDays(0.5, 400.5));
    await feed(1, { query: e.query, ceiling: resume });
    assert.match(e.seen[0]!, new RegExp(`observed_at <= ${resume}`));
    assert.equal(
      Number(/observed_at >= (\d+)/.exec(e.seen[0]!)![1]),
      resume - ACCOUNT_EVENTS_WINDOW_MS,
    );
  });

  test("PROBES TWICE, THEN READS THE REST IN ONE QUERY -- it does not keep widening", async () => {
    // The regression this guards. Widening all the way down for an account with
    // nothing cost 8 queries / 3,834.3 MB / 81.3s against 3,035.7 MB for the
    // single scan it replaced: proving absence needs the whole history, and a
    // walk buys that same scan several times over in overlapping file reads.
    const e = engine([]);
    await feed(1, { query: e.query });
    assert.equal(e.seen.length, PROBE_STEPS + 1, e.seen.join("\n"));
    const last = e.seen.at(-1)!;
    assert.doesNotMatch(
      last,
      /observed_at >=/,
      "the final read is unbounded below",
    );
    assert.match(last, /observed_at <= \d+/, "and disjoint from the probes");
  });

  test("the final read is DISJOINT from the probes, so no row is counted twice", async () => {
    const e = engine([]);
    await feed(1, { query: e.query });
    const lastProbeFloor = Number(
      /observed_at >= (\d+)/.exec(e.seen[PROBE_STEPS - 1]!)![1],
    );
    const restCeiling = Number(/observed_at <= (\d+)/.exec(e.seen.at(-1)!)![1]);
    assert.equal(restCeiling, lastProbeFloor - 1);
  });

  test("a floor that reaches the bottom ends the read there", async () => {
    // With `now` inside the first window there is nothing below it, so the
    // probe IS the whole table and the final read would scan an empty range.
    const e = engine([{ observed_at: 1_000 }]);
    const rows = await feed(5, { query: e.query, now: () => DAY });
    assert.equal(e.seen.length, 1);
    assert.match(e.seen[0]!, /observed_at >= 0\b/);
    assert.equal(rows!.length, 1);
  });

  test("a failed FINAL read declines, like a failed probe", async () => {
    // The probes are cheap and the final read is the expensive one, so this is
    // the failure most likely to be seen -- and a partial page here would be
    // the silently-truncated answer, not a smaller one.
    const e = engine([], { fail: PROBE_STEPS });
    assert.equal(await feed(1, { query: e.query }), null);
    assert.equal(e.seen.length, PROBE_STEPS + 1);
  });

  test("NO HEAD READ: the walk needs no anchor query", async () => {
    // The previous shape resolved the lakehouse head block before its first
    // slice -- a query and a dependency, both of which the observed_at bound
    // removes. Every query issued here must be the read itself.
    const e = engine(rowsAgedDays(0.5));
    await feed(1, { query: e.query });
    assert.equal(e.seen.length, 1);
    assert.match(e.seen[0]!, /FROM chain\.account_events/);
  });
});

describe("windowedFloorRead", () => {
  const aggregate = (
    e: ReturnType<typeof engine>,
    satisfiedAt: number,
    extra: Record<string, unknown> = {},
  ) =>
    windowedFloorRead<Row[]>({} as never, {
      now,
      query: e.query,
      attempt: (bound, run) =>
        run({} as never, `SELECT x FROM chain.account_events WHERE a${bound}`),
      satisfied: (rows) => rows.length >= satisfiedAt,
      ...extra,
    });

  test("ONE bounded read when the window already holds enough", async () => {
    // Measured on the summary card's grouped leg: 12.4 MB for the first window
    // against 2,801.6 MB unbounded.
    const e = engine(rowsAgedDays(0.1, 0.2, 0.3));
    const rows = await aggregate(e, 2);
    assert.equal(e.seen.length, 1);
    assert.match(e.seen[0]!, /observed_at >= \d+/);
    assert.equal(rows!.length, 3);
  });

  test("A QUIET ACCOUNT COSTS EXACTLY ONE EXTRA QUERY, never a walk", async () => {
    // Proving an account has fewer than N events means reading its whole
    // history, so the last window would be the whole table. Widening would
    // charge extra queries for the same full scan -- hence two phases.
    const e = engine(rowsAgedDays(0.5));
    const rows = await aggregate(e, 5);
    assert.equal(e.seen.length, 2, e.seen.join("\n"));
    assert.match(e.seen[0]!, /observed_at >= \d+/);
    assert.doesNotMatch(
      e.seen[1]!,
      /observed_at >=/,
      "the fallback is unbounded",
    );
    assert.equal(rows!.length, 1);
  });

  test("no ceiling on the bounded attempt, so the range stays a suffix", async () => {
    // "The newest N within the range" is only "the newest N overall" while the
    // range runs to the top of the table.
    const e = engine(rowsAgedDays(-1));
    await aggregate(e, 1);
    assert.doesNotMatch(e.seen[0]!, /observed_at <= /);
  });

  test("a failed bounded attempt declines instead of falling through", async () => {
    // Falling through would turn an engine failure into a full-table scan --
    // the most expensive possible response to the engine being unwell.
    const e = engine(rowsAgedDays(0.5), { fail: 0 });
    assert.equal(await aggregate(e, 1), null);
    assert.equal(e.seen.length, 1);
  });
});

describe("the window constants", () => {
  test("the probes stop before the cost curve turns", () => {
    // 3.0 MB at 2 days, 18.8 MB at 8, then 607.2 MB at 32 -- so two probes sit
    // just below the knee. A third would cost more than the full read it is
    // trying to avoid.
    let reach = 0;
    let window = ACCOUNT_EVENTS_WINDOW_MS;
    for (let i = 0; i < PROBE_STEPS; i++) {
      reach += window;
      window *= WINDOW_GROWTH;
    }
    assert.equal(reach / DAY, 10, "2 days + 8 days of probing");
  });
});

describe("the default reader", () => {
  test("both helpers fall back to the real r2-sql reader when none is injected", async () => {
    // `query` is optional on both. An untested default is how a module grows a
    // second, divergent path to the same engine -- and an UNCONFIGURED env is
    // the one input that exercises it without a network call, because
    // r2SqlQuery declines before it builds a request.
    const unconfigured = {} as never;
    assert.equal(
      await windowedRowRead(unconfigured, {
        table: "chain.account_events",
        columns: "observed_at",
        where: ["hotkey = 'x'"],
        order: " ORDER BY observed_at DESC",
        need: 1,
        now,
      }),
      null,
    );
    assert.equal(
      await windowedFloorRead(unconfigured, {
        now,
        attempt: (bound, run) =>
          run(
            unconfigured,
            `SELECT x FROM chain.account_events WHERE a${bound}`,
          ),
        satisfied: () => true,
      }),
      null,
    );
  });
});
