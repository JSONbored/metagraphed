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
// AND THE OPPOSITE SHAPE, which the age check cannot see (#11406's aftermath).
// A lane that runs on time and computes ZERO rows overwrites the good artifact
// with an empty one, so `generated_at` never ages and this watchdog reported
// `ok` every 30 minutes for a day while the site's 24h on-chain volume showed
// an em-dash. The all-or-nothing contract only covers a FAILED query (`null`);
// an empty answer (`[]`) is stored, and of the thirteen lanes only
// computeBlocksSummary declines to store it. So freshness is not coverage, and
// `evaluateProjectionStaleness` now reads `row_count` as well as the timestamp.
//
// Same shape as src/nominator-positions-staleness-watchdog.ts deliberately --
// a pure rule, a summary rather than a throw, and one exception event per
// stale tick. Zero alerts is the correct steady state.

import { type ArtifactStoreEnv, artifactBucket } from "./projection-store.ts";

import { ProjectionArtifactEnvelopeSchema } from "../schemas-src/artifacts/projection-envelope.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { DEFAULT_CHAIN_NETWORK, projectionKey } from "./chain-network.ts";
import { PROJECTION_LANES, PROJECTION_NETWORKS } from "./projection-lanes.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { PROJECTION_LANES_CRON } from "../workers/config.ts";
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
type ProjectionStalenessWatchdogEnv = StoreEnv &
  TelemetryEnv &
  // Declared rather than cast to: this watchdog reads every lane's artifact.
  ArtifactStoreEnv & {
    PROJECTION_STALENESS_THRESHOLD_MS?: unknown;
  };

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
  reason: "absent" | "unreadable" | "stale" | "empty" | null;
  age_ms: number | null;
  generated_at: string | null;
  /** Rows the lane last computed, or null when the artifact does not say. */
  row_count: number | null;
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
  artifacts: {
    lane: string;
    generatedAt: string | null | undefined;
    /** `row_count` from the artifact body; absent/unreadable => null. */
    rowCount?: number | null;
    /**
     * Whether ZERO rows is a fault for this lane. Defaults true so the rule is
     * unchanged for any caller that does not express an opinion; `watchedLanes`
     * sets it false for non-default networks, where an idle day is normal.
     */
    emptyIsFault?: boolean;
  }[];
  nowMs: number;
  thresholdMs: number;
}): ProjectionStalenessVerdict {
  const { artifacts, nowMs, thresholdMs } = input;
  const entries = artifacts.map(
    ({ lane, generatedAt, rowCount, emptyIsFault }) => {
      const rows = typeof rowCount === "number" ? rowCount : null;
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
          row_count: rows,
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
          row_count: rows,
        };
      }
      const age = nowMs - at;
      if (age > thresholdMs) {
        return {
          lane,
          stale: true,
          reason: "stale" as const,
          age_ms: age,
          generated_at: generatedAt,
          row_count: rows,
        };
      }
      // FRESH BUT EMPTY -- the failure this watchdog could not see.
      //
      // The module header says it exists because two lanes "stopped writing".
      // This is the opposite shape and the age check cannot reach it: the lane
      // runs on time, computes zero rows, and overwrites a good artifact with an
      // empty one, so `generated_at` stays minutes old forever while every route
      // over the card serves its zeroed floor.
      //
      // MEASURED 2026-08-16: `metagraph/projections/chain-alpha-volume.json` read
      // `{generated_at: "…11:46:31Z", row_count: 0, windows: {24h: {rows: []}}}`
      // -- minutes old -- because its rolling 24h window queried a lakehouse
      // whose newest data was ~29h back, so no row it could return existed. The
      // site's 24h on-chain volume showed an em-dash for a day and this watchdog
      // reported `ok` every 30 minutes throughout.
      //
      // ONLY AN EXPLICIT ZERO, never a missing field: an artifact that does not
      // report `row_count` is not making a claim about its own coverage, and
      // treating silence as zero would fire this on every lane whose envelope
      // predates the field.
      //
      // These lanes are rolling-window aggregates over a chain producing a block
      // every 12s, so zero rows in the window is not a quiet period -- it means
      // the window and the data no longer overlap. A lane that CAN legitimately
      // be empty should be exempted by name, with the reason written down, rather
      // than by weakening this into a rule that cannot fire.
      if (rows === 0 && emptyIsFault !== false) {
        return {
          lane,
          stale: true,
          reason: "empty" as const,
          age_ms: age,
          generated_at: generatedAt,
          row_count: 0,
        };
      }
      return {
        lane,
        stale: false,
        reason: null,
        age_ms: age,
        generated_at: generatedAt,
        row_count: rows,
      };
    },
  );
  const staleLanes = entries.filter((e) => e.stale).map((e) => e.lane);
  return {
    stale: staleLanes.length > 0,
    threshold_ms: thresholdMs,
    checked: entries.length,
    stale_lanes: staleLanes,
    entries,
  };
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
function watchedLanes(): {
  lane: string;
  key: string;
  emptyIsFault: boolean;
}[] {
  return PROJECTION_NETWORKS.flatMap((network) =>
    PROJECTION_LANES.map((lane) => ({
      lane:
        network === DEFAULT_CHAIN_NETWORK
          ? lane.name
          : `${lane.name}:${network}`,
      key: projectionKey(lane.artifactKey, network),
      // ZERO ROWS IS A FAULT ON MAINNET ONLY, and the difference is not a
      // narrowing to make an alarm quieter -- it is the claim the rule makes.
      //
      // "Empty means broken" says the chain produces enough activity that an
      // empty window cannot be real. That holds for mainnet: a block every 12s
      // with continuous staking, where 24h of zero stake events would itself be
      // the incident. It does not hold for a TEST chain, which is allowed to be
      // idle for a day and frequently is.
      //
      // Measured 2026-08-16, the tick after this rule shipped: it flagged
      // `chain-alpha-volume:testnet`, whose artifact was fresh (12:24) with
      // `row_count: 0` -- a quiet test chain, not a broken lane. A rule that
      // stands permanently on testnet is how the whole lane becomes wallpaper,
      // which costs more than the coverage it buys.
      //
      // Testnet keeps every OTHER rule: absent, unreadable and stale-by-age all
      // still fire, and `chain-stake-moves:testnet` was correctly flagged for
      // age in that same tick.
      // ...unless the LANE says its empty is correct and permanent. That is a
      // narrower claim than the network rule and is made per lane, with the
      // reason at the declaration -- see ProjectionLane.emptyIsExpected.
      emptyIsFault:
        network === DEFAULT_CHAIN_NETWORK && lane.emptyIsExpected !== true,
    })),
  );
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an outage,
 * and a cron that throws is a cron nobody can read the result of.
 */
export async function runProjectionStalenessWatchdog(
  env: ProjectionStalenessWatchdogEnv | null | undefined,
  deps: ProjectionStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = artifactBucket(env);
  if (!bucket) return { ok: false, reason: "r2 binding unavailable" };

  const thresholdMs =
    Number(env?.PROJECTION_STALENESS_THRESHOLD_MS) ||
    PROJECTION_STALENESS_THRESHOLD_MS;

  const artifacts: {
    lane: string;
    generatedAt: string | null;
    rowCount: number | null;
    emptyIsFault: boolean;
  }[] = [];
  for (const { lane, key, emptyIsFault } of watchedLanes()) {
    let generatedAt: string | null;
    let rowCount: number | null;
    try {
      const object = await bucket.get(key);
      const body = object ? await object.json() : null;
      // PARSED, not cast (#11194's rule, one boundary further out). The cast
      // this replaces typed the access without checking a byte of it, and these
      // bodies come out of R2 written by whatever deploy was live at the time.
      // Both fields come off ONE parse of the SAME body, so the count and the
      // timestamp can never describe two different objects, and a malformed
      // field lands as null through the schema's own `.catch` rather than
      // through a typeof check restated at each read site.
      const envelope = ProjectionArtifactEnvelopeSchema.safeParse(body);
      generatedAt = envelope.success
        ? (envelope.data.generated_at ?? null)
        : null;
      rowCount = envelope.success ? (envelope.data.row_count ?? null) : null;
    } catch {
      // An unreadable object is reported as absent rather than skipped: a
      // watchdog that quietly drops what it could not read is a watchdog that
      // reports healthy on exactly the lanes worth worrying about.
      generatedAt = null;
      rowCount = null;
    }
    artifacts.push({ lane, generatedAt, rowCount, emptyIsFault });
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
      .map((entry) => {
        // An EMPTY lane is fresh, so reporting its age would say "0.2 h old"
        // about the one entry whose age is not the problem. Each reason states
        // the fact that made it stale.
        if (entry.reason === "empty") return `${entry.lane} (fresh, 0 rows)`;
        if (entry.age_ms === null) return `${entry.lane} (${entry.reason})`;
        return `${entry.lane} (${(entry.age_ms / 3_600_000).toFixed(1)} h old)`;
      })
      .join(", ");
    await record(env, {
      error: new Error(
        `projection lanes stalled: ${detail} (threshold ${(
          thresholdMs / 3_600_000
        ).toFixed(
          1,
        )} h, ${PROJECTION_STALENESS_MISSED_TICKS} missed ticks of ${PROJECTION_LANES_CRON}) -- the routes over these are answering from a card that is either not being refreshed or is being refreshed with nothing`,
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
  await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
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
  });

  return { ok: true, ...verdict };
}
