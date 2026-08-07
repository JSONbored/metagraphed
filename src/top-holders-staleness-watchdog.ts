// The alarm for the top-holders leaderboard (#9464).
//
// This watchdog exists because of what happened WITHOUT one. GET
// /api/v1/accounts/top-holders (and get_top_holders over MCP) answered 200
// with `captured_at: 2026-08-02T00:05:06.441Z` and 2,965 accounts for three
// days, and nothing anywhere said so. Found by a caller reading the timestamp,
// which is the same way #9273 was found and the same way #9423 was found.
//
// ## It used to watch TWO objects, and one of them could never pass
//
// When this shipped, the leaderboard was served by a ONE-SHOT artifact whose
// own body said `"source": "final pre-decommission materialization of the live
// route SQL"` -- `account_balances` was a direct System::Account scan into the
// box's Postgres, and the box was gone. So one leg of this watchdog measured an
// object that could not age gracefully because it did not age at all, against a
// twelve-hour bound, and reported `stale` on every tick.
//
// #9475 was right to refuse to suppress that. Its own words: "an alarm that
// fires forever on a defect that persists forever is not noise; it is an
// accurate report, and the way to silence it is to fix the thing... until
// someone gives the lane a producer or withdraws the route."
//
// THE LANE GOT A PRODUCER. src/top-holders-flow-tier.ts's holdings leg composes
// `free_tao` from the account_balances D1 table and `delegated_tao` from
// hotkey_alpha, both of which now have live poller lanes, and its daily
// projection declares all six sortable keys -- verified on the served object
// 2026-08-07: `sorts: [net_flow_7d, net_flow_30d, net_flow_90d, free_tao,
// delegated_tao, total_tao]`, 3,859 rows, generated 01:34:12 that morning. The
// route reads that projection and never reaches the frozen artifact.
//
// So the frozen artifact was deleted rather than kept as a rung, and this
// watchdog now judges the ONE object that is served. Keeping it would have been
// a fallback that only gets older, holding null in three of six columns, ready
// to answer an ss58-ordered non-ranking the day the live lane skipped -- the
// exact defect #9469 exists to remove. The route's last rung is the
// schema-stable empty leaderboard, which is this repo's honest decline
// everywhere else.
//
// ## The verdicts, and what each one means to repair
//
//   absent / unreadable  the R2 object is gone or is not the shape the reader
//                        accepts, so the tier declines and the route answers a
//                        schema-stable EMPTY leaderboard -- 200 OK,
//                        `account_count: 0`, silent in aggregate.
//   empty                the object is well-formed and carries no rows, which
//                        serves the same empty page from a different fault.
//   stale                the daily lane has not written inside its bound.
//
// None of them is suppressed, on #9475's reasoning, which stands unchanged.

import {
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
  topHoldersFlowRows,
} from "./top-holders-flow-tier.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

/**
 * The same bound for the LIVE half of this leaderboard (#9469).
 *
 * FORTY-EIGHT HOURS, by the identical rule one cadence up: the net_flow_*
 * lane runs once a day (TOP_HOLDERS_FLOW_CRON), a healthy lane's age
 * therefore swings across a full 24 hours, and this is that plus one whole
 * cadence of slack -- so it cannot fire until a daily pass has genuinely been
 * skipped. Anything at or near 24 h would alert on a lane that is working,
 * which is the #9301 mistake the threshold above already carries a note about.
 *
 * Overridable per-deployment via TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS.
 */
export const TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS = 48 * 60 * 60 * 1000;

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

/** Read the served artifact and classify it exactly as the read path would.
 *
 * `key`/`readRows` default to the projection the route actually serves and ITS
 * reader test. Two copies of "is this body usable" drift, and the direction
 * they drift is the dangerous one: a looser test reports healthy on exactly the
 * object the route is declining. */
export async function readTopHoldersArtifactState(
  bucket: ArtifactBucket,
  key: string = TOP_HOLDERS_FLOW_PROJECTION_KEY,
  readRows: (body: unknown) => unknown[] | null = topHoldersFlowRows,
): Promise<TopHoldersArtifactState> {
  let body: unknown;
  try {
    const object = await bucket.get(key);
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
  const rows = readRows(body);
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

  const flowThresholdMs =
    Number(env?.TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS) ||
    TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS;
  const flow = evaluateTopHoldersStaleness({
    artifact: await readTopHoldersArtifactState(bucket),
    nowMs: now(),
    thresholdMs: flowThresholdMs,
  });

  if (flow.stale) {
    const age =
      flow.age_ms === null
        ? "age unknown"
        : `${(flow.age_ms / 3_600_000).toFixed(1)} h old`;
    await record(env as never, {
      error: new Error(
        `top-holders flow lane ${flow.reason}: the net_flow_* ranking is ` +
          `${age} (threshold ${(flowThresholdMs / 3_600_000).toFixed(1)} h) ` +
          `-- /api/v1/accounts/top-holders and get_top_holders answer 200 ` +
          `off this object, and serve an EMPTY leaderboard when it cannot be ` +
          `read: there is no second tier under it any more`,
      ),
      route: "watchdog:top-holders-flow-staleness",
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
      lane: "top-holders-flow-staleness",
      verdict: flow.stale ? "stale" : "ok",
      age_ms: flow.age_ms,
      detail: flow.reason,
      checked_at: now(),
    },
  );

  // `ok` describes whether the TICK ran, not whether the lane is fresh. The
  // verdict is flat now that there is one artifact rather than two; `flow` is
  // kept alongside it so a reader written against the two-artifact shape still
  // finds the field it was reading.
  return {
    ok: true,
    alerted: flow.stale,
    ...flow,
    flow,
  };
}
