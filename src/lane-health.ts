// The durable record of every watchdog verdict (#9330, #9340).
//
// Every staleness watchdog in this repo reported through exactly one channel:
// `recordExceptionEvent` -> PostHog `$exception`. PostHog drops `$exception` silently
// once the free-tier quota is exhausted, and this project runs at roughly 1M events/day.
// So the failure mode is precise and has now happened three times: the lane stops, the
// watchdog runs on schedule, computes the correct verdict, and its only output is
// discarded.
//
// Measured on the 2026-08-03 chain-detail outage (#9316): the lane wrote nothing for
// ~4 hours against a 20-minute threshold on a `14,29,44,59 * * * *` cron, so the
// watchdog returned a stale verdict roughly ten times. Nothing surfaced. The outage was
// found by a routine sweep of published routes.
//
// ## Why D1 and not a second notifier
//
// #9340 asks for a sink "that cannot be dropped by someone else's quota". A second
// notification channel would still be a notification -- it answers "did anyone get
// paged", not "was anything stale overnight". A row per tick answers the second
// question directly, is a few bytes, and is queryable without any external service:
//
//     SELECT * FROM lane_health WHERE verdict = 'stale' ORDER BY checked_at DESC
//
// PostHog stays as the NOTIFICATION path. What changes is that it is no longer the
// RECORD.
//
// ## Writing here can never break a tick
//
// D1 migrations in this repo are applied BY HAND -- merging a migration does not create
// the table. So `recordLaneVerdict` treats every failure, including "no such table", as
// a no-op that returns false rather than throwing. A watchdog whose alarm-recording
// broke its alarm would be worse than the bug being fixed.

import {
  LANE_VERDICTS,
  type SelfHealthLane,
} from "../schemas-src/routes/self-health.ts";

/**
 * How long a verdict is kept.
 *
 * The serving read only ever wants the newest row per lane; everything older exists
 * for triage ("was anything stale overnight", "when did this lane last recover").
 * 90 days matches the window the self-health card already reports its component
 * uptime over, so the two halves of that card describe the same span of history.
 *
 * Without this the table grows by one row per lane per tick forever. That is only a
 * few MB a year today, which is exactly why an unbounded table would survive review
 * and then quietly become someone's problem years later.
 */
export const LANE_HEALTH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The minimal D1 surface these helpers use, so callers can inject a fake. */
export interface LaneHealthDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all?(): Promise<{ results?: unknown[] } | null>;
    };
    all?(): Promise<{ results?: unknown[] } | null>;
  };
}

/** A tick's outcome. `unknown` is for a watchdog that could not evaluate at all —
 * distinct from `ok`, because "we did not look" is not "we looked and it was fine".
 *
 * Derived from the published schema rather than restated, so the set of verdicts this
 * module can persist and the set the API documents cannot drift apart. */
export type LaneVerdict = SelfHealthLane["verdict"];

export interface LaneHealthRecord {
  lane: string;
  verdict: LaneVerdict;
  /** How far behind the lane was, when the watchdog could measure it. */
  age_ms: number | null;
  /** The watchdog's own reason string, kept verbatim for triage. */
  detail: string | null;
  checked_at: number;
}

/**
 * Persist one watchdog tick. Returns whether the row landed.
 *
 * Never throws. A missing binding, an unapplied migration, or a D1 error all return
 * false — the caller records its PostHog event and completes the tick either way.
 */
export async function recordLaneVerdict(
  db: LaneHealthDb | null | undefined,
  record: LaneHealthRecord,
): Promise<boolean> {
  if (!db?.prepare) return false;
  try {
    await db
      .prepare(
        "INSERT INTO lane_health (lane, verdict, age_ms, detail, checked_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        record.lane,
        record.verdict,
        record.age_ms,
        record.detail,
        record.checked_at,
      )
      .run();
  } catch {
    // The insert is what this function promises. A missing binding, an unapplied
    // migration, or any D1 error means the verdict was NOT recorded, and the caller
    // is told so.
    return false;
  }
  try {
    // Prune this lane's own expired rows on the way through, rather than from a
    // separate cron that would be one more thing to wire and to notice breaking.
    // Bounded and indexed: it touches one lane, by (lane, checked_at).
    await db
      .prepare("DELETE FROM lane_health WHERE lane = ? AND checked_at < ?")
      .bind(record.lane, record.checked_at - LANE_HEALTH_RETENTION_MS)
      .run();
  } catch {
    // Deliberately swallowed, and deliberately NOT folded into the try above: the
    // verdict is already committed, so a failed prune must not report the alarm as
    // unrecorded. Retention is a housekeeping concern; the next tick retries it.
  }
  return true;
}

/** Most recent verdict per lane, newest first. `{}` on any failure. */
export async function loadLatestLaneHealth(
  db: LaneHealthDb | null | undefined,
): Promise<Record<string, LaneHealthRecord>> {
  if (!db?.prepare) return {};
  try {
    // One row per lane via a correlated MAX, rather than pulling the whole table and
    // reducing in the Worker: the table grows by one row per lane per tick forever, so
    // a full scan here would get slower every day this runs.
    const statement = db.prepare(
      "SELECT lane, verdict, age_ms, detail, checked_at FROM lane_health " +
        "WHERE (lane, checked_at) IN " +
        "(SELECT lane, MAX(checked_at) FROM lane_health GROUP BY lane)",
    );
    const result = await statement.all?.();
    const rows = (result?.results ?? []) as Record<string, unknown>[];
    const out: Record<string, LaneHealthRecord> = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      out[lane] = {
        lane,
        verdict: normalizeVerdict(row.verdict),
        age_ms: toIntOrNull(row.age_ms),
        detail: row.detail == null ? null : String(row.detail),
        checked_at: toIntOrNull(row.checked_at) ?? 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeVerdict(value: unknown): LaneVerdict {
  // Anything the schema does not name reads as `unknown` rather than being served
  // through: a verdict this build cannot interpret is precisely "we do not know".
  return (LANE_VERDICTS as readonly string[]).includes(value as string)
    ? (value as LaneVerdict)
    : "unknown";
}

function toIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Which lanes are currently stale, oldest verdict first.
 *
 * A lane whose verdict is `unknown` is NOT reported as stale: the watchdog could not
 * evaluate it, and claiming staleness from an absence of measurement is the same
 * confident-wrong-answer this repo's null-safety convention exists to avoid. It is still
 * visible in the full map for anyone asking why a lane has no recent verdict.
 */
export function staleLanes(
  latest: Record<string, LaneHealthRecord>,
): LaneHealthRecord[] {
  return Object.values(latest)
    .filter((row) => row.verdict === "stale")
    .sort((a, b) => a.checked_at - b.checked_at);
}
