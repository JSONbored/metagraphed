// The chain-detail live lane's alarm (#9208) and its cron wiring.
//
// This lane fails more quietly than the neurons one it is modelled on: a
// stalled chain-detail lane keeps the block list live and merely starts
// DECLINING drill-down, which is correct per request and invisible in
// aggregate. The alarm is the only thing that makes it visible, so the edges
// below -- a late-but-covered lane stays quiet, an empty tier is never
// "healthy" -- are the whole contract.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_DETAIL_STALENESS_THRESHOLD_MS,
  evaluateChainDetailStaleness,
  runChainDetailStalenessWatchdog,
} from "../src/chain-detail-staleness-watchdog.ts";
import { handleScheduled } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

const NOW = 1_785_800_000_000;
const HEAD = 8_762_600;

function fakeDb(latest: number | null | Error, head: number | null = HEAD) {
  const queries: string[] = [];
  return {
    queries,
    db: {
      prepare(sql: string) {
        queries.push(sql.replace(/\s+/g, " ").trim());
        return {
          async first() {
            if (latest instanceof Error) throw latest;
            return { latest, head };
          },
        };
      },
    },
  };
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
    const { db, queries } = fakeDb(NOW - 60_000);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException },
    );
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.deepEqual(recorded, []);
    // It measures the CHAIN's clock as the poller saw it, not our write clock:
    // a poller re-POSTing the same two blocks forever must not read as fresh.
    assert.match(queries[0], /MAX\(observed_at\) AS latest/);
  });

  test("a stalled lane records ONE exception naming the age, threshold and head", async () => {
    const { db } = fakeDb(NOW - 90 * 60_000);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException },
    );
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
    const { db } = fakeDb(null, null);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException },
    );
    assert.equal(result.reason, "no_rows");
    assert.match(String(recorded[0].error?.message), /no blocks at all/);
    assert.match(String(recorded[0].error?.message), /head block none/);
  });

  test("a telemetry failure does not fail the tick", async () => {
    const { db } = fakeDb(NOW - 90 * 60_000);
    const result = await runChainDetailStalenessWatchdog(
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

  test("the env threshold override wins over the default", async () => {
    const { db } = fakeDb(NOW - 6 * 60_000);
    const result = await runChainDetailStalenessWatchdog(
      {
        METAGRAPH_HEALTH_DB: db,
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
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runChainDetailStalenessWatchdog(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    const { db } = fakeDb(new Error("d1 exploded"));
    const result = await runChainDetailStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.equal(result.detail, "d1 exploded");
  });

  test("an unparseable observed_at reads as no rows, never as epoch 0", async () => {
    // Number("") is 0, which as an epoch is 1970 -- an age of 56 years, which
    // would alert with a wildly wrong number instead of the honest "no rows".
    const { db } = fakeDb("not-a-number" as never, "also-bad" as never);
    const { recorded, recordException } = collector();
    const result = await runChainDetailStalenessWatchdog(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => NOW, recordException },
    );
    assert.equal(result.reason, "no_rows");
    assert.equal(result.head_block, null);
    assert.match(String(recorded[0].error?.message), /no blocks at all/);
  });

  test("a non-Error throw is still reported as a string", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            first() {
              throw "boom";
            },
          };
        },
      },
    };
    const result = await runChainDetailStalenessWatchdog(env);
    assert.equal(result.detail, "boom");
  });

  test("uses the real clock and telemetry when no deps are injected", async () => {
    // The default branches (deps.now ?? Date.now, deps.recordException ??
    // recordExceptionEvent) are the ones production actually runs.
    const { db } = fakeDb(Date.now() - 1_000);
    const result = await runChainDetailStalenessWatchdog({
      METAGRAPH_HEALTH_DB: db,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
  });
});

describe("the cron wiring", () => {
  test("both #9208 crons are unique strings across the whole config", () => {
    const crons = Object.entries(workerConfig)
      .filter(([name]) => name.endsWith("_CRON"))
      .map(([, value]) => value);
    assert.equal(
      new Set(crons).size,
      crons.length,
      "dispatch keys on the LITERAL cron string, so a duplicate routes one " +
        "lane into another lane's branch",
    );
    assert.ok(crons.includes(workerConfig.CHAIN_DETAIL_PRUNE_CRON));
    assert.ok(
      crons.includes(workerConfig.CHAIN_DETAIL_STALENESS_WATCHDOG_CRON),
    );
    assert.notEqual(
      workerConfig.CHAIN_DETAIL_PRUNE_CRON,
      workerConfig.CHAIN_DETAIL_STALENESS_WATCHDOG_CRON,
    );
  });

  test("the watchdog cron reaches the watchdog, and reports its verdict", async () => {
    const { db } = fakeDb(Date.now() - 1_000);
    const result = (await handleScheduled(
      { cron: workerConfig.CHAIN_DETAIL_STALENESS_WATCHDOG_CRON } as never,
      { METAGRAPH_HEALTH_DB: db } as never,
      {} as never,
    )) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
  });

  test("the prune cron reaches the prune", async () => {
    const result = (await handleScheduled(
      { cron: workerConfig.CHAIN_DETAIL_PRUNE_CRON } as never,
      {} as never,
      {} as never,
    )) as Record<string, unknown>;
    assert.deepEqual(result, {
      ok: false,
      reason: "d1 binding unavailable",
    });
  });
});
