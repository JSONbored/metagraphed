// The hotkey-alpha pool ledger's alarm (#9576) and its cron wiring.
//
// The case this file exists for is the one production was actually in when the
// watchdog was written: `hotkey_alpha` held 0 rows, `hotkey_alpha_passes` held
// 0 passes, and every reader of the ledger answered 200. `/accounts/top-holders`
// served `delegated_tao` off the frozen 2026-08-02 materialization and
// `/subnets/{netuid}/holders` returned `pool_totals_unproven` — both correct,
// both indistinguishable from a producer that died weeks ago. So an EMPTY table
// alerting is asserted first and hardest.
//
// The threshold's edge matters differently here than on the twin lane. This
// producer polls every 24 h against `account_balances`' 6 h, so a 20-hour-old
// capture is a HEALTHY mid-cycle reading and must stay silent — the mistake
// #9301 had to correct on the nominator-positions watchdog after a bound was set
// tighter than its producer's cadence and alerted for three quarters of the day.
//
// And the coverage floor is DERIVED rather than declared, which is the real
// divergence from #9478 and the thing worth testing directly: since #9560 the
// sink stores only the pools some position references, so the expectation is
// whatever `nominator_positions` currently names. A floor read from the wrong
// place is an alarm that is quietly too low to fire, and nothing about a passing
// tick would say so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  HOTKEY_ALPHA_COVERAGE_FLOOR_RATIO,
  HOTKEY_ALPHA_PASS_WINDOW_MS,
  HOTKEY_ALPHA_STALENESS_THRESHOLD_MS,
  evaluateHotkeyAlphaStaleness,
  runHotkeyAlphaStalenessWatchdog,
} from "../src/hotkey-alpha-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60_000;
/** Distinct (hotkey, netuid) pairs the position ledger names — the measured
 * production figure the floor is derived from (#9560). */
const REFERENCED = 17_902;
/** A pass that covered every referenced pool, so `covered` is never the thing
 * under test unless a case says so. */
const FULL = REFERENCED;

function fakeDb(
  latest: number | null | Error,
  covered: number = FULL,
  total: number = FULL,
  referenced: number = REFERENCED,
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
                return { latest, covered, total, referenced };
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
  over: Partial<Parameters<typeof evaluateHotkeyAlphaStaleness>[0]> = {},
) {
  return {
    latestCapturedAtMs: NOW - HOUR,
    coveredRows: FULL,
    totalRows: FULL,
    referencedPairs: REFERENCED,
    nowMs: NOW,
    thresholdMs: HOTKEY_ALPHA_STALENESS_THRESHOLD_MS,
    coverageFloorRatio: HOTKEY_ALPHA_COVERAGE_FLOOR_RATIO,
    ...over,
  };
}

describe("evaluateHotkeyAlphaStaleness", () => {
  test("an empty ledger is a stall of infinite age, never a healthy quiet", () => {
    // The exact production state on 2026-08-05: the sink had shipped, no pass
    // had ever landed, and nothing anywhere said so.
    const verdict = evaluateHotkeyAlphaStaleness(
      inputs({ latestCapturedAtMs: null, coveredRows: 0, totalRows: 0 }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
    assert.equal(verdict.latest_captured_at, null);
  });

  test("a recent pass is quiet; one past the threshold is a stall", () => {
    const fresh = evaluateHotkeyAlphaStaleness(
      inputs({ latestCapturedAtMs: NOW - 2 * HOUR }),
    );
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, null);
    assert.equal(fresh.age_ms, 2 * HOUR);

    const stalled = evaluateHotkeyAlphaStaleness(
      inputs({ latestCapturedAtMs: NOW - 49 * HOUR }),
    );
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
  });

  test("a capture from the middle of the producer's 24h cycle is quiet", () => {
    // HOTKEY_ALPHA_POLL_SECS defaults to 86400, and the buffered
    // TotalHotkeyAlpha walk sits on top of that — so a healthy lane's age swings
    // across this whole range and none of it may alert.
    for (const hours of [1, 6, 12, 20, 24, 30, 47]) {
      assert.equal(
        evaluateHotkeyAlphaStaleness(
          inputs({ latestCapturedAtMs: NOW - hours * HOUR }),
        ).stale,
        false,
        `${hours}h into a 24h cycle must not alert`,
      );
    }
  });

  test("exactly at the threshold is not yet a stall", () => {
    // Strictly-greater, so a lane running exactly on cadence never flaps.
    assert.equal(
      evaluateHotkeyAlphaStaleness(
        inputs({
          latestCapturedAtMs: NOW - HOTKEY_ALPHA_STALENESS_THRESHOLD_MS,
        }),
      ).stale,
      false,
    );
  });

  test("a recent but short pass is partial, not fresh", () => {
    // The discrimination a timestamp cannot make: a pass that ran an hour ago
    // and wrote a third of the pools reads as perfectly fresh from MAX() alone.
    const verdict = evaluateHotkeyAlphaStaleness(
      inputs({ coveredRows: Math.round(REFERENCED / 3) }),
    );
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "partial");
    assert.equal(verdict.coverage_floor_rows, Math.round(REFERENCED * 0.8));
  });

  test("staleness is decided before coverage", () => {
    // Both faults present: the headline must be that the producer stopped, not
    // how much its last attempt managed to write two days ago.
    const verdict = evaluateHotkeyAlphaStaleness(
      inputs({ latestCapturedAtMs: NOW - 60 * HOUR, coveredRows: 1 }),
    );
    assert.equal(verdict.reason, "stale");
  });

  test("the floor tracks the position ledger rather than a constant", () => {
    // The #9560 divergence from the twin. The same 14,000-row pass is complete
    // against a small position ledger and truncated against a grown one — a
    // hardcoded expectation would call both the same.
    const small = evaluateHotkeyAlphaStaleness(
      inputs({ referencedPairs: 15_000, coveredRows: 14_000 }),
    );
    assert.equal(small.stale, false);
    assert.equal(small.coverage_floor_rows, 12_000);

    const grown = evaluateHotkeyAlphaStaleness(
      inputs({ referencedPairs: 40_000, coveredRows: 14_000 }),
    );
    assert.equal(grown.stale, true);
    assert.equal(grown.reason, "partial");
    assert.equal(grown.coverage_floor_rows, 32_000);
  });

  test("exactly at the floor is complete", () => {
    assert.equal(
      evaluateHotkeyAlphaStaleness(
        inputs({ coveredRows: Math.round(REFERENCED * 0.8) }),
      ).stale,
      false,
    );
  });

  test("an empty position ledger declines the coverage clause, not the tick", () => {
    // A floor of zero would mark every pass complete, including no pass at all.
    // `nominator_positions` has its own alarm; this one must not restate it and
    // send the reader to the wrong producer.
    const verdict = evaluateHotkeyAlphaStaleness(
      inputs({ referencedPairs: 0, coveredRows: 0 }),
    );
    assert.equal(verdict.coverage_floor_rows, null);
    assert.equal(verdict.stale, false);
    assert.equal(verdict.reason, null);
    // The freshness half still stands on its own.
    assert.equal(
      evaluateHotkeyAlphaStaleness(
        inputs({
          referencedPairs: 0,
          coveredRows: 0,
          latestCapturedAtMs: NOW - 60 * HOUR,
        }),
      ).reason,
      "stale",
    );
  });

  test("total_rows is carried as context and never used as the rule", () => {
    // A table full of old vintages under a short new pass still reports partial.
    const verdict = evaluateHotkeyAlphaStaleness(
      inputs({ coveredRows: 100, totalRows: 500_000 }),
    );
    assert.equal(verdict.reason, "partial");
    assert.equal(verdict.total_rows, 500_000);
  });
});

describe("runHotkeyAlphaStalenessWatchdog", () => {
  const noopRecord = async () => true as never;

  test("reads the lane once, bound to the pass window", async () => {
    const { db, queries, binds } = fakeDb(NOW - HOUR);
    const result = await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: noopRecord },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    const reads = queries.filter((q) => q.includes("FROM hotkey_alpha"));
    assert.equal(reads.length, 1);
    // Both ledgers are read in the one statement — the floor is derived, not
    // fetched separately, so the two cannot be read at different moments.
    assert.match(reads[0], /FROM nominator_positions/);
    assert.deepEqual(binds[0], [HOTKEY_ALPHA_PASS_WINDOW_MS]);
  });

  test("an empty ledger alerts and names both affected surfaces", async () => {
    const messages: string[] = [];
    const { db } = fakeDb(null, 0, 0, REFERENCED);
    const result = await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: unknown, arg: { error: Error }) => {
          messages.push(arg.error.message);
          return true;
        }) as never,
      },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "no_rows");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /has never landed a pass/);
    // The message has to say what is DEGRADED, not just that a table is empty —
    // that is the difference between an alert someone acts on and one they mute.
    assert.match(messages[0], /top-holders/);
    assert.match(messages[0], /pool_totals_unproven/);
  });

  test("a truncated pass gets its own wording, not the stall wording", async () => {
    const messages: string[] = [];
    const { db } = fakeDb(NOW - HOUR, 500, 500, REFERENCED);
    await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: unknown, arg: { error: Error }) => {
          messages.push(arg.error.message);
          return true;
        }) as never,
      },
    );
    assert.match(messages[0], /truncated/);
    // The consequence is UNDERSTATEMENT here, not absence — the fact that
    // separates this ledger's partial failure from the balance ledger's.
    assert.match(messages[0], /UNDERSTATED/);
    assert.match(messages[0], /17902|17,902/);
  });

  test("a stalled lane gets the stall wording", async () => {
    const messages: string[] = [];
    const { db } = fakeDb(NOW - 60 * HOUR);
    await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async (_env: unknown, arg: { error: Error }) => {
          messages.push(arg.error.message);
          return true;
        }) as never,
      },
    );
    assert.match(messages[0], /stalled/);
    assert.match(messages[0], /60\.0 h old/);
  });

  test("a healthy tick records no exception", async () => {
    let called = 0;
    const { db } = fakeDb(NOW - HOUR);
    await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: (async () => {
          called += 1;
          return true;
        }) as never,
      },
    );
    assert.equal(called, 0);
  });

  test("a failing telemetry post does not fail the tick", async () => {
    // The alert is the notification path, not the record — a dropped $exception
    // must not also lose the lane_health verdict behind it.
    const { db } = fakeDb(null, 0, 0);
    const result = await runHotkeyAlphaStalenessWatchdog(
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

  test("env overrides the threshold, window and ratio", async () => {
    const { db, binds } = fakeDb(NOW - 3 * HOUR, 100, 100, 1000);
    const result = await runHotkeyAlphaStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
        HOTKEY_ALPHA_STALENESS_THRESHOLD_MS: 2 * HOUR,
        HOTKEY_ALPHA_PASS_WINDOW_MS: 90_000,
        HOTKEY_ALPHA_COVERAGE_FLOOR_RATIO: 0.5,
      },
      { now: () => NOW, recordException: noopRecord },
    );
    assert.equal(result.threshold_ms, 2 * HOUR);
    assert.equal(result.reason, "stale");
    assert.deepEqual(binds[0], [90_000]);
  });

  test("a null SUM lands on 0 rather than NaN", async () => {
    // NaN would compare false against the floor and report a truncated ledger
    // healthy — the quiet direction, which is the one that matters.
    const { db } = fakeDb(NOW - HOUR, null as unknown as number, 0, REFERENCED);
    const result = await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: noopRecord },
    );
    assert.equal(result.covered_rows, 0);
    assert.equal(result.reason, "partial");
  });

  test("a missing row object is treated as an empty ledger", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    const result = await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: noopRecord },
    );
    assert.equal(result.reason, "no_rows");
  });

  test("no D1 binding is a missed report, not a throw", async () => {
    assert.deepEqual(await runHotkeyAlphaStalenessWatchdog({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runHotkeyAlphaStalenessWatchdog(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });
  });

  test("a failing query is a missed report, not a throw", async () => {
    const { db } = fakeDb(new Error("D1_ERROR: no such table"));
    const result = await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: noopRecord },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.match(String(result.detail), /no such table/);
  });

  test("a non-Error throw still reports a detail", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw "string rejection";
          },
        }),
      }),
    };
    const result = await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException: noopRecord },
    );
    assert.equal(result.reason, "query_failed");
    assert.equal(result.detail, "string rejection");
  });

  test("defaults are used when no deps are injected", async () => {
    // Exercises the `deps.now ?? Date.now` / `deps.recordException ?? …` arms,
    // which a fully-injected test never reaches.
    const { db } = fakeDb(Date.now());
    const result = await runHotkeyAlphaStalenessWatchdog({
      METAGRAPH_HEALTH_DB: db,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
  });

  test("the verdict is written to lane_health under its own name", async () => {
    const lanes: Record<string, unknown>[] = [];
    const { db } = fakeDb(NOW - HOUR);
    await runHotkeyAlphaStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: noopRecord,
        laneHealthDb: {
          prepare: (sql: string) => ({
            bind: (...values: unknown[]) => {
              lanes.push({ sql, values });
              return { run: async () => ({}) };
            },
          }),
        } as never,
      },
    );
    // Written EVERY tick, not only when stale: a dropped exception is otherwise
    // indistinguishable from a lane that was fine (#9330/#9340). Asserted by
    // SHAPE rather than by count — recordLaneVerdict's own statement sequence is
    // its business, and a bare length check would have to be bumped whenever it
    // changes while saying nothing about which lane was recorded.
    // The INSERT specifically: recordLaneVerdict also prunes this lane's expired
    // rows on the way through, and that DELETE binds the same lane name.
    const named = lanes.filter(
      (call) =>
        String(call.sql).startsWith("INSERT INTO lane_health") &&
        (call.values as unknown[]).includes("hotkey-alpha-staleness"),
    );
    assert.equal(
      named.length,
      1,
      "exactly one verdict, carrying this lane's own name",
    );
    assert.ok((named[0].values as unknown[]).includes("ok"));
  });
});

describe("the cron string is unique and wired", () => {
  test("no other cron in workers/config.ts shares the literal string", () => {
    // Dispatch keys on the LITERAL cron string, so a duplicate silently routes
    // this lane into another branch entirely.
    const crons = Object.entries(workerConfig)
      .filter(([key]) => key.endsWith("_CRON"))
      .map(([, value]) => value);
    const mine = workerConfig.HOTKEY_ALPHA_STALENESS_WATCHDOG_CRON;
    assert.equal(
      crons.filter((cron) => cron === mine).length,
      1,
      `${mine} is declared by more than one lane`,
    );
  });

  test("it stays off the */5 and */15 grids", () => {
    // Both grids fire on every minute divisible by 5, so a watchdog sharing one
    // contends with the raw-capture and probe lanes on the same tick.
    const minute = Number(
      workerConfig.HOTKEY_ALPHA_STALENESS_WATCHDOG_CRON.split(" ")[0],
    );
    assert.equal(Number.isInteger(minute), true);
    assert.notEqual(minute % 5, 0);
  });

  test("wrangler.jsonc declares the trigger", () => {
    // A cron the Worker dispatches on but wrangler never fires is dead code —
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
        workerConfig.HOTKEY_ALPHA_STALENESS_WATCHDOG_CRON,
      ),
    );
  });

  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { db, queries } = fakeDb(Date.now());
    const result = (await handleScheduled(
      {
        cron: workerConfig.HOTKEY_ALPHA_STALENESS_WATCHDOG_CRON,
      } as unknown as ScheduledController,
      { METAGRAPH_HEALTH_DB: db } as unknown as Parameters<
        typeof handleScheduled
      >[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    const reads = queries.filter((q: string) =>
      q.includes("FROM hotkey_alpha"),
    );
    assert.equal(reads.length, 1);
  });

  test("it does not swallow the neighbouring lane's cron", async () => {
    // This branch is checked immediately BEFORE the account-balances watchdog,
    // so a mistake here — a copied constant, a stray `||` — routes that lane
    // into this one and silences it while both crons keep firing. Dispatch keys
    // on the literal string and nothing else proves the two stay distinct.
    const { db, queries } = fakeDb(Date.now());
    const result = (await handleScheduled(
      {
        cron: workerConfig.ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON,
      } as unknown as ScheduledController,
      { METAGRAPH_HEALTH_DB: db } as unknown as Parameters<
        typeof handleScheduled
      >[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean };
    assert.equal(result.ok, true);
    // The neighbour read ITS table, and this lane's read never happened.
    assert.equal(
      queries.filter((q: string) => q.includes("FROM account_balances")).length,
      1,
    );
    assert.equal(
      queries.filter((q: string) => q.includes("FROM hotkey_alpha")).length,
      0,
    );
  });
});
