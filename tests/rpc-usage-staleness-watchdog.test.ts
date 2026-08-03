// The RPC-usage capture staleness alarm (#9228).
//
// The lane this watches failed silently for over a day: the proxy stayed
// healthy, /api/v1/rpc/usage kept returning a well-formed payload, and only
// the AGE of the data underneath it was wrong. So these tests are about the
// one thing that distinguishes a healthy answer from a frozen one -- and
// about the tick itself never throwing, because a watchdog that crashes is a
// watchdog that reports nothing at all.
//
// Moving to Analytics Engine removed several ways the writer could break (no
// table to drop, no prune to misfire) but not the ones that caused this
// outage: an undeployed binding, a renamed dataset, an over-long index whose
// data points AE rejects, or a code path that simply stops calling
// writeDataPoint. Every one still looks like a healthy route over data that
// stopped advancing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  evaluateRpcUsageStaleness,
  runRpcUsageStalenessWatchdog,
  RPC_USAGE_STALENESS_THRESHOLD_MS,
} from "../src/rpc-usage-staleness-watchdog.ts";
import { ANALYTICS_SQL_TOKEN_ENV } from "../src/analytics-engine-sql.ts";
import type { Row } from "./row-type.ts";

const NOW = 1_785_600_000_000;
const MINUTE = 60_000;
const ENV = { [ANALYTICS_SQL_TOKEN_ENV]: "test-token" } as unknown as Env;

describe("evaluateRpcUsageStaleness", () => {
  test("fresh capture is not stale and records nothing", () => {
    assert.deepEqual(
      evaluateRpcUsageStaleness({
        latestObservedAtMs: NOW - 5 * MINUTE,
        nowMs: NOW,
        thresholdMs: RPC_USAGE_STALENESS_THRESHOLD_MS,
      }),
      {
        stale: false,
        reason: null,
        age_ms: 5 * MINUTE,
        latest_observed_at: NOW - 5 * MINUTE,
        threshold_ms: RPC_USAGE_STALENESS_THRESHOLD_MS,
      },
    );
  });

  test("the threshold is exclusive at its boundary", () => {
    const at = evaluateRpcUsageStaleness({
      latestObservedAtMs: NOW - RPC_USAGE_STALENESS_THRESHOLD_MS,
      nowMs: NOW,
      thresholdMs: RPC_USAGE_STALENESS_THRESHOLD_MS,
    });
    assert.equal(at.stale, false);
    const past = evaluateRpcUsageStaleness({
      latestObservedAtMs: NOW - RPC_USAGE_STALENESS_THRESHOLD_MS - 1,
      nowMs: NOW,
      thresholdMs: RPC_USAGE_STALENESS_THRESHOLD_MS,
    });
    assert.equal(past.stale, true);
    assert.equal(past.reason, "stale");
  });

  test("no data points is a stall of infinite age, not a quiet window", () => {
    // This is exactly the state production was in when #9228 was filed: the
    // route answered correctly, from a store nothing had written to.
    const verdict = evaluateRpcUsageStaleness({
      latestObservedAtMs: null,
      nowMs: NOW,
      thresholdMs: RPC_USAGE_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "no_rows");
    assert.equal(verdict.age_ms, null);
  });

  test("the default threshold is the measured two hours", () => {
    // Justified by 103 consecutive hours of measured capture whose quietest
    // hour still carried 600 requests -- see the constant's own comment.
    assert.equal(RPC_USAGE_STALENESS_THRESHOLD_MS, 2 * 60 * 60 * 1000);
  });
});

/** A query seam returning one canned `latest` (in AE's seconds). */
function queryReturning(rows: Row[] | null) {
  const seen: string[] = [];
  const query = (async (_env: unknown, sql: string) => {
    seen.push(sql);
    return rows;
  }) as never;
  return { query, seen };
}

function collector() {
  const alerts: Row[] = [];
  return {
    alerts,
    recordException: (async (_env: unknown, event: Row) => {
      alerts.push(event);
      return true;
    }) as never,
  };
}

describe("runRpcUsageStalenessWatchdog", () => {
  test("a fresh lane alerts nothing and still reports its age", async () => {
    const { alerts, recordException } = collector();
    const result = await runRpcUsageStalenessWatchdog(ENV, {
      now: () => NOW,
      recordException,
      query: queryReturning([{ latest: (NOW - MINUTE) / 1000 }]).query,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.equal(result.age_ms, MINUTE);
    assert.equal(alerts.length, 0, "zero alerts is the correct steady state");
  });

  test("a stalled lane records exactly one exception per tick", async () => {
    const { alerts, recordException } = collector();
    const result = await runRpcUsageStalenessWatchdog(ENV, {
      now: () => NOW,
      recordException,
      query: queryReturning([{ latest: (NOW - 5 * 60 * MINUTE) / 1000 }]).query,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "stale");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.route, "watchdog:rpc-usage-staleness");
    assert.equal(alerts[0]!.errorCode, "stale_lane");
    assert.match(String((alerts[0]!.error as Error).message), /300\.0 min old/);
  });

  test("an empty dataset alerts about no data points, not a 1970 age", async () => {
    // AE returns MAX() over an empty window as 0, not as a missing row, so
    // this arm is the difference between "the writer stopped" and an age
    // computed against the epoch.
    for (const rows of [[{ latest: 0 }], [{}], []]) {
      const { alerts, recordException } = collector();
      const result = await runRpcUsageStalenessWatchdog(ENV, {
        now: () => NOW,
        recordException,
        query: queryReturning(rows).query,
      });
      assert.equal(result.reason, "no_rows");
      assert.equal(result.age_ms, null);
      assert.equal(alerts.length, 1);
      assert.match(
        String((alerts[0]!.error as Error).message),
        /no data points in the last 24h/,
      );
    }
  });

  test("the freshness query is bounded, not a full-retention scan", async () => {
    // A lane dead for weeks must still cost one cheap query rather than a
    // scan across AE's whole three-month retention to confirm what the first
    // hour already showed.
    const { query, seen } = queryReturning([{ latest: NOW / 1000 }]);
    await runRpcUsageStalenessWatchdog(ENV, {
      now: () => NOW,
      recordException: (async () => true) as never,
      query,
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /FROM rpc_proxy_events/);
    assert.match(seen[0]!, /timestamp > now\(\) - INTERVAL '24' HOUR/);
    assert.match(seen[0]!, /toUnixTimestamp\(max\(timestamp\)\) AS latest/);
  });

  test("an env override replaces the default threshold", async () => {
    const result = await runRpcUsageStalenessWatchdog(
      {
        ...ENV,
        RPC_USAGE_STALENESS_THRESHOLD_MS: String(10 * MINUTE),
      } as unknown as Env,
      {
        now: () => NOW,
        recordException: (async () => true) as never,
        query: queryReturning([{ latest: (NOW - 30 * MINUTE) / 1000 }]).query,
      },
    );
    assert.equal(result.threshold_ms, 10 * MINUTE);
    assert.equal(result.alerted, true);
  });

  test("no read token is a missed report, not an hourly false alarm", async () => {
    // A deployment that cannot see the writer must not claim the writer
    // stopped -- alerting every hour on "I have no credential" would train
    // whoever watches the channel to ignore the real thing.
    let asked = false;
    const query = (async () => {
      asked = true;
      return [];
    }) as never;
    assert.deepEqual(await runRpcUsageStalenessWatchdog(null, { query }), {
      ok: false,
      reason: "analytics sql not configured",
    });
    assert.deepEqual(
      await runRpcUsageStalenessWatchdog({} as unknown as Env, { query }),
      { ok: false, reason: "analytics sql not configured" },
    );
    assert.equal(asked, false);
  });

  test("a failed query is reported once, by the client, not alerted twice", async () => {
    // The SQL client already sends its own exception; a second alert here
    // would double-report one fault, and "the query failed" is a different
    // claim from "the lane is stale".
    const { alerts, recordException } = collector();
    const result = await runRpcUsageStalenessWatchdog(ENV, {
      now: () => NOW,
      recordException,
      query: queryReturning(null).query,
    });
    assert.deepEqual(result, { ok: false, reason: "query_failed" });
    assert.equal(alerts.length, 0);
  });

  test("defaults to the real recorder and client when no seam is injected", async () => {
    // Unconfigured telemetry makes recordExceptionEvent a no-op returning
    // false; an unconfigured AE token makes the client decline. The tick
    // still completes and still reports.
    const result = await runRpcUsageStalenessWatchdog(null);
    assert.equal(result.ok, false);
  });
});
