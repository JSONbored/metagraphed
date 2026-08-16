// The validator-nominator-counts lane's alarm (#9301) and its cron wiring.
//
// The rule's edges are the point, and two of them matter here. An EMPTY table
// alerts: that is the pre-cutover state, in which every nominator_count is
// still coming from a frozen lakehouse mirror or serving null outright, which
// is exactly the condition that ran unnoticed from 2026-08-02. And a capture
// from the middle of the producer's 24h cycle is QUIET -- the threshold is
// derived from that cadence rather than picked, because an alarm that fires on
// a healthy lane is one nobody reads.
//
// The COVERAGE edge is not about time at all. This lane's writer is explicitly
// NO PRUNE, so a chunked pass that dies partway upserts the hotkeys it reached
// to a new stamp and leaves the rest at the old one -- a table that reads fresh
// from its MAX() alone while serving a pass-old nominator_count for everything
// the scan never got to. The production reading behind #9530 is asserted below
// on this lane's own numbers.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The store is Postgres now (#10179), reached through `new Client(...)` inside
// src/read-store.ts and src/lane-health-store.ts -- neither of which this
// watchdog can be handed, because it selects its own store from `env`. Mocking
// the module is the seam; see tests/helpers/pg-mock.ts for why it is a module
// mock and why the controller has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS,
  VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS,
  VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS,
  VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
  evaluateValidatorNominatorCountsStaleness,
  runValidatorNominatorCountsStalenessWatchdog,
} from "../src/validator-nominator-counts-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import { runStalenessLane } from "./helpers/staleness-lane.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60_000;
/** A pass that covered the scan, so coverage is never the thing under test
 * unless a case says so. */
const FULL = VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS;

/** The lane's one read, answered from the pg double, plus the env that points
 * the watchdog at it.
 *
 * `queries` and `binds` are LIVE views over the mock's log rather than copies,
 * because every caller destructures them and reads them after the tick has run
 * -- a getter would be evaluated once, at destructure time, and freeze empty.
 *
 * A thrown `latest` fails the NEXT statement, which is the read: the watchdog
 * catches it and never reaches the lane_health write. A string is accepted as
 * well as an Error because a driver rejecting with a bare string is one of the
 * cases under test. */
function fakeDb(
  latest: number | null | Error | string,
  covered: number = FULL,
  total: number = FULL,
) {
  const queries: string[] = [];
  const binds: unknown[][] = [];
  const throws = typeof latest === "string" || latest instanceof Error;
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = throws ? null : [{ latest, covered, total }];
  pg.control.failNext = throws ? (latest as Error) : null;
  pg.control.onQuery = (q) => {
    queries.push(q.text);
    binds.push(q.values);
  };
  return { queries, binds, env: pgMockEnv() };
}

/** A store that answers with no row at all, which is not the same as a row of
 * nulls: `first()` returns null and the rule has to read that as an empty
 * table rather than throwing on a property of null. */
function noRowDb() {
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.failNext = null;
  pg.control.onQuery = null;
  pg.control.rows = [];
  return pgMockEnv();
}

/** The rule's inputs with everything healthy, so each case overrides only the
 * one field it is about. */
function inputs(
  over: Partial<
    Parameters<typeof evaluateValidatorNominatorCountsStaleness>[0]
  > = {},
) {
  return {
    latestCapturedAtMs: NOW - 2 * HOUR,
    coveredRows: FULL,
    totalRows: FULL,
    nowMs: NOW,
    thresholdMs: VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    coverageFloorRows: VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS,
    ...over,
  };
}

describe("evaluateValidatorNominatorCountsStaleness", () => {
  test("a recent pass is quiet; one past the threshold is a stall", () => {
    const fresh = evaluateValidatorNominatorCountsStaleness(inputs());
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, null);
    assert.equal(fresh.age_ms, 2 * HOUR);

    const stalled = evaluateValidatorNominatorCountsStaleness(
      inputs({ latestCapturedAtMs: NOW - 31 * HOUR }),
    );
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
    assert.equal(stalled.latest_captured_at, NOW - 31 * HOUR);
  });

  test("a capture from the middle of the producer's 24h cycle is quiet", () => {
    // The threshold has to clear one whole cadence: the producer scans every
    // 24h, so a healthy lane presents an age anywhere in [0h, 24h+scan] and
    // any threshold at or under 24h alerts on a lane that is working.
    for (const hours of [7, 12, 20, 23, 24]) {
      const verdict = evaluateValidatorNominatorCountsStaleness(
        inputs({ latestCapturedAtMs: NOW - hours * HOUR }),
      );
      assert.equal(
        verdict.stale,
        false,
        `${hours}h into a 24h cycle must not alert`,
      );
    }
  });

  test("exactly at the threshold is not yet a stall", () => {
    // Strictly-greater, so a lane running exactly on cadence never flaps.
    const verdict = evaluateValidatorNominatorCountsStaleness(
      inputs({
        latestCapturedAtMs:
          NOW - VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
      }),
    );
    assert.equal(verdict.stale, false);
  });

  test("an empty table is a stall of infinite age, never a healthy quiet", () => {
    const verdict = evaluateValidatorNominatorCountsStaleness(
      inputs({ latestCapturedAtMs: null, coveredRows: 0, totalRows: 0 }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
    assert.equal(verdict.latest_captured_at, null);
  });

  test("HALF THE HOTKEYS RECENTLY and ALL THE HOTKEYS RECENTLY are told apart", () => {
    // The acceptance criterion. Both ticks carry an identically fresh
    // MAX(captured_at); the ONLY difference is how many hotkeys the pass
    // reached, which is exactly what a timestamp cannot express.
    // A FRACTION of the expectation, not a literal: `54_000` was half of the
    // old 112,245 and is above the whole measured population, so it would now
    // read as a complete pass and assert nothing.
    const half = evaluateValidatorNominatorCountsStaleness(
      inputs({ coveredRows: Math.round(FULL / 2), totalRows: FULL }),
    );
    assert.equal(half.stale, true, "a half-covered pass must not read as ok");
    assert.equal(half.reason, "partial");
    // Recent, not old -- caught WITHOUT any time passing.
    assert.equal(half.age_ms, 2 * HOUR);
    assert.ok(half.age_ms < half.threshold_ms);

    const whole = evaluateValidatorNominatorCountsStaleness(inputs());
    assert.equal(whole.stale, false);
    assert.equal(whole.reason, null);
    assert.equal(whole.age_ms, half.age_ms);
  });

  test("a pass that died mid-scan is caught, wherever it died", () => {
    // The chunk grid this used to assert (25k / 50k / 75k / 100k) is GONE. It
    // followed from a 112,245-hotkey expectation across a 25,000-row sync cap,
    // ~5 requests. Measured on chain 2026-08-14 the population is 21,547, so a
    // full pass fits in ONE request and there are no interior boundaries left
    // for a death to land on -- see the ratio's comment.
    //
    // What still has to hold is the property the grid was standing in for: a
    // pass that covered materially less than the population must alert. These
    // are fractions of the expectation rather than absolute counts, so the next
    // re-anchor moves them automatically instead of silently re-encoding a
    // population that has moved on.
    for (const fraction of [0.25, 0.5, 0.75]) {
      const covered = Math.round(
        VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS * fraction,
      );
      const verdict = evaluateValidatorNominatorCountsStaleness(
        inputs({ coveredRows: covered, totalRows: FULL }),
      );
      assert.equal(
        verdict.reason,
        "partial",
        `a pass that reached only ${Math.round(fraction * 100)}% of the population must alert`,
      );
    }
    // The documented gap, still a decision rather than a surprise: a pass just
    // inside the 80% tolerance clears, because tightening further would put the
    // alarm inside the noise band of ordinary churn.
    const nearlyWhole = evaluateValidatorNominatorCountsStaleness(
      inputs({
        coveredRows: Math.round(
          VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS * 0.9,
        ),
        totalRows: FULL,
      }),
    );
    assert.equal(nearlyWhole.stale, false);
  });

  test("the real 2026-08-14 pass reads as COMPLETE, not partial", () => {
    // The regression this re-anchor is for. Production reported 21,548 hotkeys
    // covered and alarmed continuously that /validators served silently stale
    // counts. Counted on chain the same day -- twox128 prefix walk of
    // SubtensorModule::Alpha, 120,253 entries ending on a short page -- there
    // are 21,547 distinct hotkeys. The pass was complete; the constant was not.
    const verdict = evaluateValidatorNominatorCountsStaleness(
      inputs({ coveredRows: 21_548, totalRows: 112_250 }),
    );
    assert.equal(verdict.stale, false);
    assert.notEqual(verdict.reason, "partial");
  });

  test("the no-prune stragglers do not count against coverage", () => {
    // Measured 2026-08-05: 112,250 rows across three vintages -- 112,245 at the
    // newest stamp, then 1 and 4 older. Those five are the no-prune behaviour
    // working as designed, and a healthy tick must stay quiet with them present.
    const verdict = evaluateValidatorNominatorCountsStaleness(
      inputs({ coveredRows: 112_245, totalRows: 112_250 }),
    );
    assert.equal(verdict.stale, false);
    assert.equal(verdict.reason, null);
  });

  test("a pass exactly at the floor is complete; one row under is not", () => {
    // Strictly-less, matching the threshold edge, so a lane landing exactly on
    // the floor never flaps.
    const atFloor = evaluateValidatorNominatorCountsStaleness(
      inputs({ coveredRows: VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS }),
    );
    assert.equal(atFloor.stale, false);
    assert.equal(atFloor.reason, null);

    const under = evaluateValidatorNominatorCountsStaleness(
      inputs({
        coveredRows: VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS - 1,
      }),
    );
    assert.equal(under.stale, true);
    assert.equal(under.reason, "partial");
  });

  test("a stalled lane reports `stale`, not `partial`, even when also short", () => {
    // If a whole pass has been missed, "the producer stopped" is the headline
    // and the coverage of its last attempt is a detail.
    const verdict = evaluateValidatorNominatorCountsStaleness(
      inputs({
        latestCapturedAtMs: NOW - 31 * HOUR,
        coveredRows: Math.round(FULL / 2),
      }),
    );
    assert.equal(verdict.reason, "stale");
  });
});

describe("runValidatorNominatorCountsStalenessWatchdog", () => {
  test("a fresh lane reports quiet and records nothing", async () => {
    const { env, queries } = fakeDb(NOW - HOUR);
    const recorded: unknown[] = [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: unknown) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.deepEqual(recorded, []);
    assert.match(queries[0]!, /MAX\(captured_at\)/);
    assert.match(queries[0]!, /FROM validator_nominator_counts/);
    // The coverage half has to be IN the read, or the rule is being handed a
    // number nothing measured.
    assert.match(queries[0]!, /AS covered/);
  });

  test("a stalled lane records ONE exception naming the age and the route it breaks", async () => {
    const { env } = fakeDb(NOW - 48 * HOUR);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: never) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.alerted, true);
    assert.equal(recorded.length, 1);
    assert.equal(
      recorded[0]!.route,
      "watchdog:validator-nominator-counts-staleness",
    );
    assert.equal(recorded[0]!.errorCode, "stale_lane");
    assert.match(String(recorded[0]!.error?.message), /48\.0 h old/);
    assert.match(String(recorded[0]!.error?.message), /threshold 30 h/);
    assert.match(String(recorded[0]!.error?.message), /nominator_count/);
  });

  test("an empty table alerts with the no-rows wording", async () => {
    const { env } = fakeDb(null);
    const recorded: { error?: Error }[] = [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: never) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "no_rows");
    assert.match(String(recorded[0]!.error?.message), /no rows at all/);
  });

  test("the env threshold override wins over the default", async () => {
    const { env } = fakeDb(NOW - 2 * HOUR);
    const result = await runValidatorNominatorCountsStalenessWatchdog(
      {
        ...env,
        VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, HOUR);
  });

  test("the read counts only the newest pass, bounded by the pass window", () => {
    // A window spanning the 24h poll interval would sum two consecutive passes
    // into one coverage count, so a truncated pass landing on a complete one
    // would report full coverage -- the bug, restored.
    const { env, queries, binds } = fakeDb(NOW - HOUR);
    return runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async () => true) as never,
    }).then(() => {
      assert.deepEqual(binds[0], [VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS]);
      assert.ok(
        VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS < 24 * HOUR,
        "the window must stay under VALIDATOR_NOMINATORS_POLL_SECS (24h)",
      );
      // Counted against the newest stamp, not against `now` -- a lane that is
      // merely late must not also read as uncovered.
      //
      // `$n`, not `?`: the watchdog writes SQLite's placeholder and
      // toPositionalPlaceholders rewrites it on the way to Postgres. #9821 is
      // what happens when it does not -- six routes served zero rows because a
      // `?` reached Postgres unrewritten and matched nothing.
      assert.match(
        queries[0]!,
        /captured_at >= \(SELECT MAX\(captured_at\) FROM validator_nominator_counts\) - \$\d/,
      );
    });
  });

  test("a recent but half-covered table alerts, naming both counts", async () => {
    // Half the measured population, expressed as a fraction so a re-anchor
    // moves it: `54_000` was half of the old 112,245 expectation and now sits
    // above the whole chain, which would make this assert nothing.
    const HALF = Math.round(VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS / 2);
    const { env } = fakeDb(NOW - HOUR, HALF, 112_250);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: never) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");
    assert.equal(result.covered_rows, HALF);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.errorCode, "stale_lane");
    const message = String(recorded[0]!.error?.message);
    // Distinct wording from the stalled case -- different place to go looking.
    assert.match(message, /truncated/);
    assert.match(message, new RegExp(`${HALF} hotkeys`));
    assert.match(message, /RECENT and PARTIAL/);
    assert.doesNotMatch(message, /nothing is refreshing/);
  });

  test("the env coverage-floor and pass-window overrides win over the defaults", async () => {
    const { env, binds } = fakeDb(NOW - HOUR, 100_000, 112_250);
    const raised = await runValidatorNominatorCountsStalenessWatchdog(
      {
        ...env,
        VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS: String(110_000),
        VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(raised.alerted, true);
    assert.equal(raised.reason, "partial");
    assert.equal(raised.coverage_floor_rows, 110_000);
    assert.deepEqual(binds[0], [HOUR]);

    // Lowered under the same reading, the identical tick is quiet. This is the
    // documented remedy if the hotkey population ever genuinely shrinks.
    const lowered = await runValidatorNominatorCountsStalenessWatchdog(
      {
        ...fakeDb(NOW - HOUR, 100_000, 112_250).env,
        VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS: String(80_000),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(lowered.alerted, false);
    assert.equal(lowered.coverage_floor_rows, 80_000);
  });

  test("an uncountable coverage number reads as ZERO, never as covered", async () => {
    // A NaN would compare false against the floor and report a truncated table
    // healthy -- the exact direction of failure this closes.
    const { env } = fakeDb(NOW - HOUR, null as unknown as number, 0);
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async () => true) as never,
    });
    assert.equal(result.covered_rows, 0);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");

    const junk = fakeDb(NOW - HOUR, "not a number" as unknown as number, 0);
    const nonNumeric = await runValidatorNominatorCountsStalenessWatchdog(
      { ...junk.env },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(nonNumeric.covered_rows, 0);
    assert.equal(nonNumeric.alerted, true);
  });

  test("a missing binding and a failing query degrade to summaries, never throw", async () => {
    assert.deepEqual(await runValidatorNominatorCountsStalenessWatchdog({}), {
      ok: false,
      reason: "no store bound",
    });
    assert.deepEqual(await runValidatorNominatorCountsStalenessWatchdog(null), {
      ok: false,
      reason: "no store bound",
    });

    const { env } = fakeDb(
      new Error('relation "validator_nominator_counts" does not exist'),
    );
    const failed = await runValidatorNominatorCountsStalenessWatchdog(env, {
      recordException: (async () => true) as never,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "query_failed");
    assert.match(String(failed.detail), /does not exist/);

    // A non-Error throw (a driver rejecting with a bare string) still yields
    // a readable detail rather than "[object Object]".
    const nonError = await runValidatorNominatorCountsStalenessWatchdog(
      fakeDb("socket hangup").env,
      { recordException: (async () => true) as never },
    );
    assert.equal(nonError.reason, "query_failed");
    assert.equal(nonError.detail, "socket hangup");
  });

  test("a null row and a telemetry failure never fail the tick", async () => {
    const empty = await runValidatorNominatorCountsStalenessWatchdog(
      noRowDb(),
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.reason, "no_rows");

    const { env } = fakeDb(NOW - 48 * HOUR);
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async () => {
        throw new Error("posthog down");
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });

  test("the real recordExceptionEvent default engages and no-ops unconfigured", async () => {
    // No telemetry env configured: the real recorder returns false without
    // touching the network, so the default path is exercisable in-process.
    const { env } = fakeDb(NOW - 48 * HOUR);
    const result = await runValidatorNominatorCountsStalenessWatchdog(env, {
      now: () => NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);

    // The default clock is the real one, so a stamp far in the past is stale
    // without injecting `now`.
    const past = fakeDb(0);
    const defaults = await runValidatorNominatorCountsStalenessWatchdog({
      ...past.env,
    });
    assert.equal(defaults.alerted, true);
  });
});

describe("the cron string is unique and wired", () => {
  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { env, queries } = fakeDb(Date.now());
    const result = (await runStalenessLane(
      "validator-nominator-counts-staleness",
      env as unknown as Parameters<typeof handleScheduled>[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    // Asserted by SHAPE rather than by count: the tick now also writes its verdict to
    // lane_health (#9330/#9340), so a bare `queries.length === 1` would have to be
    // bumped on every added statement and would stop saying anything about which
    // statement ran. Exactly one read of the lane, and it is the right read.
    const reads = queries.filter((q: string) =>
      q.includes("FROM validator_nominator_counts"),
    );
    assert.equal(reads.length, 1);
    assert.match(reads[0]!, /FROM validator_nominator_counts/);
    // The durable record is the whole point of the change: a healthy tick must be
    // recorded too, or "the watchdog stopped running" stays invisible.
    const writes = queries.filter((q: string) =>
      q.includes("INSERT INTO lane_health"),
    );
    assert.equal(writes.length, 1);
  });
});
