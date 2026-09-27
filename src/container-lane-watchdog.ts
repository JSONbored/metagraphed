// Monitor the five sequential container lanes without querying their archives.
// Producers publish bounded status documents to D1; R2 is read only until each
// lane has its first D1 publication. Status age and failures remain observable.
import { type ArtifactStoreEnv, artifactBucket } from "./projection-store.ts";

import { ContainerLaneStatusSchema } from "../schemas-src/artifacts/container-lane-status.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";

// `ArtifactStoreEnv` because this watchdog READS the lane status objects out
// of the archive. It used to reach them through a cast, which left the env
// type claiming the function touched no bucket at all.
type ContainerLaneWatchdogEnv = StoreEnv & TelemetryEnv & ArtifactStoreEnv;

/** One container-written lane: what to call it, and where it says how it went. */
export interface ContainerLane {
  /** The `lane_health` label. Prefixed so a sweep can name the whole family. */
  lane: string;
  /** Stable status identity, shared with the container producer. */
  key: string;
  /** Minimum refresh interval after success, in addition to the stall grace. */
  successIntervalMs?: number;
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
    // account_summary_r2.py's min_interval_ms() defaults to twenty hours.
    // The deployed decoder has no override. Failures and active scans do not
    // get this allowance: only a producer that explicitly completed succeeds.
    successIntervalMs: 20 * 60 * 60_000,
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
  successIntervalMs?: number;
  /** The parsed body, or null when absent/unreadable. */
  body: {
    checked_at?: string | null;
    updated_at?: string | null;
    /** Published by a script reporting an IN-PROGRESS pass, where the other two
     * spellings appear only once it finishes. */
    started_at?: string | null;
    ok?: boolean | null;
    status?: string | null;
    detail?: string | null;
    phase?: string | null;
    failures?: Record<string, unknown> | null;
  } | null;
}

/**
 * How long a quoted producer message may be.
 *
 * The real one that prompted this carried a 700-character pyarrow traceback in
 * a sibling key. A `$exception` nobody can read at a glance is a `$exception`
 * nobody reads, and the full text is in the status object either way -- this
 * names the fault, it does not replace the artifact.
 */
export const LANE_DETAIL_MAX = 200;

/**
 * The producer's own words for why a lane failed, or null when it gave none.
 *
 * FAILURES FIRST, and this is the whole point. On 2026-08-16 the
 * account-summary lane published `ok: false, phase: "complete", failures: {
 * _lane: "ArrowInvalid: Schema at index 1 was different: ..." }` and this
 * watchdog recorded `lane failed: complete` -- it fell through `detail`
 * (absent) to `phase`, which names the step that FINISHED rather than the
 * reason it failed. An alarm that reports the phase of a failure says less than
 * one that stays silent, because it reads like an answer.
 *
 * EVERY entry, joined, not just the first: the map is per-step, so a pass that
 * failed three ways has three things worth knowing and picking one would be an
 * arbitrary choice presented as a summary.
 *
 * NON-STRING VALUES ARE SKIPPED rather than stringified. This repo does not own
 * the producers, and `[object Object]` in an alarm is worse than the key's
 * absence -- it looks like a message and carries none.
 */
export function laneFailureDetail(body: {
  detail?: string | null;
  phase?: string | null;
  status?: string | null;
  failures?: Record<string, unknown> | null;
}): string | null {
  const failures = body.failures;
  if (failures && typeof failures === "object") {
    const said = Object.entries(failures)
      .filter(([, value]) => typeof value === "string" && value.trim() !== "")
      .map(([step, value]) => `${step}: ${clip(String(value))}`);
    if (said.length > 0) return said.join("; ");
  }
  return body.detail ?? body.phase ?? body.status ?? null;
}

/** One producer message, on one line, bounded. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= LANE_DETAIL_MAX
    ? flat
    : `${flat.slice(0, LANE_DETAIL_MAX - 1)}\u2026`;
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
  const entries = statuses.map((status): ContainerLaneEntry => {
    const { lane, body, successIntervalMs } = status;
    if (body === null) {
      return {
        lane,
        verdict: "unknown",
        detail: "no status object published",
        age_ms: null,
      };
    }
    // ANY OF THE THREE SPELLINGS. Which word the producing script chose is not
    // a fact about lane health, so the reader takes whichever is there.
    //
    // `started_at` was the missing one, and its absence made a lane read
    // `unknown` for the whole of every pass it ran. Measured 2026-08-18: the
    // account-summary container publishes
    //
    //   {"phase":"scanning","started_at":"2026-08-18T07:27:19Z","ok":null,
    //    "rows_scanned":2125318,...}
    //
    // mid-scan -- no `checked_at`, no `updated_at` -- so `container:account-
    // summary` sat at "status carries no readable timestamp" while its producer
    // was demonstrably healthy (generation 20260818T072733Z, ten minutes old).
    // A verdict that cannot be cleared while a lane is WORKING is the opposite
    // of what this watchdog is for.
    //
    // AND IT IS THE RIGHT FRESHNESS SIGNAL, not merely a third field to accept:
    // during a pass, when that pass STARTED is exactly the age that matters --
    // a scan still scanning three hours later is stale, and this is the field
    // that says so. Ordered last so a script publishing both keeps reporting
    // its most recent stamp rather than its oldest.
    const stampedAt =
      body.checked_at ?? body.updated_at ?? body.started_at ?? null;
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
      const said = laneFailureDetail(body);
      return {
        lane,
        verdict: "stale",
        detail:
          said === null ? "lane reported failure" : `lane failed: ${said}`,
        age_ms: age,
      };
    }

    const laneThresholdMs =
      thresholdMs + (body.ok === true ? (successIntervalMs ?? 0) : 0);
    if (age > laneThresholdMs) {
      return {
        lane,
        verdict: "stale",
        detail: `${hours(age)}h since the last pass (threshold ${hours(laneThresholdMs)}h)`,
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
  const bucket = artifactBucket(env);
  const state = env?.D1_STATE;
  if (!bucket && !state?.prepare)
    return { ok: false, reason: "status storage unavailable" };
  const thresholdMs = deps.thresholdMs ?? CONTAINER_LANE_THRESHOLD_MS;

  // A committed D1 status owns this lane. Failed reads and invalid payloads
  // must never reveal an older, healthy R2 verdict. Absent rows retain the
  // legacy owner only while the producer is rolling over to D1.
  const prefix = "container-status/v1/";
  const stored = new Map<string, string | null>();
  let stateFailed = false;
  if (state?.prepare) {
    try {
      const result = await state
        .prepare(
          "SELECT key, CASE WHEN length(CAST(payload AS BLOB))<=65536 " +
            "THEN payload ELSE NULL END AS payload FROM generated_artifacts " +
            "WHERE key IN (?,?,?,?,?)",
        )
        .bind(...CONTAINER_LANES.map(({ key }) => prefix + key))
        .all<{ key: string; payload: string | null }>();
      if (!result.success) throw new Error("Container status read failed");
      for (const row of result.results) stored.set(row.key, row.payload);
    } catch {
      stateFailed = true;
    }
  }

  const statuses: ContainerLaneStatus[] = [];
  for (const { lane, key, successIntervalMs } of CONTAINER_LANES) {
    // Declared without an initialiser: both arms below assign it, so a `= null`
    // here is a value nothing reads (`no-useless-assignment`).
    let body: ContainerLaneStatus["body"];
    try {
      let value: unknown = null;
      if (!stateFailed) {
        if (stored.has(prefix + key)) {
          const payload = stored.get(prefix + key);
          value = typeof payload === "string" ? JSON.parse(payload) : null;
        } else {
          const object = await bucket?.get(key);
          value = object ? await object.json() : null;
        }
      }
      const parsed = ContainerLaneStatusSchema.safeParse(value);
      body = parsed?.success ? parsed.data : null;
    } catch {
      // Unreadable is reported as absent rather than skipped: a watchdog that
      // quietly drops what it could not read reports healthy on exactly the
      // lanes worth worrying about.
      body = null;
    }
    statuses.push({ lane, body, successIntervalMs });
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
