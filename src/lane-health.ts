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

/**
 * Lanes whose PRODUCER was deleted, so no future tick can ever revise them.
 *
 * A verdict is a statement about a lane as of `checked_at`, and the serving read
 * takes the newest row per lane with no liveness bound. That is right while a
 * producer exists -- the newest thing it said is the current truth. It stops being
 * right the moment the producer goes: the last thing a deleted lane ever said is
 * served forever, and if that was `stale` it is a permanent alarm nothing can clear.
 *
 * Live case this fixes (#10222). #10167 deleted the reconciler, the parity sweep and
 * the mirror-lag watchdog, correctly, because Neon is the sole store now. Their rows
 * stayed:
 *
 *   neon-parity  stale  "chain_detail_chain_events -169126, chain_detail_account_events -126582"
 *
 * `neon-parity` counted Neon against D1. D1 was deleted on 2026-08-08, so those
 * deficits are the size of the store, they only grow, and no pass will ever revise
 * them. `stale_lane_count` could not return to zero, on either
 * `GET /api/v1/self-health` or `get_self_health`.
 *
 * THIS IS NOT SUPPRESSION, and the distinction is the whole design. Suppressing a
 * watchdog means muting a lane that still runs. These lanes do not run. Serving their
 * last verdict is not vigilance, it is reporting a fact about the past as though it
 * were current -- and a stale count that can never reach zero teaches everyone to
 * ignore the number, which costs more than the one row.
 *
 * The entries are tied to deleted FILES, and tests/lane-health-retired.test.ts asserts
 * those files are still absent. So a lane cannot be quietly retired while its producer
 * lives, and resurrecting a producer fails the test until its name is removed here.
 */
export const RETIRED_LANES: readonly string[] = [
  // src/neon-parity.ts -- compared row counts against D1 (#10167).
  "neon-parity",
  // src/neon-mirror-lag.ts -- measured how far a mirror trailed its D1 source
  // (#10167). Reports `ok`, so it alarms nothing; it is equally a lie.
  "neon-mirror-lag",
  // The BARE spelling, not `neon:raw-capture-state` (which is live and stays
  // watched). Its producer was the pre-#10851 buffer flush, which filed
  // per-lane verdicts under the raw statement tag; #10851 put both writers on
  // neonLaneKey, so every verdict for this lane now lands under the `neon:`
  // prefix and the bare key's newest row is frozen at the #10851 deploy --
  // which is exactly when its silence alarm started counting (silent 20.9h,
  // alerted 2026-08-12). Unlike the poller lanes, nothing else ever wrote
  // this bare name: the watermark is worker-internal, so there is no
  // producer-side usage record to keep the old spelling alive. The retirement
  // test pins this to code rather than to a deleted file: the live writer
  // provably cannot produce the bare key.
  "raw-capture-state",
  // The SAME #10851 fossil, two more spellings (alerted 2026-08-12, "silent
  // 21.9h" apiece). Both stopped receiving verdicts at 2026-08-11T23:35Z --
  // the same instant as each other, which is the signature of a writer that
  // changed its key rather than of two lanes independently dying -- while
  // `neon:neurons` and `neon:tao-usd-index` were both `ok` on the same read
  // ("11 statement(s) flushed", "10 statement(s) flushed", 22:01Z the next
  // day). Since #10851 every verdict for these lanes lands under the
  // prefixed key, and nothing else writes the bare ones: unlike
  // `account-balances` and `validator-nominators`, whose bare names carry the
  // POLLER's own scan outcome ("558009 scanned, 366107 written") and are
  // therefore live, these two are written only from inside the Worker.
  "neurons",
  "tao-usd-index",
];

/**
 * Retired lane FAMILIES, by prefix.
 *
 * `neon:backfill:<table>` was one lane per table reconciled, named at runtime from
 * NEON_BACKFILL_LANES. Both the flag and src/neon-backfill.ts are gone, and 24 of
 * these rows remain -- including `neon:backfill:tao_usd_index`, whose verdict says
 * `stale` while its own detail says "0 date(s) / 0 row(s) still behind". A prefix
 * rather than 24 names because the family is defined by its producer, not its members:
 * a table nobody ever named cannot come back.
 */
export const RETIRED_LANE_PREFIXES: readonly string[] = ["neon:backfill:"];

/** Whether `lane`'s producer has been deleted. */
export function isRetiredLane(lane: string): boolean {
  return (
    RETIRED_LANES.includes(lane) ||
    RETIRED_LANE_PREFIXES.some((prefix) => lane.startsWith(prefix))
  );
}

/** The minimal D1 surface these helpers use, so callers can inject a fake. */
/** The verdict store's surface, with OUR verbs (#10909) -- rows and change
 * counts, no D1 envelope. Structural so every watchdog test keeps handing in
 * a plain object. */
export interface LaneHealthDb {
  query(text: string, values?: unknown[]): Promise<unknown[]>;
  run(text: string, values?: unknown[]): Promise<{ changes: number }>;
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
  if (!db?.run) return false;
  try {
    await db.run(
      "INSERT INTO lane_health (lane, verdict, age_ms, detail, checked_at) " +
        "VALUES (?, ?, ?, ?, ?)",
      [
        record.lane,
        record.verdict,
        record.age_ms,
        record.detail,
        record.checked_at,
      ],
    );
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
    await db.run("DELETE FROM lane_health WHERE lane = ? AND checked_at < ?", [
      record.lane,
      record.checked_at - LANE_HEALTH_RETENTION_MS,
    ]);
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
  if (!db?.query) return {};
  try {
    // One row per lane via a correlated MAX, rather than pulling the whole table and
    // reducing in the Worker: the table grows by one row per lane per tick forever, so
    // a full scan here would get slower every day this runs.
    const rows = (await db.query(
      "SELECT lane, verdict, age_ms, detail, checked_at FROM lane_health " +
        "WHERE (lane, checked_at) IN " +
        "(SELECT lane, MAX(checked_at) FROM lane_health GROUP BY lane)",
    )) as Record<string, unknown>[];
    const out: Record<string, LaneHealthRecord> = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      // Filtered HERE rather than in the SQL so the rule is one testable
      // predicate shared by every caller, and so a row that outlives its
      // deletion is still visible to anyone querying the table directly.
      if (isRetiredLane(lane)) continue;
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
