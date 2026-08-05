// The nominator-positions lane's alarm (#9273) and its cron wiring.
//
// The rule's edges are the point, and one of them is unusual: an EMPTY table
// alerts. That is the pre-cutover state -- until the revived sync lane posts,
// every /accounts/{ss58}/positions read is still answering from a frozen
// lakehouse export, which is exactly the condition that ran unnoticed for
// 34 hours and produced this issue.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
  NOMINATOR_POSITIONS_EXPECTED_COLDKEYS,
  NOMINATOR_POSITIONS_PASS_WINDOW_MS,
  NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
  evaluateNominatorPositionsStaleness,
  runNominatorPositionsStalenessWatchdog,
} from "../src/nominator-positions-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60_000;

/** A pass that covered the keyspace, so coverage is never the thing under test
 * unless a case says so. */
const FULL = NOMINATOR_POSITIONS_EXPECTED_COLDKEYS;

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
  over: Partial<Parameters<typeof evaluateNominatorPositionsStaleness>[0]> = {},
) {
  return {
    latestCapturedAtMs: NOW - 2 * HOUR,
    coveredColdkeys: FULL,
    totalColdkeys: FULL,
    nowMs: NOW,
    thresholdMs: NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
    coverageFloorColdkeys: NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
    ...over,
  };
}

describe("evaluateNominatorPositionsStaleness", () => {
  test("a recent pass is quiet; one past the threshold is a stall", () => {
    const fresh = evaluateNominatorPositionsStaleness(
      inputs({ latestCapturedAtMs: NOW - 2 * HOUR }),
    );
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, null);
    assert.equal(fresh.age_ms, 2 * HOUR);

    // 31h, not 7h: the threshold moved to 30h in #9301 once the lane had a
    // real producer on a 24h tick. A 7-hour-old capture is now a HEALTHY
    // mid-cycle reading -- see the constant's own header.
    const stalled = evaluateNominatorPositionsStaleness(
      inputs({ latestCapturedAtMs: NOW - 31 * HOUR }),
    );
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
    assert.equal(stalled.latest_captured_at, NOW - 31 * HOUR);
  });

  test("a capture from the middle of the producer's 24h cycle is quiet", () => {
    // The regression #9301 fixed: at the old 6h threshold this lane alerted
    // for roughly three quarters of every day while working perfectly.
    for (const hours of [7, 12, 20, 23]) {
      const verdict = evaluateNominatorPositionsStaleness(
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
    const verdict = evaluateNominatorPositionsStaleness(
      inputs({
        latestCapturedAtMs: NOW - NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
      }),
    );
    assert.equal(verdict.stale, false);
  });

  test("an empty table is a stall of infinite age, never a healthy quiet", () => {
    const verdict = evaluateNominatorPositionsStaleness(
      inputs({ latestCapturedAtMs: null }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
    assert.equal(verdict.latest_captured_at, null);
  });

  test("HALF THE COLDKEYS RECENTLY and ALL THE COLDKEYS RECENTLY are told apart", () => {
    // The acceptance criterion. Both ticks carry an identically fresh
    // MAX(captured_at); the ONLY difference is how far into the coldkey walk
    // the scan got, which is exactly what a timestamp cannot express.
    const half = evaluateNominatorPositionsStaleness(
      inputs({ coveredColdkeys: 11_800, totalColdkeys: FULL }),
    );
    assert.equal(
      half.stale,
      true,
      "a half-scanned keyspace must not read as ok",
    );
    assert.equal(half.reason, "partial");
    // Recent, not old -- caught WITHOUT any time passing.
    assert.equal(half.age_ms, 2 * HOUR);
    assert.ok(half.age_ms < half.threshold_ms);

    const whole = evaluateNominatorPositionsStaleness(inputs());
    assert.equal(whole.stale, false);
    assert.equal(whole.reason, null);
    assert.equal(whole.age_ms, half.age_ms);
  });

  test("the per-coldkey prune's stragglers do not count against coverage", () => {
    // Measured 2026-08-05: 23,668 coldkeys at the newest stamp plus 453 across
    // two older vintages, because a coldkey absent from a pass is left
    // untouched by design. A healthy tick must stay quiet with them present --
    // which is why the floor is absolute rather than a ratio of the table, a
    // ratio would read 98.1% here and drift down forever.
    const verdict = evaluateNominatorPositionsStaleness(
      inputs({ coveredColdkeys: 23_668, totalColdkeys: 24_121 }),
    );
    assert.equal(verdict.stale, false);
    assert.equal(verdict.reason, null);
  });

  test("a pass exactly at the floor is complete; one coldkey under is not", () => {
    // Strictly-less, matching the threshold edge, so a lane landing exactly on
    // the floor never flaps.
    const atFloor = evaluateNominatorPositionsStaleness(
      inputs({ coveredColdkeys: NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS }),
    );
    assert.equal(atFloor.stale, false);
    assert.equal(atFloor.reason, null);

    const under = evaluateNominatorPositionsStaleness(
      inputs({
        coveredColdkeys: NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS - 1,
      }),
    );
    assert.equal(under.stale, true);
    assert.equal(under.reason, "partial");
  });

  test("a stalled lane reports `stale`, not `partial`, even when also short", () => {
    // If a whole 24h pass has been missed, "the producer stopped" is the
    // headline and the coverage of its last attempt is a detail.
    const verdict = evaluateNominatorPositionsStaleness(
      inputs({ latestCapturedAtMs: NOW - 34 * HOUR, coveredColdkeys: 11_800 }),
    );
    assert.equal(verdict.reason, "stale");
  });
});

describe("runNominatorPositionsStalenessWatchdog", () => {
  test("a fresh lane reports quiet and records nothing", async () => {
    const { db, queries } = fakeDb(NOW - HOUR);
    const recorded: unknown[] = [];
    const result = await runNominatorPositionsStalenessWatchdog(
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
    assert.match(queries[0]!, /FROM nominator_positions/);
    // The coverage half has to be IN the read, or the rule is being handed a
    // number nothing measured. DISTINCT coldkey, not COUNT(*) -- rows would
    // hide a scan that died after the largest delegators.
    assert.match(queries[0]!, /COUNT\(DISTINCT coldkey\) AS total/);
    assert.match(queries[0]!, /THEN coldkey END\) AS covered/);
  });

  test("the read counts only the newest pass, bounded by the pass window", () => {
    // A window spanning the 24h poll interval would merge two consecutive
    // passes into one coverage count, so a truncated pass landing on a complete
    // one would report full coverage -- the bug, restored.
    const { db, queries, binds } = fakeDb(NOW - HOUR);
    return runNominatorPositionsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: (async () => true) as never },
    ).then(() => {
      assert.deepEqual(binds[0], [NOMINATOR_POSITIONS_PASS_WINDOW_MS]);
      assert.ok(
        NOMINATOR_POSITIONS_PASS_WINDOW_MS < 24 * HOUR,
        "the window must stay under VALIDATOR_NOMINATORS_POLL_SECS (24h)",
      );
      // Counted against the newest stamp, not against `now` -- a lane that is
      // merely late must not also read as uncovered.
      assert.match(
        queries[0]!,
        /captured_at >= \(SELECT MAX\(captured_at\) FROM nominator_positions\) - \?/,
      );
    });
  });

  test("a recent but half-scanned keyspace alerts, naming both counts", async () => {
    const { db } = fakeDb(NOW - HOUR, 11_800, 24_121);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runNominatorPositionsStalenessWatchdog(
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
    assert.equal(result.covered_coldkeys, 11_800);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.errorCode, "stale_lane");
    const message = String(recorded[0]!.error?.message);
    // Distinct wording from the stalled case -- different place to go looking.
    assert.match(message, /truncated/);
    assert.match(message, /11800 of 24121 coldkeys/);
    assert.match(message, /RECENT and PARTIAL/);
    assert.doesNotMatch(message, /nothing is refreshing/);
  });

  test("the env coverage-floor and pass-window overrides win over the defaults", async () => {
    const { db, binds } = fakeDb(NOW - HOUR, 20_000, 24_121);
    const raised = await runNominatorPositionsStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
        NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS: String(22_000),
        NOMINATOR_POSITIONS_PASS_WINDOW_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(raised.alerted, true);
    assert.equal(raised.reason, "partial");
    assert.equal(raised.coverage_floor_coldkeys, 22_000);
    assert.deepEqual(binds[0], [HOUR]);

    // Lowered under the same reading, the identical tick is quiet. This is the
    // documented remedy if the delegating population ever genuinely shrinks.
    const lowered = await runNominatorPositionsStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: fakeDb(NOW - HOUR, 20_000, 24_121).db,
        NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS: String(15_000),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(lowered.alerted, false);
    assert.equal(lowered.coverage_floor_coldkeys, 15_000);
  });

  test("an uncountable coverage number reads as ZERO, never as covered", async () => {
    // A NaN would compare false against the floor and report a half-scanned
    // keyspace healthy -- the exact direction of failure this closes.
    const { db } = fakeDb(NOW - HOUR, null as unknown as number, 0);
    const result = await runNominatorPositionsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.covered_coldkeys, 0);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");

    const junk = fakeDb(NOW - HOUR, "not a number" as unknown as number, 0);
    const nonNumeric = await runNominatorPositionsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: junk.db },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(nonNumeric.covered_coldkeys, 0);
    assert.equal(nonNumeric.alerted, true);
  });

  test("a stalled lane records ONE exception naming the age and the route it breaks", async () => {
    const { db } = fakeDb(NOW - 34 * HOUR);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runNominatorPositionsStalenessWatchdog(
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
    assert.equal(recorded[0]!.route, "watchdog:nominator-positions-staleness");
    assert.equal(recorded[0]!.errorCode, "stale_lane");
    assert.match(String(recorded[0]!.error?.message), /34\.0 h old/);
    assert.match(String(recorded[0]!.error?.message), /threshold 30 h/);
    assert.match(String(recorded[0]!.error?.message), /positions/);
  });

  test("an empty table alerts with the no-rows wording", async () => {
    const { db } = fakeDb(null);
    const recorded: { error?: Error }[] = [];
    const result = await runNominatorPositionsStalenessWatchdog(
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
    const result = await runNominatorPositionsStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
        NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, HOUR);
  });

  test("a missing binding and a failing query degrade to summaries, never throw", async () => {
    assert.deepEqual(await runNominatorPositionsStalenessWatchdog({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runNominatorPositionsStalenessWatchdog(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });

    const { db } = fakeDb(
      new Error("D1_ERROR: no such table: nominator_positions"),
    );
    const failed = await runNominatorPositionsStalenessWatchdog(
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
    const nonError = await runNominatorPositionsStalenessWatchdog(
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
    const empty = await runNominatorPositionsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: nullRow },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.reason, "no_rows");

    const { db } = fakeDb(NOW - 48 * HOUR);
    const result = await runNominatorPositionsStalenessWatchdog(
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
    const result = await runNominatorPositionsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);

    // The default clock is the real one, so a stamp far in the past is stale
    // without injecting `now`.
    const past = fakeDb(0);
    const defaults = await runNominatorPositionsStalenessWatchdog({
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
    const mine = workerConfig.NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON;
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
        workerConfig.NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON,
      ),
    );
  });

  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { db, queries } = fakeDb(Date.now());
    const result = (await handleScheduled(
      {
        cron: workerConfig.NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON,
      } as unknown as ScheduledController,
      { METAGRAPH_HEALTH_DB: db } as unknown as Parameters<
        typeof handleScheduled
      >[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    // Asserted by SHAPE rather than by count: the tick now also writes its verdict to
    // lane_health (#9330/#9340), so a bare `queries.length === 1` would have to be
    // bumped on every added statement and would stop saying anything about which
    // statement ran. Exactly one read of the lane, and it is the right read.
    const reads = queries.filter((q: string) =>
      q.includes("FROM nominator_positions"),
    );
    assert.equal(reads.length, 1);
    assert.match(reads[0]!, /FROM nominator_positions/);
    // The durable record is the whole point of the change: a healthy tick must be
    // recorded too, or "the watchdog stopped running" stays invisible.
    const writes = queries.filter((q: string) =>
      q.includes("INSERT INTO lane_health"),
    );
    assert.equal(writes.length, 1);
  });
});
