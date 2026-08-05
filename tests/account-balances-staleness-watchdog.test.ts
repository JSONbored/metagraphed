// The account-balances lane's alarm (#9478) and its cron wiring.
//
// The rule's edges are the point, and one of them is unusual: an EMPTY table
// alerts. That is the pre-cutover state -- until the revived sync lane posts,
// every /api/v1/accounts/top-holders read is still answering from the frozen
// 2026-08-02 materialization, which is exactly the condition that ran unnoticed
// and produced this issue.
//
// The threshold's own edge matters more here than on the sibling lanes: this
// producer ticks every six hours, so a five-hour-old capture is a HEALTHY
// mid-cycle reading and must stay quiet. #9301 had to correct precisely that
// mistake on the nominator-positions watchdog after a threshold was set tighter
// than its producer's cadence.
//
// The COVERAGE half (#9530) is the one edge that is not about time at all, and
// the whole discrimination it has to make is between two ticks that a
// timestamp cannot tell apart: half a network written recently, and a whole
// network written recently. The production reading it was built from --
// 147,000 rows at one 36-minute-old stamp, reported `ok` -- is asserted below
// verbatim, because a rule that gets every synthetic case right and that one
// wrong is the rule this file already had.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS,
  ACCOUNT_BALANCES_EXPECTED_ACCOUNTS,
  ACCOUNT_BALANCES_PASS_WINDOW_MS,
  ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS,
  evaluateAccountBalancesStaleness,
  runAccountBalancesStalenessWatchdog,
} from "../src/account-balances-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60_000;
/** A pass that covered the network, so `covered` is never the thing under test
 * unless a case says so. */
const FULL = ACCOUNT_BALANCES_EXPECTED_ACCOUNTS;

function fakeDb(
  latest: number | null | Error,
  covered: number = FULL,
  total: number = FULL,
) {
  const queries: string[] = [];
  const binds: unknown[][] = [];
  return {
    queries,
    binds,
    db: {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind(...values: unknown[]) {
            binds.push(values);
            return {
              async first() {
                if (latest instanceof Error) throw latest;
                return { latest, covered, total };
              },
            };
          },
        };
      },
    },
  };
}

/** The rule's inputs with everything healthy, so each case overrides only the
 * one field it is about. */
function inputs(
  over: Partial<Parameters<typeof evaluateAccountBalancesStaleness>[0]> = {},
) {
  return {
    latestCapturedAtMs: NOW - HOUR,
    coveredRows: FULL,
    totalRows: FULL,
    nowMs: NOW,
    thresholdMs: ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS,
    coverageFloorRows: ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS,
    ...over,
  };
}

describe("evaluateAccountBalancesStaleness", () => {
  test("a recent pass is quiet; one past the threshold is a stall", () => {
    const fresh = evaluateAccountBalancesStaleness(
      inputs({ latestCapturedAtMs: NOW - 2 * HOUR }),
    );
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, null);
    assert.equal(fresh.age_ms, 2 * HOUR);

    const stalled = evaluateAccountBalancesStaleness(
      inputs({ latestCapturedAtMs: NOW - 13 * HOUR }),
    );
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
    assert.equal(stalled.latest_captured_at, NOW - 13 * HOUR);
  });

  test("a capture from the middle of the producer's 6h cycle is quiet", () => {
    // ACCOUNT_BALANCES_POLL_SECS defaults to six hours, and the System::Account
    // walk plus its ~22 POSTs sit on top of that -- so a healthy lane's age
    // swings across this whole range and none of it may alert.
    for (const hours of [1, 3, 5, 6, 7]) {
      const verdict = evaluateAccountBalancesStaleness(
        inputs({ latestCapturedAtMs: NOW - hours * HOUR }),
      );
      assert.equal(
        verdict.stale,
        false,
        `${hours}h into a 6h cycle must not alert`,
      );
    }
  });

  test("exactly at the threshold is not yet a stall", () => {
    // Strictly-greater, so a lane running exactly on cadence never flaps.
    const verdict = evaluateAccountBalancesStaleness(
      inputs({
        latestCapturedAtMs: NOW - ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS,
      }),
    );
    assert.equal(verdict.stale, false);
  });

  test("an empty table is a stall of infinite age, never a healthy quiet", () => {
    const verdict = evaluateAccountBalancesStaleness(
      inputs({ latestCapturedAtMs: null, coveredRows: 0, totalRows: 0 }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
    assert.equal(verdict.latest_captured_at, null);
  });

  test("HALF A NETWORK RECENTLY and A WHOLE NETWORK RECENTLY are told apart", () => {
    // The acceptance criterion, and the only assertion in this file that fails
    // against the pre-#9530 rule. Both ticks below carry an identically fresh
    // MAX(captured_at); the ONLY difference is how many accounts the pass
    // reached, which is exactly what a timestamp cannot express.
    const half = evaluateAccountBalancesStaleness(
      inputs({ coveredRows: 147_000, totalRows: 147_000 }),
    );
    assert.equal(half.stale, true, "a half-covered pass must not read as ok");
    assert.equal(half.reason, "partial");
    // Recent, not old -- the point being that it is caught WITHOUT time passing.
    assert.equal(half.age_ms, HOUR);

    const whole = evaluateAccountBalancesStaleness(inputs());
    assert.equal(whole.stale, false);
    assert.equal(whole.reason, null);
    assert.equal(whole.age_ms, half.age_ms);
  });

  test("the production reading of 2026-08-05 06:04Z alerts", () => {
    // Verbatim: 147,000 rows sharing one captured_at stamped 05:27:16.083Z,
    // read at 06:04:48Z. lane_health said `ok | age=0.6h`.
    const capturedAt = Date.parse("2026-08-05T05:27:16.083Z");
    const checkedAt = Date.parse("2026-08-05T06:04:48.000Z");
    const verdict = evaluateAccountBalancesStaleness(
      inputs({
        latestCapturedAtMs: capturedAt,
        coveredRows: 147_000,
        totalRows: 147_000,
        nowMs: checkedAt,
      }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "partial");
    // The freshness half was never wrong -- it was answering a different
    // question. Assert that it still reads as fresh, so the fix is provably
    // coverage and not a quietly tightened threshold.
    assert.ok(verdict.age_ms !== null && verdict.age_ms < HOUR);
    assert.ok(verdict.age_ms < verdict.threshold_ms);
  });

  test("a pass exactly at the floor is complete; one row under is not", () => {
    // Strictly-less, matching the threshold edge above, so a lane landing
    // exactly on the floor never flaps.
    const atFloor = evaluateAccountBalancesStaleness(
      inputs({ coveredRows: ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS }),
    );
    assert.equal(atFloor.stale, false);
    assert.equal(atFloor.reason, null);

    const under = evaluateAccountBalancesStaleness(
      inputs({ coveredRows: ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS - 1 }),
    );
    assert.equal(under.stale, true);
    assert.equal(under.reason, "partial");
  });

  test("a truncated pass on top of a FULL table is caught too", () => {
    // The steady-state failure a whole-table COUNT(*) floor is blind to: this
    // writer never prunes, so a pass that dies at 48% leaves the table at its
    // full size with half its rows a vintage old. `total` reads healthy;
    // `covered` is what fires.
    const verdict = evaluateAccountBalancesStaleness(
      inputs({ coveredRows: 147_000, totalRows: FULL }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "partial");
    assert.equal(verdict.total_rows, FULL, "the table itself is not short");
  });

  test("a stalled lane reports `stale`, not `partial`, even when also short", () => {
    // Order matters for the operator on the other end: if nothing has run in
    // 20 hours, "the producer stopped" is the headline and the coverage of its
    // last attempt is a detail.
    const verdict = evaluateAccountBalancesStaleness(
      inputs({ latestCapturedAtMs: NOW - 20 * HOUR, coveredRows: 147_000 }),
    );
    assert.equal(verdict.reason, "stale");
  });
});

describe("runAccountBalancesStalenessWatchdog", () => {
  test("a fresh lane reports quiet and records nothing", async () => {
    const { db, queries } = fakeDb(NOW - HOUR);
    const recorded: unknown[] = [];
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: never, event: unknown) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.deepEqual(recorded, []);
    assert.match(queries[0]!, /MAX\(captured_at\)/);
    assert.match(queries[0]!, /FROM account_balances/);
    // The coverage half has to be IN the read, or the rule is being handed a
    // number nothing measured.
    assert.match(queries[0]!, /AS covered/);
  });

  test("the read counts only the newest pass, bounded by the pass window", () => {
    // A window that spanned the 6h poll interval would sum two consecutive
    // passes into one coverage count, so a truncated pass landing on a
    // complete one would report full coverage -- the bug, restored.
    const { db, queries, binds } = fakeDb(NOW - HOUR);
    return runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: (async () => true) as never },
    ).then(() => {
      assert.deepEqual(binds[0], [ACCOUNT_BALANCES_PASS_WINDOW_MS]);
      assert.ok(
        ACCOUNT_BALANCES_PASS_WINDOW_MS < 6 * HOUR,
        "the window must stay under ACCOUNT_BALANCES_POLL_SECS (21600)",
      );
      // Counted against the newest stamp, not against `now` -- a lane that is
      // merely late must not also read as uncovered.
      assert.match(
        queries[0]!,
        /captured_at >= \(SELECT MAX\(captured_at\) FROM account_balances\) - \?/,
      );
    });
  });

  test("a recent but half-covered table alerts, naming both counts", async () => {
    const { db } = fakeDb(NOW - HOUR, 147_000, 147_000);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: never, event: never) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");
    assert.equal(result.covered_rows, 147_000);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.errorCode, "stale_lane");
    const message = String(recorded[0]!.error?.message);
    // The wording has to separate itself from the stalled case -- an operator
    // reading this in PostHog goes to a different place for each.
    assert.match(message, /truncated/);
    assert.match(message, /147000/);
    assert.match(message, /RECENT and PARTIAL/);
    assert.doesNotMatch(message, /nothing is refreshing/);
  });

  test("a stalled lane records ONE exception naming the age and the route it breaks", async () => {
    const { db } = fakeDb(NOW - 20 * HOUR);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: never, event: never) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    assert.equal(result.alerted, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.route, "watchdog:account-balances-staleness");
    assert.equal(recorded[0]!.errorCode, "stale_lane");
    assert.match(String(recorded[0]!.error?.message), /20\.0 h old/);
    assert.match(String(recorded[0]!.error?.message), /threshold 12 h/);
    assert.match(String(recorded[0]!.error?.message), /top-holders/);
  });

  test("an empty table alerts with the no-rows wording", async () => {
    const { db } = fakeDb(null);
    const recorded: { error?: Error }[] = [];
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: never, event: never) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "no_rows");
    assert.match(String(recorded[0]!.error?.message), /no rows at all/);
  });

  test("the env threshold override wins over the default", async () => {
    const { db } = fakeDb(NOW - 2 * HOUR);
    const result = await runAccountBalancesStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
        ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, HOUR);
  });

  test("the env coverage-floor and pass-window overrides win over the defaults", async () => {
    // Both exist so the numbers can follow the producer's real cadence and the
    // network's real size without a code deploy -- the same reason the
    // threshold above is overridable.
    const { db, binds } = fakeDb(NOW - HOUR, 200_000, 200_000);
    const raised = await runAccountBalancesStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
        ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS: String(500_000),
        ACCOUNT_BALANCES_PASS_WINDOW_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(raised.alerted, true);
    assert.equal(raised.reason, "partial");
    assert.equal(raised.coverage_floor_rows, 500_000);
    assert.deepEqual(binds[0], [HOUR]);

    // Lowered under the same reading, the identical tick is quiet.
    const lowered = await runAccountBalancesStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: fakeDb(NOW - HOUR, 200_000, 200_000).db,
        ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS: String(100_000),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(lowered.alerted, false);
    assert.equal(lowered.coverage_floor_rows, 100_000);
  });

  test("an uncountable coverage number reads as ZERO, never as covered", async () => {
    // A null SUM over no rows, or a shim handing back something non-numeric,
    // must not become a NaN: NaN compares false against the floor, which would
    // report a truncated table healthy -- the exact direction of failure this
    // change exists to remove.
    const { db } = fakeDb(NOW - HOUR, null as unknown as number, 0);
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.covered_rows, 0);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");

    const junk = fakeDb(NOW - HOUR, "not a number" as unknown as number, 0);
    const nonNumeric = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: junk.db },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(nonNumeric.covered_rows, 0);
    assert.equal(nonNumeric.alerted, true);
  });

  test("a missing binding and a failing query degrade to summaries, never throw", async () => {
    assert.deepEqual(await runAccountBalancesStalenessWatchdog({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runAccountBalancesStalenessWatchdog(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });

    const { db } = fakeDb(
      new Error("D1_ERROR: no such table: account_balances"),
    );
    const failed = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { recordException: (async () => true) as never },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "query_failed");
    assert.match(String(failed.detail), /no such table/);

    // A non-Error throw (D1 shims have thrown plain objects before) still
    // yields a readable detail.
    const stringThrow = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw "socket hangup";
          },
        }),
      }),
    };
    const nonError = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: stringThrow },
      { recordException: (async () => true) as never },
    );
    assert.equal(nonError.reason, "query_failed");
    assert.equal(nonError.detail, "socket hangup");
  });

  test("a null row and a telemetry failure never fail the tick", async () => {
    const nullRow = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    const empty = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: nullRow },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.reason, "no_rows");

    const { db } = fakeDb(NOW - 48 * HOUR);
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async () => {
          throw new Error("posthog down");
        }) as never,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });

  test("the real recordExceptionEvent default engages and no-ops unconfigured", async () => {
    // No telemetry env configured: the real recorder returns false without
    // touching the network, so the default path is exercisable in-process.
    const { db } = fakeDb(NOW - 48 * HOUR);
    const result = await runAccountBalancesStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);

    // The default clock is the real one, so a stamp far in the past is stale
    // without injecting `now`.
    const past = fakeDb(0);
    const defaults = await runAccountBalancesStalenessWatchdog({
      METAGRAPH_HEALTH_DB: past.db,
    });
    assert.equal(defaults.alerted, true);
  });
});

describe("the cron string is unique and wired", () => {
  test("no other cron in workers/config.ts shares the literal string", () => {
    // Dispatch keys on the LITERAL cron string, so a duplicate silently routes
    // this lane into another branch entirely.
    const crons = Object.entries(workerConfig)
      .filter(([key]) => key.endsWith("_CRON"))
      .map(([, value]) => value);
    const mine = workerConfig.ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON;
    assert.equal(
      crons.filter((cron) => cron === mine).length,
      1,
      `${mine} is declared by more than one lane`,
    );
  });

  test("wrangler.jsonc declares the trigger", () => {
    // A cron the Worker dispatches on but wrangler never fires is dead code --
    // and the failure is silent, since the branch simply never runs.
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    )
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(raw) as { triggers?: { crons?: string[] } };
    assert.ok(
      parsed.triggers?.crons?.includes(
        workerConfig.ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON,
      ),
    );
  });

  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { db, queries } = fakeDb(Date.now());
    const result = (await handleScheduled(
      {
        cron: workerConfig.ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON,
      } as unknown as ScheduledController,
      { METAGRAPH_HEALTH_DB: db } as unknown as Parameters<
        typeof handleScheduled
      >[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    // Asserted by SHAPE rather than by count: the tick also writes its verdict to
    // lane_health (#9330/#9340), so a bare `queries.length === 1` would have to be
    // bumped on every added statement and would stop saying anything about which
    // statement ran. Exactly one read of the lane, and it is the right read.
    const reads = queries.filter((q: string) =>
      q.includes("FROM account_balances"),
    );
    assert.equal(reads.length, 1);
    assert.match(reads[0]!, /FROM account_balances/);
    // The durable record is the whole point of the change: a healthy tick must be
    // recorded too, or "the watchdog stopped running" stays invisible.
    const writes = queries.filter((q: string) =>
      q.includes("INSERT INTO lane_health"),
    );
    assert.equal(writes.length, 1);
  });
});
