// The alarm for the chain-detail LIVE-FOLLOW lane (#9208).
//
// Modelled on src/neurons-staleness-watchdog.ts, and for the same reason it was
// written: when a live lane stops advancing, every route over it keeps serving
// healthy-looking 200s from an aging window, and nobody finds out. The neurons
// lane's first stall (2026-08-03, a zombie container instance reporting
// "running" with healthy:0) went three hours with no alert at all.
//
// THIS LANE FAILS MORE QUIETLY THAN THAT ONE, which is why it needs the alarm
// more. A stalled neurons lane serves stale numbers -- wrong, but visibly
// dated. A stalled chain-detail lane serves 503 declines for recent blocks,
// which is honest per-request and completely silent in aggregate: the block
// list stays live, the drill-down starts refusing, and unless somebody clicks a
// recent block and reports it, the lane can be dead for a day. The decline is
// the correct ANSWER; it is not a signal.
//
// WHAT "ADVANCING" MEANS HERE. The lane follows the finalized head at ~12s per
// block and POSTs every 2 blocks, so the freshest thing it writes is the
// `observed_at` of the newest block in `chain_detail_blocks`. That is the
// chain's own clock as the poller saw it, not our write clock, so it measures
// the lane end to end -- a poller that keeps POSTing the same two blocks
// forever does not advance it.
//
// Zero alerts is the correct steady state. A stale verdict records ONE
// exception event per tick (route watchdog:chain-detail-staleness), which is
// the project's alert channel; the cron summary carries the age either way so a
// healthy check is still legible.

import { recordExceptionEvent } from "./usage-telemetry.ts";

/**
 * How far behind the lane may fall before this is a stall.
 *
 * The lane's own cadence is ~24s (2 blocks per POST at 12s blocks), so a
 * threshold near it would fire on every container restart and every transient
 * RPC hiccup -- noise that trains people to ignore the channel. 20 minutes is
 * instead sized against the thing that MATTERS: the hourly decode lane means
 * the lakehouse is up to ~1h behind, and the hot tier is what covers that gap.
 * A lane 20 minutes behind still has the gap covered and is merely late; a lane
 * further behind than that is on its way to a coverage hole, and this is the
 * only warning before recent blocks start declining.
 */
export const CHAIN_DETAIL_STALENESS_THRESHOLD_MS = 20 * 60 * 1000;

export interface ChainDetailStalenessVerdict {
  stale: boolean;
  reason: "no_rows" | "stale" | null;
  age_ms: number | null;
  latest_observed_at: number | null;
  head_block: number | null;
  threshold_ms: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateChainDetailStaleness(input: {
  latestObservedAtMs: number | null;
  headBlock: number | null;
  nowMs: number;
  thresholdMs: number;
}): ChainDetailStalenessVerdict {
  const { latestObservedAtMs, headBlock, nowMs, thresholdMs } = input;
  if (latestObservedAtMs === null) {
    // An empty tier is a stall of infinite age, not a healthy quiet one: this
    // lane has no idle state, because the chain never stops producing blocks.
    return {
      stale: true,
      reason: "no_rows",
      age_ms: null,
      latest_observed_at: null,
      head_block: headBlock,
      threshold_ms: thresholdMs,
    };
  }
  const age = nowMs - latestObservedAtMs;
  return {
    stale: age > thresholdMs,
    reason: age > thresholdMs ? "stale" : null,
    age_ms: age,
    latest_observed_at: latestObservedAtMs,
    head_block: headBlock,
    threshold_ms: thresholdMs,
  };
}

interface D1Like {
  prepare(sql: string): { first(): Promise<unknown> };
}

export interface ChainDetailStalenessDeps {
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

function toInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an outage,
 * and a cron that throws is a cron nobody can read the result of.
 */
export async function runChainDetailStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: ChainDetailStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = env?.METAGRAPH_HEALTH_DB as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1 binding unavailable" };

  const thresholdMs =
    Number(env?.CHAIN_DETAIL_STALENESS_THRESHOLD_MS) ||
    CHAIN_DETAIL_STALENESS_THRESHOLD_MS;

  try {
    const row = (await db
      .prepare(
        "SELECT MAX(observed_at) AS latest, MAX(block_number) AS head " +
          "FROM chain_detail_blocks",
      )
      .first()) as { latest?: unknown; head?: unknown } | null;
    const verdict = evaluateChainDetailStaleness({
      latestObservedAtMs: toInt(row?.latest),
      headBlock: toInt(row?.head),
      nowMs: now(),
      thresholdMs,
    });
    if (verdict.stale) {
      const age =
        verdict.age_ms === null
          ? "no blocks at all"
          : `${(verdict.age_ms / 60_000).toFixed(1)} min behind`;
      await record(env as never, {
        error: new Error(
          `chain-detail lane stalled: the live-follow window is ${age} ` +
            `(threshold ${thresholdMs / 60_000} min, head block ` +
            `${verdict.head_block ?? "none"}) -- recent blocks will start ` +
            `declining drill-down once the gap outruns the decode seam`,
        ),
        route: "watchdog:chain-detail-staleness",
        errorCode: "stale_lane",
      }).catch(() => false);
    }
    // `ok` describes whether the TICK ran, not whether the lane is fresh.
    return { ok: true, alerted: verdict.stale, ...verdict };
  } catch (err) {
    return {
      ok: false,
      reason: "query_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
