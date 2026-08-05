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
import { describe, test } from "vitest";
import {
  NEURONS_COVERAGE_FLOOR_NETUIDS,
  NEURONS_EXPECTED_NETUIDS,
  NEURONS_PASS_WINDOW_MS,
  NEURONS_STALENESS_THRESHOLD_MS,
  evaluateNeuronsStaleness,
  runNeuronsStalenessWatchdog,
} from "../src/neurons-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;
/** A pass that covered the network, so coverage is never the thing under test
 * unless a case says so. */
const FULL = NEURONS_EXPECTED_NETUIDS;

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
    const { db } = fakeDb(NOW - 5 * 60_000);
    const recorded: unknown[] = [];
    const result = await runNeuronsStalenessWatchdog(
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
  });

  test("the read counts subnets at the newest stamp, bounded by the pass window", () => {
    // A window at or over the 15-minute tick would merge two passes into one
    // coverage count, letting a half-scanned pass on top of a complete one
    // report full coverage -- the bug this closes.
    const { db, queries, binds } = fakeDb(NOW - 5 * 60_000);
    return runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: (async () => true) as never },
    ).then(() => {
      assert.deepEqual(binds[0], [NEURONS_PASS_WINDOW_MS]);
      assert.ok(
        NEURONS_PASS_WINDOW_MS < 15 * 60_000,
        "the window must stay under the poller's 15-minute tick",
      );
      // DISTINCT netuid, not COUNT(*) -- rows would hide a scan that died after
      // the largest subnets.
      assert.match(queries[0], /COUNT\(DISTINCT netuid\) AS total/);
      assert.match(queries[0], /THEN netuid END\) AS covered/);
      assert.match(
        queries[0],
        /captured_at >= \(SELECT MAX\(captured_at\) FROM neurons\) - \?/,
      );
    });
  });

  test("a recent but half-scanned network alerts, naming both counts", async () => {
    const { db } = fakeDb(NOW - 5 * 60_000, 64, 129);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runNeuronsStalenessWatchdog(
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
    const { db, binds } = fakeDb(NOW - 5 * 60_000, 110, 129);
    const raised = await runNeuronsStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
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
        METAGRAPH_HEALTH_DB: fakeDb(NOW - 5 * 60_000, 110, 129).db,
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
    const { db } = fakeDb(NOW - 5 * 60_000, null as unknown as number, 0);
    const result = await runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.covered_netuids, 0);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "partial");

    const junk = fakeDb(
      NOW - 5 * 60_000,
      "not a number" as unknown as number,
      0,
    );
    const nonNumeric = await runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: junk.db },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(nonNumeric.covered_netuids, 0);
    assert.equal(nonNumeric.alerted, true);
  });

  test("a stalled lane records ONE exception naming the age and threshold", async () => {
    const { db } = fakeDb(NOW - 3 * 60 * 60_000);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runNeuronsStalenessWatchdog(
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
    assert.equal(recorded[0].route, "watchdog:neurons-staleness");
    assert.equal(recorded[0].errorCode, "stale_lane");
    assert.match(String(recorded[0].error?.message), /180\.0 min old/);
    assert.match(String(recorded[0].error?.message), /threshold 45 min/);
  });

  test("an empty table alerts with the no-rows wording", async () => {
    const { db } = fakeDb(null);
    const recorded: { error?: Error }[] = [];
    const result = await runNeuronsStalenessWatchdog(
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
    assert.match(String(recorded[0].error?.message), /no rows at all/);
  });

  test("the env threshold override wins over the default", async () => {
    const { db } = fakeDb(NOW - 10 * 60_000);
    const result = await runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db, NEURONS_STALENESS_THRESHOLD_MS: "300000" },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, 300_000);
  });

  test("a missing binding and a failing query degrade to summaries, never throws", async () => {
    assert.deepEqual(await runNeuronsStalenessWatchdog({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runNeuronsStalenessWatchdog(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    const { db } = fakeDb(new Error("D1_ERROR: no such table: neurons"));
    const result = await runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { recordException: (async () => true) as never },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.match(String(result.detail), /no such table/);

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
    const nonError = await runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: stringThrow },
      { recordException: (async () => true) as never },
    );
    assert.equal(nonError.reason, "query_failed");
    assert.equal(nonError.detail, "socket hangup");
  });

  test("a telemetry failure never fails the tick", async () => {
    const { db } = fakeDb(NOW - 2 * 60 * 60_000);
    const result = await runNeuronsStalenessWatchdog(
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
    const { db } = fakeDb(NOW - 2 * 60 * 60_000);
    const result = await runNeuronsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });
});

describe("handleScheduled NEURONS_STALENESS_WATCHDOG_CRON", () => {
  test("dispatches to the watchdog and returns its summary", async () => {
    const { db, queries } = fakeDb(Date.now());
    const result = (await handleScheduled(
      {
        cron: workerConfig.NEURONS_STALENESS_WATCHDOG_CRON,
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
    const reads = queries.filter((q: string) => q.includes("FROM neurons"));
    assert.equal(reads.length, 1);
    assert.match(reads[0], /MAX\(captured_at\)/);
    assert.match(reads[0], /FROM neurons/);
    // The coverage half has to be IN the read, or the rule is being handed a
    // number nothing measured.
    assert.match(reads[0], /AS covered/);
    // The durable record is the whole point of the change: a healthy tick must be
    // recorded too, or "the watchdog stopped running" stays invisible.
    const writes = queries.filter((q: string) =>
      q.includes("INSERT INTO lane_health"),
    );
    assert.equal(writes.length, 1);
  });
});
