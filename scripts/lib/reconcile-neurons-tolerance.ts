// Pure drift-tolerance helpers for scripts/reconcile-neurons.ts.
// Kept dependency-free so unit tests can import without loading Postgres /
// lib.ts / observability.

// Below this absolute TAO delta, a mismatch is never flagged regardless of
// relative size -- avoids false positives on near-zero stakes where a tiny
// absolute change looks like a huge percentage. Above it, tolerate up to 2%
// relative drift before flagging a single row: ordinary staking/unstaking
// activity between refresh-metagraph's last write and this reconciler's own
// fetch produces real, benign per-row differences at this scale.
export const ABSOLUTE_FLOOR_TAO = 0.01;
export const RELATIVE_TOLERANCE = 0.02;
// RATIO, not a fixed count: refresh-metagraph runs DAILY (not hourly --
// corrected after live testing against the real box, 2026-07-15), so
// Postgres can legitimately be up to ~24h stale depending on where in the
// cycle this job runs relative to it. A fixed small count would alert on
// every single run purely from that lag (confirmed live: 15% of all rows
// individually exceeded per-row tolerance after ~7h of staleness, entirely
// explained by ordinary network-wide staking activity, not a bug). A ratio
// scales with however stale Postgres happens to be and stays meaningful
// regardless of network size. 30% is deliberately conservative pending real
// drift history to tune against -- scheduled to run shortly after
// refresh-metagraph's own daily fire (roles/data-refresh-node's job vars)
// specifically to keep legitimate lag-driven drift low, so a genuine
// systemic break (stalled sync, decode bug) should clear this threshold by
// a wide margin rather than needing to be tuned razor-close to it.
export const ALERT_THRESHOLD_RATIO = 0.3;

export function fieldsDiffer(
  liveValue: unknown,
  storedValue: unknown,
): boolean {
  const live = Number(liveValue);
  const stored = storedValue === null ? null : Number(storedValue);
  if (!Number.isFinite(live)) return false; // fetch didn't produce a value for this field -- not this reconciler's problem
  if (stored === null || !Number.isFinite(stored)) return true; // Postgres has no comparable value at all
  const delta = Math.abs(live - stored);
  if (delta <= ABSOLUTE_FLOOR_TAO) return false;
  const tolerance = Math.max(
    ABSOLUTE_FLOOR_TAO,
    RELATIVE_TOLERANCE * Math.abs(live),
  );
  return delta > tolerance;
}

/** Pure gate for the alert ratio check in reconcile-neurons `main`. */
export function exceedsAlertThreshold(mismatchRatio: number): boolean {
  return mismatchRatio >= ALERT_THRESHOLD_RATIO;
}
