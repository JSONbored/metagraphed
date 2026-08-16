// The neurons live lane's alarm (src/neurons-staleness-watchdog.ts) and its
// cron wiring. The rule's edges are the point: one restarted container is a
// missed tick by design and must NOT alert; three missed ticks is a stall and
// MUST; and an empty table is a stall of infinite age, never a healthy quiet.
//
// The COVERAGE edge is not about time at all, and its unit is NETUIDS rather
// than rows: the writer prunes per-netuid, so a scan that dies partway through
// the netuid walk leaves the subnets it never reached completely untouched,
// behind a MAX(captured_at) that just advanced. Rows would hide that -- subnets
// run 64 to 256 UIDs, so a scan that died after the largest ones could show
// high row coverage having missed half the network.
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
  NEURONS_BUFFER_LANE,
  NEURONS_COVERAGE_FLOOR_NETUIDS,
  NEURONS_EXPECTED_NETUIDS,
  NEURONS_PASS_WINDOW_MS,
  NEURONS_STALENESS_THRESHOLD_MS,
  evaluateNeuronsStaleness,
  neuronsStalenessThresholdMs,
  runNeuronsStalenessWatchdog,
} from "../src/neurons-staleness-watchdog.ts";
import { FLUSH_INTERVAL_MS } from "../src/neon-write-buffer.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";
import { runStalenessLane } from "./helpers/staleness-lane.ts";

const NOW = 1_785_800_000_000;
/** A pass that covered the network, so coverage is never the thing under test
 * unless a case says so. */
const FULL = NEURONS_EXPECTED_NETUIDS;

/** The lane's one read, answered from the pg double, plus the env that points
 * the watchdog at it.
 *
 * `queries` and `binds` are LIVE views over the mock's log rather than copies,
 * because every caller destructures them and reads them after the tick has run
 * -- a getter would be evaluated once, at destructure time, and freeze empty.
 *
 * An `Error` for `latest` fails the NEXT statement, which is the read: the
 * watchdog catches it and never reaches the lane_health write, exactly as a
 * throwing store did. */
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
  // Cast rather than typed: a non-Error throw is one of the cases under test
  // below, and the mock rethrows whatever it is handed.
  pg.control.failNext = throws ? (latest as Error) : null;
  pg.control.onQuery = (q) => {
    queries.push(q.text);
    binds.push(q.values);
  };
  return { queries, binds, env: pgMockEnv() };
}

/** The rule's inputs with everything healthy, so each case overrides only the
 * one field it is about. */
function inputs(
  over: Partial<Parameters<typeof evaluateNeuronsStaleness>[0]> = {},
) {
  return {
    latestCapturedAtMs: NOW - 5 * 60_000,
    coveredNetuids: FULL,
    totalNetuids: FULL,
    nowMs: NOW,
    thresholdMs: NEURONS_STALENESS_THRESHOLD_MS,
    coverageFloorNetuids: NEURONS_COVERAGE_FLOOR_NETUIDS,
    ...over,
  };
}

describe("evaluateNeuronsStaleness", () => {
  test("one missed tick is quiet, three is a stall", () => {
    const oneTick = evaluateNeuronsStaleness(
      inputs({ latestCapturedAtMs: NOW - 20 * 60_000 }),
    );
    assert.equal(oneTick.stale, false);
    assert.equal(oneTick.reason, null);
    assert.equal(oneTick.age_ms, 20 * 60_000);

    const stalled = evaluateNeuronsStaleness(
      inputs({ latestCapturedAtMs: NOW - 46 * 60_000 }),
    );
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
  });

  test("an empty table is a stall of infinite age", () => {
    const verdict = evaluateNeuronsStaleness(
      inputs({ latestCapturedAtMs: null, coveredNetuids: 0, totalNetuids: 0 }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
  });

  test("HALF THE SUBNETS RECENTLY and ALL THE SUBNETS RECENTLY are told apart", () => {
    // The acceptance criterion. Both ticks carry an identically fresh
    // MAX(captured_at); the ONLY difference is how far into the netuid walk the
    // scan got, which is exactly what a timestamp cannot express.
    const half = evaluateNeuronsStaleness(
      inputs({ coveredNetuids: 64, totalNetuids: FULL }),
    );
    assert.equal(
      half.stale,
      true,
      "a half-scanned network must not read as ok",
    );
    assert.equal(half.reason, "partial");
    // Recent, not old -- caught WITHOUT any time passing.
    assert.equal(half.age_ms, 5 * 60_000);
    assert.ok(half.age_ms < half.threshold_ms);

    const whole = evaluateNeuronsStaleness(inputs());
    assert.equal(whole.stale, false);
    assert.equal(whole.reason, null);
    assert.equal(whole.age_ms, half.age_ms);
  });

  test("a scan that died at netuid 40 alerts, though every row it wrote is fresh", () => {
    // The concrete mechanism: the per-netuid prune touches only the netuids in
    // the payload, so 89 subnets keep a pass-old metagraph while MAX() advances.
    const verdict = evaluateNeuronsStaleness(
      inputs({ coveredNetuids: 40, totalNetuids: 129 }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "partial");
    assert.equal(
      verdict.total_netuids,
      129,
      "the table still knows 129 subnets",
    );
  });

  test("a pass exactly at the floor is complete; one subnet under is not", () => {
    // Strictly-less, matching the threshold edge, so a lane landing exactly on
    // the floor never flaps.
    const atFloor = evaluateNeuronsStaleness(
      inputs({ coveredNetuids: NEURONS_COVERAGE_FLOOR_NETUIDS }),
    );
    assert.equal(atFloor.stale, false);
    assert.equal(atFloor.reason, null);

    const under = evaluateNeuronsStaleness(
      inputs({ coveredNetuids: NEURONS_COVERAGE_FLOOR_NETUIDS - 1 }),
    );
    assert.equal(under.stale, true);
    assert.equal(under.reason, "partial");
  });

  test("the floor only loosens as the network grows, never tightens", () => {
    // Sized as a RATIO of a measured count rather than pinned to it, so new
    // subnets registering can never turn a working lane into an alerting one.
    // At 129 subnets the floor is ~80%; at 200 it is the same absolute number,
    // which is slacker still.
    assert.ok(NEURONS_COVERAGE_FLOOR_NETUIDS < NEURONS_EXPECTED_NETUIDS);
    const grown = evaluateNeuronsStaleness(
      inputs({ coveredNetuids: 200, totalNetuids: 200 }),
    );
    assert.equal(grown.stale, false);
  });

  test("a stalled lane reports `stale`, not `partial`, even when also short", () => {
    // If the Container has missed three ticks, "it stopped" is the headline and
    // the coverage of its last attempt is a detail.
    const verdict = evaluateNeuronsStaleness(
      inputs({ latestCapturedAtMs: NOW - 3 * 60 * 60_000, coveredNetuids: 40 }),
    );
    assert.equal(verdict.reason, "stale");
  });
});

describe("runNeuronsStalenessWatchdog", () => {
  test("a fresh lane reports quiet and records nothing", async () => {
    const { env } = fakeDb(NOW - 5 * 60_000);
    const recorded: unknown[] = [];
    const result = await runNeuronsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: unknown) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.deepEqual(recorded, []);
  });

  test("the read counts subnets at the newest stamp, bounded by the pass window", () => {
    // A window at or over the 15-minute tick would merge two passes into one
    // coverage count, letting a half-scanned pass on top of a complete one
    // report full coverage -- the bug this closes.
    const { env, queries, binds } = fakeDb(NOW - 5 * 60_000);
    return runNeuronsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async () => true) as never,
    }).then(() => {
      assert.deepEqual(binds[0], [NEURONS_PASS_WINDOW_MS]);
      assert.ok(
        NEURONS_PASS_WINDOW_MS < 15 * 60_000,
        "the window must stay under the poller's 15-minute tick",
      );
      // DISTINCT netuid, not COUNT(*) -- rows would hide a scan that died after
      // the largest subnets.
      assert.match(queries[0], /COUNT\(DISTINCT netuid\) AS total/);
      assert.match(queries[0], /THEN netuid END\) AS covered/);
      // `$n`, not `?`: the watchdog writes SQLite's placeholder and
      // toPositionalPlaceholders rewrites it on the way to Postgres. #9821 is
      // what happens when it does not -- six routes served zero rows because a
      // `?` reached Postgres unrewritten and matched nothing.
      assert.match(
        queries[0],
        /captured_at >= \(SELECT MAX\(captured_at\) FROM neurons\) - \$\d/,
      );
    });
  });

  test("a recent but half-scanned network alerts, naming both counts", async () => {
    const { env } = fakeDb(NOW - 5 * 60_000, 64, 129);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runNeuronsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: never) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");
    assert.equal(result.covered_netuids, 64);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].errorCode, "stale_lane");
    const message = String(recorded[0].error?.message);
    // Distinct wording from the stalled case -- different place to go looking.
    assert.match(message, /truncated/);
    assert.match(message, /64 of 129 subnets/);
    assert.match(message, /RECENT and PARTIAL/);
    assert.doesNotMatch(message, /missed at least three ticks/);
  });

  test("the env coverage-floor and pass-window overrides win over the defaults", async () => {
    const { env, binds } = fakeDb(NOW - 5 * 60_000, 110, 129);
    const raised = await runNeuronsStalenessWatchdog(
      {
        ...env,
        NEURONS_COVERAGE_FLOOR_NETUIDS: "120",
        NEURONS_PASS_WINDOW_MS: "60000",
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(raised.alerted, true);
    assert.equal(raised.reason, "partial");
    assert.equal(raised.coverage_floor_netuids, 120);
    assert.deepEqual(binds[0], [60_000]);

    // Lowered under the same reading, the identical tick is quiet.
    const lowered = await runNeuronsStalenessWatchdog(
      {
        ...fakeDb(NOW - 5 * 60_000, 110, 129).env,
        NEURONS_COVERAGE_FLOOR_NETUIDS: "100",
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(lowered.alerted, false);
    assert.equal(lowered.coverage_floor_netuids, 100);
  });

  test("an uncountable coverage number reads as ZERO, never as covered", async () => {
    // A NaN would compare false against the floor and report a half-scanned
    // network healthy -- the exact direction of failure this closes.
    const { env } = fakeDb(NOW - 5 * 60_000, null as unknown as number, 0);
    const result = await runNeuronsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async () => true) as never,
    });
    assert.equal(result.covered_netuids, 0);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");

    const junk = fakeDb(
      NOW - 5 * 60_000,
      "not a number" as unknown as number,
      0,
    );
    const nonNumeric = await runNeuronsStalenessWatchdog(
      { ...junk.env },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(nonNumeric.covered_netuids, 0);
    assert.equal(nonNumeric.alerted, true);
  });

  test("a stalled lane records ONE exception naming the age and threshold", async () => {
    const { env } = fakeDb(NOW - 3 * 60 * 60_000);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runNeuronsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: never) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.alerted, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].route, "watchdog:neurons-staleness");
    assert.equal(recorded[0].errorCode, "stale_lane");
    assert.match(String(recorded[0].error?.message), /180\.0 min old/);
    assert.match(String(recorded[0].error?.message), /threshold 45 min/);
  });

  test("an empty table alerts with the no-rows wording", async () => {
    const { env } = fakeDb(null);
    const recorded: { error?: Error }[] = [];
    const result = await runNeuronsStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async (_env: never, event: never) => {
        recorded.push(event);
        return true;
      }) as never,
    });
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "no_rows");
    assert.match(String(recorded[0].error?.message), /no rows at all/);
  });

  test("the env threshold override wins over the default", async () => {
    const { env } = fakeDb(NOW - 10 * 60_000);
    const result = await runNeuronsStalenessWatchdog(
      { ...env, NEURONS_STALENESS_THRESHOLD_MS: "300000" },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, 300_000);
  });

  test("a missing binding and a failing query degrade to summaries, never throws", async () => {
    assert.deepEqual(await runNeuronsStalenessWatchdog({}), {
      ok: false,
      reason: "no store bound",
    });
    assert.deepEqual(await runNeuronsStalenessWatchdog(null), {
      ok: false,
      reason: "no store bound",
    });
    const { env } = fakeDb(new Error('relation "neurons" does not exist'));
    const result = await runNeuronsStalenessWatchdog(env, {
      recordException: (async () => true) as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.match(String(result.detail), /does not exist/);

    // A non-Error throw (a driver rejecting with a bare string) still yields a
    // readable detail rather than "[object Object]".
    const nonError = await runNeuronsStalenessWatchdog(
      fakeDb("socket hangup").env,
      { recordException: (async () => true) as never },
    );
    assert.equal(nonError.reason, "query_failed");
    assert.equal(nonError.detail, "socket hangup");
  });

  test("a telemetry failure never fails the tick", async () => {
    const { env } = fakeDb(NOW - 2 * 60 * 60_000);
    const result = await runNeuronsStalenessWatchdog(env, {
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
    const { env } = fakeDb(NOW - 2 * 60 * 60_000);
    const result = await runNeuronsStalenessWatchdog(env, { now: () => NOW });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });
});

describe("the neurons lane, reached through the watchdog registry", () => {
  test("dispatches to the watchdog and returns its summary", async () => {
    const { env, queries } = fakeDb(Date.now());
    const result = (await runStalenessLane(
      "neurons-staleness",
      env as unknown as Parameters<typeof handleScheduled>[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    // Asserted by SHAPE rather than by count: the tick now also writes its verdict to
    // lane_health (#9330/#9340), so a bare `queries.length === 1` would have to be
    // bumped on every added statement and would stop saying anything about which
    // statement ran. Exactly one read of the lane, and it is the right read.
    //
    // TWO reads of `neurons` now, not one: #10262 folded the subnet-lifecycle
    // detection into this same tick, and it reads the netuid set from the same
    // newest pass. So the watchdog's own read is identified by SHAPE (`AS
    // covered` is unique to it) rather than by being the only one -- keeping
    // the original intent without making an unrelated lane's query a failure.
    //
    // That this asserted 1 and PASSED is exactly how #10265 hid: subnet_lifecycle
    // was in no NEON_SOLE_STORE_TABLES list, so readStore answered undefined and
    // the lifecycle lane returned before issuing a single statement. Declaring
    // the table is what makes the second read appear.
    const reads = queries.filter((q: string) => q.includes("FROM neurons"));
    assert.equal(reads.length, 2);
    const covered = reads.filter((q: string) => q.includes("AS covered"));
    // The coverage half has to be IN the read, or the rule is being handed a
    // number nothing measured.
    assert.equal(covered.length, 1);
    assert.match(covered[0], /MAX\(captured_at\)/);
    assert.match(covered[0], /FROM neurons/);
    // The durable record is the whole point of the change: a healthy tick must be
    // recorded too, or "the watchdog stopped running" stays invisible.
    //
    // TWO verdicts now, for the same reason as the two reads above: the
    // subnet-lifecycle lane folded into this tick (#10262) records its own.
    // The statements are textually identical -- they differ only in the bound
    // `lane` value -- so this asserts the count and the per-lane assertions
    // live in tests/subnet-lifecycle.test.ts, which can see the binds.
    const writes = queries.filter((q: string) =>
      q.includes("INSERT INTO lane_health"),
    );
    assert.equal(writes.length, 2);
  });
});

// ---- the threshold against the WRITE path (#10665) ----
//
// This watchdog reads `now - MAX(captured_at)`, and a row is only in the table
// once it has been written. Until 2026-08-11 that second term was ~zero because
// every lane wrote straight through. `neurons` is a buffered lane now (#10758),
// and the buffer holds statements for up to FLUSH_INTERVAL_MS.
//
// Measured, not theorised: the buffer was enabled at 01:33 PDT that day and
// this lane alarmed from 02:21 with an age climbing 80.6 -> 170.6 minutes in
// exact 15-minute steps, falling back to 52.4 by 04:52 after it was disabled at
// 03:47. Three hours of "the poller Container has missed at least three ticks"
// for a poller that had missed nothing.
describe("the staleness threshold absorbs write-visibility lag", () => {
  const buffered = { NEON_WRITE_BUFFER_LANES: NEURONS_BUFFER_LANE };

  test("an unbuffered lane keeps the bare three-missed-ticks bound", () => {
    assert.equal(
      neuronsStalenessThresholdMs({ NEON_WRITE_BUFFER_LANES: "" }),
      NEURONS_STALENESS_THRESHOLD_MS,
    );
  });

  test("a buffered lane adds the flush interval, so three ticks still means three", () => {
    assert.equal(
      neuronsStalenessThresholdMs(buffered),
      NEURONS_STALENESS_THRESHOLD_MS + FLUSH_INTERVAL_MS,
    );
  });

  test("turning the buffer off restores the tighter bound", () => {
    // Conditional rather than a flat widening: ten minutes of permanent slack
    // behind a flag nobody re-reads is how a threshold stops meaning anything.
    assert.ok(
      neuronsStalenessThresholdMs({ NEON_WRITE_BUFFER_LANES: "" }) <
        neuronsStalenessThresholdMs(buffered),
    );
  });

  test("the env override is still the base, and still absorbs the flush", () => {
    assert.equal(
      neuronsStalenessThresholdMs({
        ...buffered,
        NEURONS_STALENESS_THRESHOLD_MS: "300000",
      }),
      300_000 + FLUSH_INTERVAL_MS,
    );
  });

  test("a lane held under the widened bound no longer alarms", async () => {
    // 50 minutes: over the bare 45-minute threshold, under the buffered one.
    // Before #10665 this was a page; the rows exist and the buffer has simply
    // not flushed them yet.
    const { env } = fakeDb(NOW - 50 * 60_000);
    const result = await runNeuronsStalenessWatchdog(
      { ...env, ...buffered },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, false);
    assert.equal(
      result.threshold_ms,
      NEURONS_STALENESS_THRESHOLD_MS + FLUSH_INTERVAL_MS,
    );
  });

  test("a genuinely dead lane still alarms through the widened bound", async () => {
    // The direction that matters: absorbing the flush must not buy silence for
    // a producer that really has stopped.
    const recorded: { error?: Error }[] = [];
    const { env } = fakeDb(NOW - 3 * 60 * 60_000);
    const result = await runNeuronsStalenessWatchdog(
      { ...env, ...buffered },
      {
        now: () => NOW,
        recordException: (async (_e: never, event: never) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "stale");
    assert.match(
      String(recorded[0].error?.message),
      /newest READABLE snapshot/,
    );
  });
});

describe("the stall message names what was measured, not a cause", () => {
  test("a buffered lane names BOTH suspects", async () => {
    // The watchdog reads the table, so a producer that stopped and a write
    // path holding rows are the same observation to it. Asserting the first
    // sends its reader to the wrong place before they reach the second line.
    const recorded: { error?: Error }[] = [];
    const { env } = fakeDb(NOW - 5 * 60 * 60_000);
    await runNeuronsStalenessWatchdog(
      { ...env, NEON_WRITE_BUFFER_LANES: NEURONS_BUFFER_LANE },
      {
        now: () => NOW,
        recordException: (async (_e: never, event: never) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    const message = String(recorded[0].error?.message);
    assert.match(message, /poller Container has stopped capturing/);
    assert.match(message, /neon write buffer is not flushing/);
    assert.ok(
      !message.includes("missed at least three ticks"),
      "the retired claim asserted a cause this watchdog cannot see",
    );
  });

  test("an unbuffered lane names only the producer, because that is the only suspect", async () => {
    const recorded: { error?: Error }[] = [];
    const { env } = fakeDb(NOW - 5 * 60 * 60_000);
    await runNeuronsStalenessWatchdog(
      { ...env, NEON_WRITE_BUFFER_LANES: "" },
      {
        now: () => NOW,
        recordException: (async (_e: never, event: never) => {
          recorded.push(event);
          return true;
        }) as never,
      },
    );
    const message = String(recorded[0].error?.message);
    assert.match(message, /poller Container has stopped capturing/);
    assert.ok(!message.includes("write buffer"));
  });
});
