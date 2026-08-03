// The neurons live lane's alarm (src/neurons-staleness-watchdog.ts) and its
// cron wiring. The rule's edges are the point: one restarted container is a
// missed tick by design and must NOT alert; three missed ticks is a stall and
// MUST; and an empty table is a stall of infinite age, never a healthy quiet.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  NEURONS_STALENESS_THRESHOLD_MS,
  evaluateNeuronsStaleness,
  runNeuronsStalenessWatchdog,
} from "../src/neurons-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;

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

describe("evaluateNeuronsStaleness", () => {
  test("one missed tick is quiet, three is a stall", () => {
    const oneTick = evaluateNeuronsStaleness({
      latestCapturedAtMs: NOW - 20 * 60_000,
      nowMs: NOW,
      thresholdMs: NEURONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(oneTick.stale, false);
    assert.equal(oneTick.reason, null);
    assert.equal(oneTick.age_ms, 20 * 60_000);

    const stalled = evaluateNeuronsStaleness({
      latestCapturedAtMs: NOW - 46 * 60_000,
      nowMs: NOW,
      thresholdMs: NEURONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
  });

  test("an empty table is a stall of infinite age", () => {
    const verdict = evaluateNeuronsStaleness({
      latestCapturedAtMs: null,
      nowMs: NOW,
      thresholdMs: NEURONS_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
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
        first: async () => {
          throw "socket hangup";
        },
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
    assert.equal(queries.length, 1);
    assert.match(queries[0], /MAX\(captured_at\).*FROM neurons/);
  });
});
