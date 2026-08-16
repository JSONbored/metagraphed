// The chain-detail live lane's alarm (#9208) and its cron wiring.
//
// This lane fails more quietly than the neurons one it is modelled on: a
// stalled chain-detail lane keeps the block list live and merely starts
// DECLINING drill-down, which is correct per request and invisible in
// aggregate. The alarm is the only thing that makes it visible, so the edges
// below -- a late-but-covered lane stays quiet, an empty tier is never
// "healthy" -- are the whole contract.
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
  CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
  evaluateChainDetailStaleness,
  runChainDetailStalenessWatchdog,
} from "../src/chain-detail-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";
import { runStalenessLane } from "./helpers/staleness-lane.ts";

const NOW = 1_785_800_000_000;
const HEAD = 8_762_600;

/** Clear the shared controller, so one test's canned answer cannot leak into
 * the next -- the mock is module state and outlives a test. */
function resetPg() {
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = null;
}

/** The lane's one read, answered from the pg double, plus the env that points
 * the watchdog at it.
 *
 * `queries` is a LIVE view over the mock's log rather than a copy, because the
 * callers destructure it and read it after the tick has run -- a getter would
 * be evaluated once, at destructure time, and freeze empty.
 *
 * `latest` and `head` are deliberately untyped: two cases below hand in
 * unparseable text, which is exactly the column value a shim can produce and
 * the thing the rule has to survive. */
function fakeDb(latest: unknown, head: unknown = HEAD) {
  const queries: string[] = [];
  resetPg();
  pg.control.rows = [{ latest, head }];
  pg.control.onQuery = (q) => queries.push(q.text.replace(/\s+/g, " ").trim());
  return { queries, env: pgMockEnv() };
}

/** A store whose next statement throws. `unknown` rather than `Error` because a
 * driver rejecting with a bare string is one of the cases under test. */
function failingDb(error: unknown) {
  resetPg();
  pg.control.failNext = error as Error;
  return pgMockEnv();
}

function collector() {
  const recorded: { error?: Error; route?: string; errorCode?: string }[] = [];
  return {
    recorded,
    recordException: (async (_env: never, event: never) => {
      recorded.push(event);
      return true;
    }) as never,
  };
}

describe("evaluateChainDetailStaleness", () => {
  test("a lane a few minutes behind is quiet; past the threshold it is a stall", () => {
    const late = evaluateChainDetailStaleness({
      latestObservedAtMs: NOW - 5 * 60_000,
      headBlock: HEAD,
      nowMs: NOW,
      thresholdMs: CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
    });
    assert.equal(late.stale, false);
    assert.equal(late.reason, null);
    assert.equal(late.head_block, HEAD);

    const stalled = evaluateChainDetailStaleness({
      latestObservedAtMs: NOW - 21 * 60_000,
      headBlock: HEAD,
      nowMs: NOW,
      thresholdMs: CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
    });
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "stale");
  });

  test("exactly at the threshold is NOT stale -- the boundary is inclusive-quiet", () => {
    const verdict = evaluateChainDetailStaleness({
      latestObservedAtMs: NOW - CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
      headBlock: HEAD,
      nowMs: NOW,
      thresholdMs: CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false);
  });

  test("an empty tier is a stall of infinite age, never a healthy quiet", () => {
    const verdict = evaluateChainDetailStaleness({
      latestObservedAtMs: null,
      headBlock: null,
      nowMs: NOW,
      thresholdMs: CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
  });
});

describe("runChainDetailStalenessWatchdog", () => {
  test("a fresh lane reports quiet and records nothing", async () => {
    const { env, queries } = fakeDb(NOW - 60_000);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(env, {
      now: () => NOW,
      recordException,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.deepEqual(recorded, []);
    // It measures the CHAIN's clock as the poller saw it, not our write clock:
    // a poller re-POSTing the same two blocks forever must not read as fresh.
    assert.match(queries[0], /MAX\(observed_at\) AS latest/);
  });

  test("a stalled lane records ONE exception naming the age, threshold and head", async () => {
    const { env } = fakeDb(NOW - 90 * 60_000);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(env, {
      now: () => NOW,
      recordException,
    });
    assert.equal(result.alerted, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].route, "watchdog:chain-detail-staleness");
    assert.equal(recorded[0].errorCode, "stale_lane");
    assert.match(String(recorded[0].error?.message), /90\.0 min behind/);
    assert.match(String(recorded[0].error?.message), /threshold 20 min/);
    assert.match(String(recorded[0].error?.message), new RegExp(String(HEAD)));
    assert.match(String(recorded[0].error?.message), /declining drill-down/);
  });

  test("an empty tier alerts with the no-blocks wording", async () => {
    const { env } = fakeDb(null, null);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(env, {
      now: () => NOW,
      recordException,
    });
    assert.equal(result.reason, "no_rows");
    assert.match(String(recorded[0].error?.message), /no blocks at all/);
    assert.match(String(recorded[0].error?.message), /head block none/);
  });

  test("a telemetry failure does not fail the tick", async () => {
    const { env } = fakeDb(NOW - 90 * 60_000);
    const result = await runChainDetailStalenessWatchdog(env, {
      now: () => NOW,
      recordException: (async () => {
        throw new Error("posthog down");
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });

  test("the env threshold override wins over the default", async () => {
    const { env } = fakeDb(NOW - 6 * 60_000);
    const result = await runChainDetailStalenessWatchdog(
      {
        ...env,
        CHAIN_DETAIL_STALENESS_THRESHOLD_MS: "300000",
      },
      { now: () => NOW, recordException: (async () => true) as never },
    );
    assert.equal(result.alerted, true);
    assert.equal(result.threshold_ms, 300_000);
  });

  test("a missing binding and a failing query degrade to summaries, never throw", async () => {
    assert.deepEqual(await runChainDetailStalenessWatchdog({}), {
      ok: false,
      reason: "no store bound",
    });
    assert.deepEqual(await runChainDetailStalenessWatchdog(null), {
      ok: false,
      reason: "no store bound",
    });
    const result = await runChainDetailStalenessWatchdog(
      failingDb(new Error("the store exploded")),
      { now: () => NOW },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.equal(result.detail, "the store exploded");
  });

  test("an unparseable observed_at reads as no rows, never as epoch 0", async () => {
    // Number("") is 0, which as an epoch is 1970 -- an age of 56 years, which
    // would alert with a wildly wrong number instead of the honest "no rows".
    const { env } = fakeDb("not-a-number" as never, "also-bad" as never);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(env, {
      now: () => NOW,
      recordException,
    });
    assert.equal(result.reason, "no_rows");
    assert.equal(result.head_block, null);
    assert.match(String(recorded[0].error?.message), /no blocks at all/);
  });

  test("a non-Error throw is still reported as a string", async () => {
    const result = await runChainDetailStalenessWatchdog(failingDb("boom"));
    assert.equal(result.detail, "boom");
  });

  test("uses the real clock and telemetry when no deps are injected", async () => {
    // The default branches (deps.now ?? Date.now, deps.recordException ??
    // recordExceptionEvent) are the ones production actually runs.
    const { env } = fakeDb(Date.now() - 1_000);
    const result = await runChainDetailStalenessWatchdog(env);
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
  });
});

describe("the cron wiring", () => {
  test("the watchdog cron reaches the watchdog, and reports its verdict", async () => {
    const { env } = fakeDb(Date.now() - 1_000);
    const result = (await runStalenessLane(
      "chain-detail-staleness",
      env as never,
      {} as never,
    )) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
  });

  test("the prune cron reaches the prune, not the watchdog", async () => {
    // The two branches sit next to each other and both decline on an unbound
    // store, so "reason" no longer tells them apart -- since #10179 they both
    // say "no store bound". What still does is the SHAPE of a successful
    // answer: only the prune reports `blocks_pruned`, and an empty tier is a
    // success for it ("the lane has simply not written yet") where an empty
    // tier is an ALARM for the watchdog. So this drives it with a store that
    // answers, and reads the shape.
    const empty = { floor: null, head: null };
    resetPg();
    pg.control.rows = [empty];
    const result = (await handleScheduled(
      { cron: workerConfig.CHAIN_DETAIL_PRUNE_CRON } as never,
      pgMockEnv() as never,
      {} as never,
    )) as Record<string, unknown>;
    assert.deepEqual(result, { ok: true, reason: "no rows", blocks_pruned: 0 });
  });
});
