// The poller's own job outcomes, made queryable (metagraphed-infra#343 phase 1).
//
// WHAT THIS FIXES, precisely. On 2026-08-05 `hotkey_alpha` held zero rows for
// about ten hours. It was never slow and never stuck: it failed **95 seconds**
// into every run -- its publish floor was larger than the map it guarded -- and
// then slept 24 hours. Nothing anywhere reported that, because:
//
//   * `wrangler tail` on the poller shows nothing during a scan. The job only
//     logs once it starts POSTing, so a failure BEFORE that point is silent.
//   * `lane_health` held only WATCHDOG verdicts, and watchdogs are Worker-side.
//     Its silence about `hotkey-alpha` meant "no watchdog ran", not "the lane is
//     fine" -- an absence that reads exactly like health.
//   * Every staleness watchdog keys on `MAX(captured_at)`, and a table that has
//     NEVER held a row has no timestamp to age. A lane that has never once
//     succeeded is invisible to the exact mechanism built to catch lanes that
//     stopped.
//
// Hours went into inferring the cause from row counts. Running the job locally
// answered it in 95 seconds. The difference was not diagnosis skill, it was
// having somewhere to look.
//
// SO THE PRODUCER REPORTS, rather than the reader inferring. `log_job_outcome`
// in the poller already computes everything needed -- scanned, written, errors,
// elapsed, and whether the tick succeeded -- and only printed it. It now posts
// here, and a failed tick becomes a row.
//
// WHY THIS IS NOT JUST ANOTHER NOTIFICATION. src/lane-health.ts's own header
// makes the argument and it applies unchanged: a notification answers "was
// anyone paged", a row answers "was anything broken overnight". This is the
// second question, for the half of the system D1 could not see.
//
// A REPORT IS NOT A MEASUREMENT OF ITSELF. A lane that never runs at all still
// writes nothing here -- exactly like the watchdogs it complements. That gap is
// closed by `neverSucceededLanes` below, which asks which lanes are EXPECTED and
// have no successful tick, rather than waiting for a lane to tell on itself.

import type { LaneVerdict } from "./lane-health.ts";

/** The poller lanes that are expected to report. Absence from `lane_health` is
 * only meaningful against a list of what SHOULD be there -- see
 * neverSucceededLanes. Mirrors POLLER_ONLY in metagraphed-infra's
 * Dockerfile.poller; the wiring guard there keeps that list honest. */
export const EXPECTED_POLLER_LANES = [
  "account-balances",
  "account-identity",
  "chain-detail",
  "hotkey-alpha",
  "metagraph",
  "subnet-hyperparams",
  "validator-nominators",
] as const;

/** One reported tick, in the shape the poller posts. */
export interface PollerJobOutcome {
  lane: string;
  /** `ok` when the tick completed, `stale` when it failed. `unknown` is not
   * used here: the producer always knows which happened, unlike a watchdog that
   * may be unable to evaluate at all. */
  verdict: LaneVerdict;
  /** How long the tick took. Named for lane_health's column rather than for
   * what it measures, so one table answers one question. */
  age_ms: number | null;
  /** The job's own message, kept verbatim -- this is the line that would
   * otherwise have gone to a container stderr nobody can read. */
  detail: string | null;
  checked_at: number;
}

const MAX_DETAIL_CHARS = 2_000;

/**
 * Validate one reported outcome.
 *
 * DELIBERATELY PERMISSIVE ABOUT `lane`. A new poller lane must be able to
 * report on its FIRST run, before anyone has added it to a list here -- the
 * alternative is that the newest lane, which is the one most likely to be
 * broken, is the one that cannot tell you. `EXPECTED_POLLER_LANES` is used for
 * the absence check, not as an allowlist for writes.
 */
export function validPollerJobOutcome(
  row: unknown,
): row is Record<string, unknown> {
  const r = row as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return false;
  if (typeof r.lane !== "string" || !r.lane || r.lane.length > 64) return false;
  if (r.verdict !== "ok" && r.verdict !== "stale" && r.verdict !== "unknown") {
    return false;
  }
  if (
    r.age_ms != null &&
    (typeof r.age_ms !== "number" || !Number.isFinite(r.age_ms) || r.age_ms < 0)
  ) {
    return false;
  }
  if (r.detail != null && typeof r.detail !== "string") return false;
  if (
    typeof r.checked_at !== "number" ||
    !Number.isInteger(r.checked_at) ||
    r.checked_at <= 0
  ) {
    return false;
  }
  return true;
}

/** Project a validated row onto the lane_health record shape, truncating the
 * detail. An error message can carry a whole decode dump; the first couple of
 * thousand characters are the triage value and the rest is table growth. */
export function coercePollerJobOutcome(
  row: Record<string, unknown>,
): PollerJobOutcome {
  const detail = typeof row.detail === "string" ? row.detail : null;
  return {
    lane: row.lane as string,
    verdict: row.verdict as LaneVerdict,
    age_ms: typeof row.age_ms === "number" ? Math.round(row.age_ms) : null,
    detail: detail ? detail.slice(0, MAX_DETAIL_CHARS) : null,
    checked_at: row.checked_at as number,
  };
}

/**
 * Which expected lanes have NEVER reported a successful tick.
 *
 * THE QUESTION NO STALENESS WATCHDOG CAN ASK. They all key on how old the newest
 * success is, so a lane with zero successes has no age and produces no verdict --
 * `hotkey-alpha` was invisible for ten hours for exactly this reason. Asking
 * which lanes are missing from a set of successes inverts it: absence becomes
 * the signal instead of the blind spot.
 *
 * Pure, so the rule is testable without a database.
 */
export function neverSucceededLanes(
  succeeded: Iterable<string>,
  expected: readonly string[] = EXPECTED_POLLER_LANES,
): string[] {
  const seen = new Set(succeeded);
  return expected.filter((lane) => !seen.has(lane));
}
