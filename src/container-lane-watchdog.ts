// The alarm for the lanes this repo does not run.
//
// ## What went unwatched, and for how long
//
// Five lanes run inside metagraphed-infra's decode container, one after another
// in a single hourly pass: decode, the daily rollup, the state mirror, the
// account-events rollup, and the account-summary projection. Every one of them
// already publishes a status object to R2. NOTHING READ ANY OF THEM.
//
// `projection-staleness` cannot: it iterates PROJECTION_LANES, the thirteen
// lanes this Worker computes, so anything container-written is structurally
// outside it. A `lane_health` sweep on 2026-08-16 returned zero rows for
// `%summary%`, `%decode%`, `%rollup%` and `%mirror%` -- not stale rows, NO
// rows.
//
// Measured that day: the account-summary projection had not published a
// generation since 2026-08-15T06:26:33Z -- 32 hours -- while the four lanes
// either side of it in the same pass ran normally (decode 14:19:40Z, daily
// rollup 14:23:58Z, state mirror 14:26:17Z, account-events rollup 14:26:18Z).
// The cost was not abstract: `readRecent` declines without a generation
// carrying `recent_limit`, so every account request fell back to an unbounded
// lakehouse scan and /accounts/{ss58} served 503s and 8-20s responses all day.
//
// ## Why this is the systemic fix and not another patch
//
// It inverts the default. Today a lane is silent unless somebody wrote a
// watchdog aimed at it, which is how a lane nobody was thinking about goes
// dark for 32 hours. After this, any lane in the status namespace that stops
// advancing produces a `stale` verdict on the next tick, and adding a sixth
// lane to the container means adding one line here rather than remembering to
// build an alarm.
//
// ## What it deliberately does NOT do
//
// It does not read the lakehouse, the Iceberg ledger, or anything the lanes
// produce. It reads what each lane SAYS ABOUT ITSELF and how long ago it said
// it. Verifying the output is `lakehouse-seam`'s job for decode and
// `projection-staleness`'s for the Worker lanes; this answers the prior
// question those two cannot -- did the producer run at all.
import { ContainerLaneStatusSchema } from "../schemas-src/artifacts/container-lane-status.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";

type ContainerLaneWatchdogEnv = StoreEnv & TelemetryEnv;

/** One container-written lane: what to call it, and where it says how it went. */
export interface ContainerLane {
  /** The `lane_health` label. Prefixed so a sweep can name the whole family. */
  lane: string;
  /** The R2 key of its status object. */
  key: string;
}

/**
 * Every lane on metagraphed-infra's `entrypoint-decode-r2.sh`, in pass order.
 *
 * ORDER IS MEANINGFUL FOR TRIAGE and is why they are listed rather than
 * globbed: the lanes run sequentially in one pass, so a contiguous tail going
 * stale together says the pass stopped partway, while ONE stale lane between
 * two healthy ones says that lane alone is failing. The 2026-08-16 incident was
 * the second shape, and reading it off five verdicts at a glance is the point.
 */
export const CONTAINER_LANES: readonly ContainerLane[] = [
  {
    lane: "container:decode",
    key: "metagraph/lakehouse/decode-run-status.json",
  },
  {
    lane: "container:daily-rollup",
    key: "metagraph/lakehouse/daily-rollup-status.json",
  },
  {
    lane: "container:state-mirror",
    key: "metagraph/lakehouse/state-mirror-status.json",
  },
  {
    lane: "container:account-events-rollup",
    key: "metagraph/lakehouse/account-events-rollup-status.json",
  },
  {
    lane: "container:account-summary",
    key: "metagraph/lakehouse/account-summary-status.json",
  },
];

/**
 * How often the container's pass runs, as a CROSS-REPOSITORY PIN.
 *
 * The authority is `wrangler.decode-r2.jsonc`'s `"17 * * * *"` in
 * metagraphed-infra, which this repository cannot import. That makes this the
 * one number here that can silently drift, so the bound built from it is
 * deliberately generous rather than tight -- see CONTAINER_MISSED_PASSES.
 */
export const CONTAINER_PASS_INTERVAL_MS = 60 * 60_000;

/**
 * How many passes a lane may miss before it is a stall.
 *
 * SIX, and the width is doing a job. A tight bound on a cross-repo cadence is
 * the worst of both: it false-alarms the day infra changes its cron, and this
 * lane's whole value is that an operator believes it. Six hours still catches
 * the incident this was written for on its sixth hour instead of its
 * thirty-second, and a lane genuinely down for six hours is not a jitter story
 * under any cadence between hourly and three-hourly.
 */
export const CONTAINER_MISSED_PASSES = 6;

export const CONTAINER_LANE_THRESHOLD_MS =
  CONTAINER_MISSED_PASSES * CONTAINER_PASS_INTERVAL_MS;

export interface ContainerLaneEntry {
  lane: string;
  verdict: "ok" | "stale" | "unknown";
  /** Why, in the producer's own words where it gave any. */
  detail: string | null;
  age_ms: number | null;
}

export interface ContainerLaneVerdict {
  stale: boolean;
  threshold_ms: number;
  checked: number;
  stale_lanes: string[];
  entries: ContainerLaneEntry[];
}

/** One lane's status as this watchdog reads it. */
export interface ContainerLaneStatus {
  lane: string;
  /** The parsed body, or null when absent/unreadable. */
  body: {
    checked_at?: string | null;
    updated_at?: string | null;
    ok?: boolean | null;
    status?: string | null;
    detail?: string | null;
    phase?: string | null;
  } | null;
}

/** Hours, to one decimal, for a message a human reads at 3am. */
function hours(ms: number): string {
  return (ms / 3_600_000).toFixed(1);
}

/**
 * The rule alone, testable without a bucket or a clock.
 *
 * `unknown` VERSUS `stale`, and the distinction is the one #10215 exists about:
 * `stale` asserts the lane is behind, `unknown` says this watchdog could not
 * measure it. An absent or unreadable status is the second -- the lane may be
 * perfectly healthy and its status object merely missing -- and reporting that
 * as `stale` would be inventing a fault, while reporting it as `ok` would be
 * inventing a measurement.
 */
export function evaluateContainerLanes(input: {
  statuses: ContainerLaneStatus[];
  nowMs: number;
  thresholdMs: number;
}): ContainerLaneVerdict {
  const { statuses, nowMs, thresholdMs } = input;
  const entries = statuses.map(({ lane, body }): ContainerLaneEntry => {
    if (body === null) {
      return {
        lane,
        verdict: "unknown",
        detail: "no status object published",
        age_ms: null,
      };
    }
    // Either spelling. Which word the producing script chose is not a fact
    // about lane health, so the reader takes whichever is there.
    const stampedAt = body.checked_at ?? body.updated_at ?? null;
    const at = stampedAt === null ? Number.NaN : Date.parse(stampedAt);
    if (!Number.isFinite(at)) {
      return {
        lane,
        verdict: "unknown",
        detail: "status carries no readable timestamp",
        age_ms: null,
      };
    }
    const age = nowMs - at;

    // A DECLARED FAILURE OUTRANKS AGE. A lane that just ran and said it failed
    // is fresh, so the age rule would call it healthy -- and its own `ok:
    // false` is a better signal than any inference this watchdog could make.
    // Reported with the producer's own `detail`/`phase`, because a message
    // invented here about a process running in another repository would be a
    // guess dressed as a diagnosis.
    const declaredFailure =
      body.ok === false ||
      (typeof body.status === "string" && body.status !== "ok");
    if (declaredFailure) {
      const said = body.detail ?? body.phase ?? body.status ?? null;
      return {
        lane,
        verdict: "stale",
        detail:
          said === null ? "lane reported failure" : `lane failed: ${said}`,
        age_ms: age,
      };
    }

    if (age > thresholdMs) {
      return {
        lane,
        verdict: "stale",
        detail:
          `${hours(age)}h since the last pass (threshold ${hours(thresholdMs)}h, ` +
          `${CONTAINER_MISSED_PASSES} missed passes)`,
        age_ms: age,
      };
    }
    return { lane, verdict: "ok", detail: null, age_ms: age };
  });

  const staleLanes = entries
    .filter((entry) => entry.verdict === "stale")
    .map((entry) => entry.lane);
  return {
    stale: staleLanes.length > 0,
    threshold_ms: thresholdMs,
    checked: entries.length,
    stale_lanes: staleLanes,
    entries,
  };
}

interface StatusBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export interface ContainerLaneWatchdogDeps {
  now?: () => number;
  recordException?: typeof recordExceptionEvent;
  laneHealthDb?: LaneHealthDb | null;
  thresholdMs?: number;
}

/** One watchdog tick. Returns a summary rather than throwing, matching the
 * family: a tick that cannot run is one missed report, not an outage. */
export async function runContainerLaneWatchdog(
  env: ContainerLaneWatchdogEnv | null | undefined,
  deps: ContainerLaneWatchdogDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = (env as { METAGRAPH_ARCHIVE?: StatusBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return { ok: false, reason: "r2 binding unavailable" };
  const thresholdMs = deps.thresholdMs ?? CONTAINER_LANE_THRESHOLD_MS;

  const statuses: ContainerLaneStatus[] = [];
  for (const { lane, key } of CONTAINER_LANES) {
    // Declared without an initialiser: both arms below assign it, so a `= null`
    // here is a value nothing reads (`no-useless-assignment`).
    let body: ContainerLaneStatus["body"];
    try {
      const object = await bucket.get(key);
      const parsed = object
        ? ContainerLaneStatusSchema.safeParse(await object.json())
        : null;
      body = parsed?.success ? parsed.data : null;
    } catch {
      // Unreadable is reported as absent rather than skipped: a watchdog that
      // quietly drops what it could not read reports healthy on exactly the
      // lanes worth worrying about.
      body = null;
    }
    statuses.push({ lane, body });
  }

  const verdict = evaluateContainerLanes({
    statuses,
    nowMs: now(),
    thresholdMs,
  });

  if (verdict.stale) {
    // ONE event naming every stale lane. Five alerts for one stopped pass is
    // the failure mode where an alarm stops being read.
    const detail = verdict.entries
      .filter((entry) => entry.verdict === "stale")
      .map((entry) => `${entry.lane} (${entry.detail})`)
      .join(", ");
    await record(env, {
      error: new Error(
        `container lanes stalled: ${detail} -- these run in metagraphed-infra's ` +
          `decode container, so nothing in this Worker will recover them`,
      ),
      route: "watchdog:container-lanes",
      errorCode: "stale_lane",
    }).catch(() => false);
  }

  // The DURABLE record, written every tick rather than only when stale --
  // #9330/#9340's rule. PostHog drops `$exception` once the free-tier quota is
  // exhausted, and a dropped notification is indistinguishable from a fleet
  // that was fine.
  const db = laneHealthStore(env, deps.laneHealthDb);
  const checkedAt = now();
  for (const entry of verdict.entries) {
    await recordLaneVerdict(db, {
      lane: entry.lane,
      verdict: entry.verdict,
      age_ms: entry.age_ms,
      detail: entry.detail,
      checked_at: checkedAt,
    });
  }

  return {
    ok: true,
    stale: verdict.stale,
    threshold_ms: verdict.threshold_ms,
    checked: verdict.checked,
    stale_lanes: verdict.stale_lanes,
  };
}
