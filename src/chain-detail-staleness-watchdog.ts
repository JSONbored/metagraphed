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

import { laneHealthStore } from "./lane-health-store.ts";
import { laneVerdictDetail } from "./lane-verdict-detail.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { readStore, safeIntOrNull } from "./read-store.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";

/**
 * What this module reads from its environment, and nothing else.
 *
 * Named rather than left as `Record<string, unknown>` (#11339): a Record
 * READS as loose but is not, because `Env` is an interface and TypeScript
 * never gives interfaces implicit index signatures -- so every caller
 * holding a real `Env` wrote `env as unknown as Record<string, unknown>`
 * to get past it. Listing the keys costs nothing and states the contract.
 */
type ChainDetailStalenessWatchdogEnv = StoreEnv &
  TelemetryEnv & {
    CHAIN_DETAIL_STALENESS_THRESHOLD_MS?: unknown;
  };

/**
 * How far behind the lane may fall before this is a stall.
 *
 * ## Why this is five minutes and not twenty (metagraphed-infra#492)
 *
 * Twenty was sized against the DOWNSTREAM consumer, and that argument is still
 * sound: the hourly decode lane leaves the lakehouse up to ~1h behind, the hot
 * tier covers that gap, and a lane further behind than twenty minutes is on its
 * way to a coverage hole. Nothing here contradicts it -- five minutes fires
 * strictly earlier, so the coverage bound is still honoured.
 *
 * What twenty could not do is REPORT A STALL. Measured on production
 * 2026-08-18 over the lane's full retained window (1,858 writes, 6.2h): the
 * chain-detail lane stopped dead for 15m 06s -- last write 01:23:36Z, nothing
 * until 01:38:42Z, then ~76 blocks drained in 167s. Head age reached 15m 30s.
 * Against a twenty-minute floor that stall could not fire, and did not. A
 * caller asking for a fifteen-minute-old block got a confident "not found"
 * and nothing recorded it.
 *
 * ## The noise argument was the right question and now has an answer
 *
 * The bound this replaces feared that a tighter threshold "would fire on every
 * container restart and every transient RPC hiccup". Measured rather than
 * assumed, over the same window:
 *
 *   inter-write gap   p50 12.0s   p99 22.3s   p99.9 23.3s   max 906.6s
 *   gaps over 60s     EXACTLY ONE, and it is the stall above
 *
 * The distribution is bimodal with nothing at all between 23.3s and 906.6s.
 * Worst normal head age is ~63s (p95 write latency 40s plus a p99.9 gap), so
 * five minutes is 4.8x clear of it and had zero false positives across the
 * window. Transients do not reach it; the one thing that did was a real stall.
 *
 * ## What five minutes does NOT buy, stated so it is not mistaken for more
 *
 * `staleness-watchdog-heartbeat.ts` runs this on a QUARTER-HOURLY grid and
 * `everyMinutes` quantises UP to it, so detection is bounded by the tick, not
 * by this number. Head age exceeds five minutes for roughly ten of a fifteen
 * minute stall, so a tick catches it about two thirds of the time -- against
 * never, at twenty. Catching a stall SHORTER than the grid reliably is a
 * question about the grid, and the grid is quarter-hourly for reasons
 * documented in that file. This is the half that was free.
 *
 * Env-overridable via CHAIN_DETAIL_STALENESS_THRESHOLD_MS, so returning to
 * twenty needs no deploy.
 */
// NOT DERIVED FROM THIS PRODUCER'S CADENCE, deliberately -- see
// src/producer-cadence.ts. The lane ticks every ~24s; this bound is a
// statement about the DOWNSTREAM consumer (the hourly decode lane's ~1h lag
// that the hot tier covers), so expressing it as N missed ticks of a 24s
// cadence would be arithmetic that means nothing. Left explicit so "not
// cadence-derived" reads as a decision rather than an oversight.
export const CHAIN_DETAIL_STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

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

/**
 * The live-follow lane's head, as one read.
 *
 * Exported because /health publishes the SAME two aggregates as its chain-event
 * heartbeat (#8700). Two copies of this SQL would let the number this endpoint
 * reports and the number the watchdog alerts on drift apart -- and they would
 * drift silently, since each looks correct on its own.
 */
export async function readChainDetailHead(
  env: ChainDetailStalenessWatchdogEnv | null | undefined,
): Promise<{ latestObservedAtMs: number | null; headBlock: number | null }> {
  const db = readStore(env, ["chain_detail_blocks"]);
  if (!db?.first) return { latestObservedAtMs: null, headBlock: null };
  const row = (await db.first(
    "SELECT MAX(observed_at) AS latest, MAX(block_number) AS head " +
      "FROM chain_detail_blocks",
  )) as { latest?: unknown; head?: unknown } | null;
  return {
    latestObservedAtMs: safeIntOrNull(row?.latest),
    headBlock: safeIntOrNull(row?.head),
  };
}

export interface ChainDetailStalenessDeps {
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified — the distinction #9330/#9340 exist about. */
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an outage,
 * and a cron that throws is a cron nobody can read the result of.
 */
export async function runChainDetailStalenessWatchdog(
  env: ChainDetailStalenessWatchdogEnv | null | undefined,
  deps: ChainDetailStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  // Whichever store holds the table (#10154). The verdict WRITE moved to
  // laneHealthStore already; this read did not, so the watchdog was measuring
  // the frozen copy D1 left and would have alarmed permanently -- reporting the lane
  // stalled while the lane was fine.
  const db = readStore(env, ["chain_detail_blocks"]);
  if (!db?.first) return { ok: false, reason: "no store bound" };

  const thresholdMs =
    Number(env?.CHAIN_DETAIL_STALENESS_THRESHOLD_MS) ||
    CHAIN_DETAIL_STALENESS_THRESHOLD_MS;

  try {
    const head = await readChainDetailHead(env);
    const verdict = evaluateChainDetailStaleness({
      ...head,
      nowMs: now(),
      thresholdMs,
    });
    if (verdict.stale) {
      const age =
        verdict.age_ms === null
          ? "no blocks at all"
          : `${(verdict.age_ms / 60_000).toFixed(1)} min behind`;
      await record(env, {
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
    // #9330/#9340: the DURABLE record, written every tick rather than only when
    // stale. PostHog stays the notification path; it is no longer the record, because
    // a dropped $exception is indistinguishable from a lane that was fine. Writing on
    // every tick is also what makes "the watchdog stopped running" visible at all.
    // Never throws -- see recordLaneVerdict.
    await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
      lane: "chain-detail-staleness",
      verdict: verdict.stale ? "stale" : "ok",
      age_ms: verdict.age_ms,
      detail: laneVerdictDetail(verdict.reason, {
        head_block: verdict.head_block,
      }),
      checked_at: now(),
    });
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
