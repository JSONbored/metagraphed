// The alarm for the top-holders leaderboard (#9464).
//
// This watchdog exists because of what happened WITHOUT one. GET
// /api/v1/accounts/top-holders (and get_top_holders over MCP) answered 200
// with `captured_at: 2026-08-02T00:05:06.441Z` and 2,965 accounts for three
// days, and nothing anywhere said so. Found by a caller reading the
// timestamp, which is the same way #9273 was found and the same way #9423
// was found.
//
// WHAT IS ACTUALLY WRONG HERE IS WORSE THAN "STALE". The lane has no
// producer at all and cannot get one back where it stands. `account_balances`
// was a direct System::Account scan written by the poller's `account-balances`
// job straight into the box's Postgres; the box is gone, the table went with
// it (#9193 retired handleAccountBalancesSync to its auth gate), no D1 table
// of that name was ever created, and the job is deliberately absent from
// POLLER_ONLY in metagraphed-infra's Dockerfile.poller -- it is one of the
// four Postgres-backed lanes held disabled "until they have a Cloudflare-native
// sink". So the route is not serving a lane that stopped. It is serving
// `metagraph/materialized/top-holders.json`, a ONE-SHOT artifact whose own
// body says `"source": "final pre-decommission materialization of the live
// route SQL"`, and whose every row carries the same fixed `captured_at`. That
// answer does not age gracefully -- it does not age at all.
//
// ## It alerts on every tick, and that is the point (#9475)
//
// This shipped in #9464 special-casing the frozen snapshot: a committed
// `TOP_HOLDERS_FROZEN_GENERATED_AT` constant matched the artifact's own
// `generated_at`, and that one verdict recorded a `lane_health` row without
// notifying. The reasoning was exception cost plus alarm fatigue. Both parts
// were wrong, and the shape was worse than either:
//
//   - The cost claim does not survive arithmetic. Twice hourly is 48 events a
//     day against a project running ~1M/day -- 0.005%, and the production
//     storm guard (POSTHOG_EXCEPTION_STORM_WINDOW_MS, 5 min) does not even
//     engage at a 30-minute spacing. There was no cost to trade anything for.
//
//   - It made the watchdog silent on the exact defect it was built for. #9464
//     exists because a frozen leaderboard went three days unnoticed; a
//     watchdog that answers that by writing a row into a table nobody queries
//     lets the next three days pass the same way. `lane_health` is the RECORD,
//     which is why it is still written every tick -- it was never a substitute
//     for the notification.
//
//   - Suppressing on a hardcoded timestamp is a known-bad-state allowlist. It
//     disables the alarm for precisely the condition that is currently true,
//     indefinitely, and a second frozen materialization would have to be
//     hand-added to keep it quiet. Nothing else in this repo suppresses an
//     alarm that way, and the two sibling lanes this one is modelled on
//     (#9273, #9301) both alerted every tick while dead -- and both got fixed.
//
// So there is no frozen branch and no constant. A leaderboard nothing refreshes
// is `stale`, it says so on every tick, and it keeps saying so until someone
// gives the lane a producer or withdraws the route. An alarm that fires
// forever on a defect that persists forever is not noise; it is an accurate
// report, and the way to silence it is to fix the thing.
//
// The other verdicts name faults with different repairs:
//
//   absent / unreadable  the R2 object is gone or is not the shape the reader
//                        accepts, so loadTopHoldersFromArtifact declines and
//                        the route answers a schema-stable EMPTY leaderboard
//                        -- 200 OK, `account_count: 0`, silent in aggregate.
//   empty                the object is well-formed and carries no rows, which
//                        serves the same empty page from a different fault.

import {
  TOP_HOLDERS_ARTIFACT_KEY,
  topHoldersArtifactRows,
} from "./top-holders-artifact.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

/**
 * How old the leaderboard may get before it is a stall.
 *
 * TWELVE HOURS, sized to the producer this lane has when it has one:
 * `ACCOUNT_BALANCES_POLL_SECS` defaults to 21600 (six hours) in the poller
 * (metagraphed-infra's roles/indexer-rust/tasks/main.yml sets exactly that),
 * and the scan behind it is a full System::Account walk -- 542,618 entries
 * measured 2026-07-19 -- so a healthy lane's age swings across the whole
 * six-hour interval plus however long the walk takes.
 *
 * Twelve is one full cadence of slack on top of that: it cannot fire until a
 * pass has genuinely been skipped, which is the sizing rule #9301 corrected
 * the nominator-positions threshold for after a six-hour bound was set against
 * a 24-hour producer and alerted three quarters of every day on a lane that
 * was working.
 *
 * The artifact in place today is days past this and climbing, so the verdict
 * is `stale` on every tick until the lane gets a producer -- see the module
 * header for why that is reported rather than suppressed.
 *
 * Overridable per-deployment via TOP_HOLDERS_STALENESS_THRESHOLD_MS so the
 * number can follow a future sink's cadence without a code deploy.
 */
export const TOP_HOLDERS_STALENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export type TopHoldersStalenessReason =
  "absent" | "unreadable" | "empty" | "stale" | null;

/** What the watchdog found in the bucket, normalized so the rule below needs
 * neither R2 nor a JSON parser. `present: false` carries WHY, because "the
 * object is gone" and "the object is not the shape the reader accepts" are
 * different repairs even though the route serves the same empty page for both. */
export type TopHoldersArtifactState =
  | { present: false; reason: "absent" | "unreadable" }
  | { present: true; generatedAt: string | null; rowCount: number };

export interface TopHoldersStalenessVerdict {
  stale: boolean;
  reason: TopHoldersStalenessReason;
  age_ms: number | null;
  generated_at: string | null;
  threshold_ms: number;
}

/** The rule alone, testable without a bucket or a clock. */
export function evaluateTopHoldersStaleness(input: {
  artifact: TopHoldersArtifactState;
  nowMs: number;
  thresholdMs: number;
}): TopHoldersStalenessVerdict {
  const { artifact, nowMs, thresholdMs } = input;
  if (!artifact.present) {
    // Nothing to serve. The route does not fail here -- it falls through to
    // buildTopHoldersList([]) and answers an empty leaderboard with a 200, so
    // this is the one condition that is completely invisible from outside.
    return {
      stale: true,
      reason: artifact.reason,
      age_ms: null,
      generated_at: null,
      threshold_ms: thresholdMs,
    };
  }
  const { generatedAt, rowCount } = artifact;
  const at = generatedAt == null ? NaN : Date.parse(generatedAt);
  if (!Number.isFinite(at)) {
    // A body whose timestamp cannot be read is worse than a missing one: the
    // route is serving it, and nothing can say how old it is.
    return {
      stale: true,
      reason: "unreadable",
      age_ms: null,
      generated_at: generatedAt,
      threshold_ms: thresholdMs,
    };
  }
  const ageMs = nowMs - at;
  if (rowCount === 0) {
    // Distinguished from a plain `stale` even though both are stalls: an
    // artifact present and well-formed with no rows serves an empty
    // leaderboard NOW, regardless of its age, and that is a different repair
    // from one that merely stopped being refreshed.
    return {
      stale: true,
      reason: "empty",
      age_ms: ageMs,
      generated_at: generatedAt,
      threshold_ms: thresholdMs,
    };
  }
  const stale = ageMs > thresholdMs;
  return {
    stale,
    reason: stale ? "stale" : null,
    age_ms: ageMs,
    generated_at: generatedAt,
    threshold_ms: thresholdMs,
  };
}

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export interface TopHoldersStalenessDeps {
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified -- the distinction #9330/#9340 exist about. */
  laneHealthDb?: LaneHealthDb | null;
}

/** Read the served artifact and classify it exactly as the read path would. */
export async function readTopHoldersArtifactState(
  bucket: ArtifactBucket,
): Promise<TopHoldersArtifactState> {
  let body: unknown;
  try {
    const object = await bucket.get(TOP_HOLDERS_ARTIFACT_KEY);
    if (!object) return { present: false, reason: "absent" };
    body = await object.json();
  } catch {
    // A get or a parse that threw is reported, not skipped: a watchdog that
    // quietly drops what it could not read reports healthy on exactly the
    // object worth worrying about. "unreadable" rather than "absent" because a
    // throw does not establish that the object is gone -- only that this tick
    // could not see it, which is a different thing to go and check.
    return { present: false, reason: "unreadable" };
  }
  const rows = topHoldersArtifactRows(body);
  if (rows === null) return { present: false, reason: "unreadable" };
  const generatedAt = (body as { generated_at?: unknown } | null)?.generated_at;
  return {
    present: true,
    generatedAt: typeof generatedAt === "string" ? generatedAt : null,
    rowCount: rows.length,
  };
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an outage,
 * and a cron that throws is a cron nobody can read the result of.
 */
export async function runTopHoldersStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: TopHoldersStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return { ok: false, reason: "r2 binding unavailable" };

  const thresholdMs =
    Number(env?.TOP_HOLDERS_STALENESS_THRESHOLD_MS) ||
    TOP_HOLDERS_STALENESS_THRESHOLD_MS;

  const verdict = evaluateTopHoldersStaleness({
    artifact: await readTopHoldersArtifactState(bucket),
    nowMs: now(),
    thresholdMs,
  });

  if (verdict.stale) {
    const age =
      verdict.age_ms === null
        ? "age unknown"
        : `${(verdict.age_ms / 3_600_000).toFixed(1)} h old`;
    await record(env as never, {
      error: new Error(
        `top-holders lane ${verdict.reason}: the leaderboard artifact is ` +
          `${age} (threshold ${(thresholdMs / 3_600_000).toFixed(1)} h) -- ` +
          `/api/v1/accounts/top-holders and get_top_holders answer 200 off ` +
          `this object, and serve an EMPTY leaderboard when it cannot be read`,
      ),
      route: "watchdog:top-holders-staleness",
      errorCode: "stale_lane",
    }).catch(() => false);
  }

  // #9330/#9340: the DURABLE record, written every tick rather than only when
  // stale. PostHog stays the notification path; it is no longer the record,
  // because a dropped `$exception` is indistinguishable from a lane that was
  // fine, and writing on every tick is also what makes "the watchdog stopped
  // running" visible at all. Never throws -- see recordLaneVerdict.
  await recordLaneVerdict(
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as never),
    {
      lane: "top-holders-staleness",
      verdict: verdict.stale ? "stale" : "ok",
      age_ms: verdict.age_ms,
      detail: verdict.reason,
      checked_at: now(),
    },
  );

  // `ok` describes whether the TICK ran, not whether the lane is fresh.
  return { ok: true, alerted: verdict.stale, ...verdict };
}
