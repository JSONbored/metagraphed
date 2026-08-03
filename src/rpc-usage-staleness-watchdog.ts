// The alarm for the RPC reverse-proxy's usage-capture lane (#9228).
//
// This watchdog exists because of how #9228 was found: not by an alert, but
// by someone adding `?window=7d` to a route that had been answering happily
// for days from a frozen lakehouse snapshot. The proxy was healthy, the
// endpoint was healthy, the payload was well-formed and internally
// consistent -- and completely historical. A correct-looking answer over data
// that stopped advancing is the failure mode here, and nothing about the
// answer itself can reveal it. Only its age can.
//
// So this reads one number: how long ago the newest captured data point was
// written. Modelled on src/neurons-staleness-watchdog.ts, including its "zero
// alerts is the correct steady state" posture -- a stale verdict records ONE
// exception event per tick (route watchdog:rpc-usage-staleness), and the cron
// summary carries the age either way so a healthy check stays legible.
//
// It watches the WRITER, not the route. Moving to Analytics Engine removed
// several ways the writer could break (no table to drop, no prune to
// misfire, no retention to size) but not the ones that actually caused this
// outage: a binding that is not deployed, a dataset renamed out from under
// the query, an index that exceeds AE's 96-byte ceiling and gets every point
// rejected, or a code path that simply stops calling writeDataPoint. Every
// one of those looks identical from the reading end -- a healthy route over
// data that has stopped advancing.
import { recordExceptionEvent } from "./usage-telemetry.ts";
import {
  analyticsSqlQuery,
  isAnalyticsSqlConfigured,
} from "./analytics-engine-sql.ts";
import { RPC_USAGE_DATASET } from "./rpc-usage-capture.ts";

/**
 * Two hours without a single captured request.
 *
 * MEASURED, not guessed. Over the 103 consecutive hours of capture before it
 * stopped (2026-07-30T00:00Z -> 2026-08-02T18:00Z, read back from the
 * lakehouse copy) there was not one empty hour: the quietest hour carried 600
 * requests, the mean 5,373, the busiest 8,059. At that floor a fully silent
 * hour is already anomalous rather than quiet. Two hours is that observation
 * plus one tick of margin for a deploy, an isolate eviction, or cron skew --
 * the same "n missed ticks, not one" reasoning behind the neurons lane's
 * three 15-minute ticks. The watchdog runs on the hourly maintenance cron, so
 * real detection lands 2-3 hours after a writer stops, against the day-plus
 * this outage actually ran for.
 */
export const RPC_USAGE_STALENESS_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** How far back the freshness query looks. Bounded so a lane that has been
 * dead for weeks still runs a cheap query rather than scanning AE's whole
 * three-month retention to confirm what the first hour already showed. */
const LOOKBACK_HOURS = 24;

export interface RpcUsageStalenessVerdict {
  stale: boolean;
  reason: "no_rows" | "stale" | null;
  age_ms: number | null;
  latest_observed_at: number | null;
  threshold_ms: number;
}

/** The rule alone, testable without a query engine or a clock. */
export function evaluateRpcUsageStaleness(input: {
  latestObservedAtMs: number | null;
  nowMs: number;
  thresholdMs: number;
}): RpcUsageStalenessVerdict {
  const { latestObservedAtMs, nowMs, thresholdMs } = input;
  if (latestObservedAtMs === null) {
    // No data point inside the lookback is a stall, not a healthy quiet
    // window -- and it is precisely the state production was in when #9228
    // was filed.
    return {
      stale: true,
      reason: "no_rows",
      age_ms: null,
      latest_observed_at: null,
      threshold_ms: thresholdMs,
    };
  }
  const age = nowMs - latestObservedAtMs;
  return {
    stale: age > thresholdMs,
    reason: age > thresholdMs ? "stale" : null,
    age_ms: age,
    latest_observed_at: latestObservedAtMs,
    threshold_ms: thresholdMs,
  };
}

export interface RpcUsageStalenessDeps {
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
  /** Query seam for tests; defaults to the real AE SQL client. */
  query?: typeof analyticsSqlQuery;
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an
 * outage, and a cron that throws is a cron nobody can read the result of.
 */
export async function runRpcUsageStalenessWatchdog(
  env: Env | null | undefined,
  deps: RpcUsageStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const query = deps.query ?? analyticsSqlQuery;
  // Unconfigured is a missed report, not an alert: a deployment without the
  // read token cannot distinguish "the writer stopped" from "I cannot see
  // the writer", and alerting on the second one every hour would train
  // whoever watches the channel to ignore the first.
  if (!isAnalyticsSqlConfigured(env)) {
    return { ok: false, reason: "analytics sql not configured" };
  }

  const thresholdMs =
    Number(env?.RPC_USAGE_STALENESS_THRESHOLD_MS) ||
    RPC_USAGE_STALENESS_THRESHOLD_MS;

  const rows = await query(
    env,
    `SELECT toUnixTimestamp(MAX(timestamp)) AS latest` +
      ` FROM ${RPC_USAGE_DATASET}` +
      ` WHERE timestamp > NOW() - INTERVAL '${LOOKBACK_HOURS}' HOUR`,
  );
  // The client already reported the failure to the exception channel; a
  // second alert here would double-report one fault, and "the query failed"
  // is a different claim from "the lane is stale".
  if (!rows) return { ok: false, reason: "query_failed" };

  const latestSeconds = Number(rows[0]?.latest);
  const verdict = evaluateRpcUsageStaleness({
    // AE returns MAX() over an empty window as 0 (and toUnixTimestamp of the
    // zero DateTime likewise), not as a missing row -- so zero/non-finite is
    // the "no data points" signal here, not a 1970 timestamp to compute an
    // age against.
    latestObservedAtMs:
      Number.isFinite(latestSeconds) && latestSeconds > 0
        ? latestSeconds * 1000
        : null,
    nowMs: now(),
    thresholdMs,
  });
  if (verdict.stale) {
    const age =
      verdict.age_ms === null
        ? `no data points in the last ${LOOKBACK_HOURS}h`
        : `${(verdict.age_ms / 60_000).toFixed(1)} min old`;
    await record(env, {
      error: new Error(
        `rpc-usage capture stalled: newest proxied-request data point is ` +
          `${age} (threshold ${thresholdMs / 60_000} min) -- ` +
          `/api/v1/rpc/usage is answering from data that stopped advancing`,
      ),
      route: "watchdog:rpc-usage-staleness",
      errorCode: "stale_lane",
    });
  }
  // `ok` describes whether the TICK ran, not whether the lane is fresh.
  return { ok: true, alerted: verdict.stale, ...verdict };
}
