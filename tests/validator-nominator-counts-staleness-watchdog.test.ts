// The validator-nominator-counts lane's alarm (#9301) and its cron wiring.
//
// The rule's edges are the point, and two of them matter here. An EMPTY table
// alerts: that is the pre-cutover state, in which every nominator_count is
// still coming from a frozen lakehouse mirror or serving null outright, which
// is exactly the condition that ran unnoticed from 2026-08-02. And a capture
// from the middle of the producer's 24h cycle is QUIET -- the threshold is
// derived from that cadence rather than picked, because an alarm that fires on
// a healthy lane is one nobody reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
  evaluateValidatorNominatorCountsStaleness,
  runValidatorNominatorCountsStalenessWatchdog,
} from "../src/validator-nominator-counts-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60_000;

function fakeDb(latest: number | null | Error) {
  const queries: string[] = [];
  return {
    queries,
    db: {
      prepare(sql: string) {
        queries.push(sql);
        return {
          async first() {
            if (latest instanceof Error) throw latest;
            return { latest };
          },
        };
      },
    },
  };
}

describe("evaluateValidatorNominatorCountsStaleness", () => {
  test("a recent pass is quiet; one past the threshold is a stall", () => {
    const fresh = evaluateValidatorNominatorCountsStaleness({
      latestCapturedAtMs: NOW - 2 * HOUR,
      nowMs: NOW,
      thresholdMs: VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, null);
    assert.equal(fresh.age_ms, 2 * HOUR);

    const stalled = evaluateValidatorNominatorCountsStaleness({
      latestCapturedAtMs: NOW - 31 * HOUR,
      nowMs: NOW,
      thresholdMs: VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
    assert.equal(stalled.latest_captured_at, NOW - 31 * HOUR);
  });

  test("a capture from the middle of the producer's 24h cycle is quiet", () => {
    // The threshold has to clear one whole cadence: the producer scans every
    // 24h, so a healthy lane presents an age anywhere in [0h, 24h+scan] and
    // any threshold at or under 24h alerts on a lane that is working.
    for (const hours of [7, 12, 20, 23, 24]) {
      const verdict = evaluateValidatorNominatorCountsStaleness({
        latestCapturedAtMs: NOW - hours * HOUR,
        nowMs: NOW,
        thresholdMs: VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
      });
      assert.equal(
        verdict.stale,
        false,
        `${hours}h into a 24h cycle must not alert`,
      );
    }
  });

  test("exactly at the threshold is not yet a stall", () => {
    // Strictly-greater, so a lane running exactly on cadence never flaps.
    const verdict = evaluateValidatorNominatorCountsStaleness({
      latestCapturedAtMs:
        NOW - VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
      nowMs: NOW,
      thresholdMs: VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false);
  });

  test("an empty table is a stall of infinite age, never a healthy quiet", () => {
    const verdict = evaluateValidatorNominatorCountsStaleness({
      latestCapturedAtMs: null,
      nowMs: NOW,
      thresholdMs: VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
    assert.equal(verdict.latest_captured_at, null);
  });
});

describe("runValidatorNominatorCountsStalenessWatchdog", () => {
  test("a fresh lane reports quiet and records nothing", async () => {
    const { db, queries } = fakeDb(NOW - HOUR);
    const recorded: unknown[] = [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(
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
    assert.match(
      queries[0]!,
      /MAX\(captured_at\)[\s\S]*FROM validator_nominator_counts/,
    );
  });

  test("a stalled lane records ONE exception naming the age and the route it breaks", async () => {
    const { db } = fakeDb(NOW - 48 * HOUR);
    const recorded: { error?: Error; route?: string; errorCode?: string }[] =
      [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(
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
    const { db } = fakeDb(null);
    const recorded: { error?: Error }[] = [];
    const result = await runValidatorNominatorCountsStalenessWatchdog(
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
    const result = await runValidatorNominatorCountsStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
        VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS: String(HOUR),
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, HOUR);
  });

  test("a missing binding and a failing query degrade to summaries, never throw", async () => {
    assert.deepEqual(await runValidatorNominatorCountsStalenessWatchdog({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runValidatorNominatorCountsStalenessWatchdog(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });

    const { db } = fakeDb(
      new Error("D1_ERROR: no such table: validator_nominator_counts"),
    );
    const failed = await runValidatorNominatorCountsStalenessWatchdog(
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
        first: async () => {
          throw "socket hangup";
        },
      }),
    };
    const nonError = await runValidatorNominatorCountsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: stringThrow },
      { recordException: (async () => true) as never },
    );
    assert.equal(nonError.reason, "query_failed");
    assert.equal(nonError.detail, "socket hangup");
  });

  test("a null row and a telemetry failure never fail the tick", async () => {
    const nullRow = {
      prepare: () => ({ first: async () => null }),
    };
    const empty = await runValidatorNominatorCountsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: nullRow },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.reason, "no_rows");

    const { db } = fakeDb(NOW - 48 * HOUR);
    const result = await runValidatorNominatorCountsStalenessWatchdog(
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
    const result = await runValidatorNominatorCountsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);

    // The default clock is the real one, so a stamp far in the past is stale
    // without injecting `now`.
    const past = fakeDb(0);
    const defaults = await runValidatorNominatorCountsStalenessWatchdog({
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
    const mine =
      workerConfig.VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON;
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
        workerConfig.VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON,
      ),
    );
  });

  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { db, queries } = fakeDb(Date.now());
    const result = (await handleScheduled(
      {
        cron: workerConfig.VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON,
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
