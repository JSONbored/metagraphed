// The alarm for the projection lanes (#9423).
//
// This watchdog exists because of what happened WITHOUT one. Two lanes --
// chain-stake-moves and chain-stake-transfers -- stopped writing on
// 2026-08-03T09:13 and nothing noticed for 31 hours. The read path degraded
// exactly as designed: a lane that cannot compute leaves the previous artifact
// in place, so the routes kept answering 200 off a card whose newest event was
// 44 hours old, under a `7d` window label, with no degraded marker. Found by
// reading R2 object timestamps by hand, not by anything going red.
//
// LEAVING THE PREVIOUS ARTIFACT IS RIGHT; NOT NOTICING IS NOT. The all-or-
// nothing write is what stops one failed query from replacing real numbers
// with a plausible-looking blank. What was missing is the other half: someone
// asking how long that has been going on.
//
// Same shape as src/nominator-positions-staleness-watchdog.ts deliberately --
// a pure rule, a summary rather than a throw, and one exception event per
// stale tick. Zero alerts is the correct steady state.

import { DEFAULT_CHAIN_NETWORK, projectionKey } from "./chain-network.ts";
import { PROJECTION_LANES, PROJECTION_NETWORKS } from "./projection-lanes.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { PROJECTION_LANES_CRON } from "../workers/config.ts";

/**
 * The shortest gap between two ticks of a `minute-list * * * *` cron.
 *
 * The producer's cadence is already stated once, in PROJECTION_LANES_CRON.
 * Restating it here as a wall-clock number would be a second copy that goes
 * silently wrong the moment the cron changes -- and "silently wrong" for a
 * staleness threshold means either an alarm that never fires or one that
 * always does. Reading it from the cron means the bound follows its producer
 * by construction.
 *
 * The SHORTEST gap, not the average: an uneven minute list (say `5,10,50`)
 * has ticks 5 and 40 minutes apart, and a healthy lane must clear the bound
 * on the wide gap, so only the narrow one tells you what a tick is worth.
 */
export function cronIntervalMs(cron: string): number | null {
  const fields = cron
    .split(" ")[0]!
    .split(",")
    .map((p) => p.trim());
  // Every field must be a bare minute. An empty string coerces to 0 through
  // Number(), so it is rejected explicitly rather than read as "on the hour" --
  // a malformed cron must yield null, not a plausible interval.
  if (fields.some((f) => !/^\d+$/.test(f))) return null;
  const minutes = fields.map(Number);
  if (minutes.some((m) => m > 59)) return null;
  if (minutes.length === 1) return 60 * 60_000;
  const sorted = [...minutes].sort((a, b) => a - b);
  const gaps = sorted.map((m, i) =>
    i === 0 ? m + 60 - sorted[sorted.length - 1]! : m - sorted[i - 1]!,
  );
  return Math.min(...gaps) * 60_000;
}

/**
 * How many consecutive ticks a lane may miss before it is a stall.
 *
 * This is the one genuine judgement in the module, so it is expressed in the
 * unit the judgement is actually about -- MISSED TICKS -- rather than baked
 * into a wall-clock constant that has to be re-derived by hand whenever the
 * producer's cadence moves.
 *
 * Eight, because a healthy lane's age swings across its whole producer
 * interval (the sizing rule #9301 corrected the nominator-positions threshold
 * for), so anything near one interval alerts on a lane that is working. Eight
 * clears a run that overruns its own window, a redeploy, and ordinary cron
 * jitter, while still catching a dead lane inside hours rather than never --
 * the 31-hour silence that produced #9423 would have been caught on its
 * fourth hour.
 */
export const PROJECTION_STALENESS_MISSED_TICKS = 8;

/**
 * How stale a projection may get before it is a stall: eight missed ticks of
 * whatever cadence the lane cron currently declares.
 *
 * Overridable per-deployment via PROJECTION_STALENESS_THRESHOLD_MS, so an
 * operator can tighten or loosen it without a code deploy.
 */

/**
 * The bound for a given producer cron.
 *
 * The fallback covers a cron this parser cannot read -- a step form such as
 * "every fifth minute", say. Half an hour is not a guess at that cron's
 * cadence: it is the cadence the lane cron has always had, kept as the
 * conservative floor so an unparseable cron degrades to today's bound rather
 * than to no bound at all.
 */
export function projectionStalenessThresholdMs(cron: string): number {
  return (
    PROJECTION_STALENESS_MISSED_TICKS * (cronIntervalMs(cron) ?? 30 * 60_000)
  );
}

export const PROJECTION_STALENESS_THRESHOLD_MS = projectionStalenessThresholdMs(
  PROJECTION_LANES_CRON,
);

export interface ProjectionStalenessEntry {
  /** `<lane>` on mainnet, `<lane>:<network>` elsewhere -- the same labelling
   * runProjectionLanes uses, so an alert and a run summary name one thing. */
  lane: string;
  stale: boolean;
  reason: "absent" | "unreadable" | "stale" | null;
  age_ms: number | null;
  generated_at: string | null;
}

export interface ProjectionStalenessVerdict {
  stale: boolean;
  threshold_ms: number;
  checked: number;
  stale_lanes: string[];
  entries: ProjectionStalenessEntry[];
}

/** The rule alone, testable without a bucket or a clock. */
export function evaluateProjectionStaleness(input: {
  artifacts: { lane: string; generatedAt: string | null | undefined }[];
  nowMs: number;
  thresholdMs: number;
}): ProjectionStalenessVerdict {
  const { artifacts, nowMs, thresholdMs } = input;
  const entries = artifacts.map(({ lane, generatedAt }) => {
    if (generatedAt == null) {
      // An artifact that is not there at all is a stall of infinite age, not a
      // quiet lane: every lane in the registry is supposed to have written on
      // the last tick, and a route over a missing card serves its zeroed floor.
      return {
        lane,
        stale: true,
        reason: "absent" as const,
        age_ms: null,
        generated_at: null,
      };
    }
    const at = Date.parse(generatedAt);
    if (!Number.isFinite(at)) {
      // A body whose timestamp cannot be read is worse than a missing one: the
      // route is serving it, and nothing can say how old it is.
      return {
        lane,
        stale: true,
        reason: "unreadable" as const,
        age_ms: null,
        generated_at: generatedAt,
      };
    }
    const age = nowMs - at;
    return {
      lane,
      stale: age > thresholdMs,
      reason: age > thresholdMs ? ("stale" as const) : null,
      age_ms: age,
      generated_at: generatedAt,
    };
  });
  const staleLanes = entries.filter((e) => e.stale).map((e) => e.lane);
  return {
    stale: staleLanes.length > 0,
    threshold_ms: thresholdMs,
    checked: entries.length,
    stale_lanes: staleLanes,
    entries,
  };
}

interface ProjectionBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export interface ProjectionStalenessDeps {
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified -- the distinction #9330/#9340 exist about. */
  laneHealthDb?: LaneHealthDb | null;
}

/** Every lane x every network, labelled the way the runner labels them. */
function watchedLanes(): { lane: string; key: string }[] {
  return PROJECTION_NETWORKS.flatMap((network) =>
    PROJECTION_LANES.map((lane) => ({
      lane:
        network === DEFAULT_CHAIN_NETWORK
          ? lane.name
          : `${lane.name}:${network}`,
      key: projectionKey(lane.artifactKey, network),
    })),
  );
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an outage,
 * and a cron that throws is a cron nobody can read the result of.
 */
export async function runProjectionStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: ProjectionStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ProjectionBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return { ok: false, reason: "r2 binding unavailable" };

  const thresholdMs =
    Number(env?.PROJECTION_STALENESS_THRESHOLD_MS) ||
    PROJECTION_STALENESS_THRESHOLD_MS;

  const artifacts: { lane: string; generatedAt: string | null }[] = [];
  for (const { lane, key } of watchedLanes()) {
    let generatedAt: string | null;
    try {
      const object = await bucket.get(key);
      const body = object ? ((await object.json()) as unknown) : null;
      const value = (body as { generated_at?: unknown } | null)?.generated_at;
      generatedAt = typeof value === "string" ? value : null;
    } catch {
      // An unreadable object is reported as absent rather than skipped: a
      // watchdog that quietly drops what it could not read is a watchdog that
      // reports healthy on exactly the lanes worth worrying about.
      generatedAt = null;
    }
    artifacts.push({ lane, generatedAt });
  }

  const verdict = evaluateProjectionStaleness({
    artifacts,
    nowMs: now(),
    thresholdMs,
  });

  if (verdict.stale) {
    // ONE event naming every stale lane, not one per lane: twenty-six alerts
    // for one dead cron is the failure mode where an alarm stops being read.
    const detail = verdict.entries
      .filter((entry) => entry.stale)
      .map(
        (entry) =>
          `${entry.lane} (${
            entry.age_ms === null
              ? entry.reason
              : `${(entry.age_ms / 3_600_000).toFixed(1)} h old`
          })`,
      )
      .join(", ");
    await record(env as never, {
      error: new Error(
        `projection lanes stalled: ${detail} (threshold ${(
          thresholdMs / 3_600_000
        ).toFixed(
          1,
        )} h, ${PROJECTION_STALENESS_MISSED_TICKS} missed ticks of ${PROJECTION_LANES_CRON}) -- the routes over these are answering from a card nothing is refreshing`,
      ),
      route: "watchdog:projection-staleness",
      errorCode: "stale_lane",
    }).catch(() => false);
  }

  // #9330/#9340: the DURABLE record, written every tick rather than only when
  // stale. This watchdog shipped notifying through `recordExceptionEvent`
  // alone -- the exact channel that has already discarded three outages, since
  // PostHog drops `$exception` once the free-tier quota is exhausted and this
  // project runs at roughly 1M events/day. A dropped notification is
  // indistinguishable from a fleet that was fine.
  //
  // It matters more here than for its siblings, not less: this is the only
  // watchdog covering 26 lanes, and its healthy output is silence. Without a
  // row per tick there is nothing anywhere that distinguishes "every
  // projection was fresh" from "the watchdog has not run since the deploy".
  //
  // Never throws -- see recordLaneVerdict.
  await recordLaneVerdict(
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as never),
    {
      lane: "projection-staleness",
      verdict: verdict.stale ? "stale" : "ok",
      // The OLDEST lane's age, since one stale lane is a stale fleet and that
      // is the number worth keeping a history of.
      age_ms: verdict.entries.reduce<number | null>(
        (oldest, entry) =>
          entry.age_ms === null ? oldest : Math.max(oldest ?? 0, entry.age_ms),
        null,
      ),
      detail: verdict.stale ? verdict.stale_lanes.join(",") : null,
      checked_at: now(),
    },
  );

  return { ok: true, ...verdict };
}
