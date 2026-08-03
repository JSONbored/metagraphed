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
  NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
  evaluateNominatorPositionsStaleness,
  runNominatorPositionsStalenessWatchdog,
} from "../src/nominator-positions-staleness-watchdog.ts";
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

describe("evaluateNominatorPositionsStaleness", () => {
  test("a recent pass is quiet; one past the threshold is a stall", () => {
    const fresh = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: NOW - 2 * HOUR,
      nowMs: NOW,
      thresholdMs: NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, null);
    assert.equal(fresh.age_ms, 2 * HOUR);

    const stalled = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: NOW - 7 * HOUR,
      nowMs: NOW,
      thresholdMs: NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
    assert.equal(stalled.latest_captured_at, NOW - 7 * HOUR);
  });

  test("exactly at the threshold is not yet a stall", () => {
    // Strictly-greater, so a lane running exactly on cadence never flaps.
    const verdict = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: NOW - NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
      nowMs: NOW,
      thresholdMs: NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false);
  });

  test("an empty table is a stall of infinite age, never a healthy quiet", () => {
    const verdict = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: null,
      nowMs: NOW,
      thresholdMs: NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
    assert.equal(verdict.latest_captured_at, null);
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
    assert.match(queries[0]!, /MAX\(captured_at\).*FROM nominator_positions/);
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
    assert.match(String(recorded[0]!.error?.message), /threshold 6 h/);
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
        first: async () => {
          throw "socket hangup";
        },
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
      prepare: () => ({ first: async () => null }),
    };
    const empty = await runNominatorPositionsStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: nullRow },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.reason, "no_rows");

    const { db } = fakeDb(NOW - 12 * HOUR);
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
    const { db } = fakeDb(NOW - 12 * HOUR);
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
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM nominator_positions/);
  });
});
