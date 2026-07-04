// Network-wide weight-setter leaderboard: across EVERY subnet over a 7d/30d window, the
// individual validators driving consensus network-wide — each setter's total WeightsSet event
// count (summed across every subnet it operates on), its share of the network total, and when it
// first/last set weights in the window — ranked by activity. The network-wide drill-in behind
// /api/v1/chain/weights, which only reports the aggregate (distinct setters + total events +
// intensity per subnet) and never names the setters across the whole network — the same relationship
// /api/v1/subnets/{netuid}/weights/setters has to its own /weights. Read live from the account_events
// WeightsSet stream. Pure shaping (buildChainWeightSetters) + a thin D1 loader
// (loadChainWeightSetters); the Worker adds the envelope. Null-safe: a cold store yields a
// schema-stable empty leaderboard.

import { WEIGHTS_EVENT_KIND } from "./chain-weights.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Supported windows (label -> days) + default, matching the sibling /chain/weights route.
export const CHAIN_WEIGHT_SETTERS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW = "7d";
export const CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT = 20;
export const CHAIN_WEIGHT_SETTERS_LIMIT_MAX = 100;

// WeightsSet ingestion can omit hotkey, so a setter is identified by its hotkey when present
// (a hotkey is a network-wide identity, so this correctly merges one validator's activity across
// every subnet it sets weights on), else by its (netuid, uid) — a uid alone has no meaning outside
// its own subnet, so a uid-only setter stays scoped to the subnet it was observed on, exactly
// mirroring the sibling subnet-weight-setters.mjs identity. Rows whose identity is NULL (no hotkey
// AND no uid) are excluded from the leaderboard rather than collapsed into one bogus setter.
const SETTER_IDENTITY =
  "CASE " +
  "WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey " +
  "WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid " +
  "ELSE NULL END";

// Round a share to a stable 4dp precision WITHOUT letting a sub-1 share round up to an exact 1 —
// a setter that drove < 100% of the network's weight-setting must not read as a flat 1 while
// another setter still holds activity (e.g. 49999/50000 = 0.99998 -> 1.0000). Mirrors the
// anti-overstatement guard in subnet-weight-setters.mjs. A genuine sole setter (its count == the
// network total) keeps a true 1.
function round(value, dp = 4) {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A representative uid cell -> non-negative integer, or null when absent/non-integer.
function toUid(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// A representative hotkey cell -> non-empty string, or null when absent/blank.
function toHotkey(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// Newest/oldest epoch-ms observed_at -> ISO, or null when not finite/absent. Guards the JS Date
// range so a finite but out-of-range epoch cannot throw, mirroring the sibling routes.
function toIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Shape the network-wide leaderboard from the per-setter aggregate rows plus the network-wide
// totals row. `rows` are already ordered by activity (newest-first tiebreak) from the loader;
// `totals` carries weight_sets (COUNT(*)), distinct_setters (COUNT(DISTINCT identity)) and
// newest_observed (MAX), all network-wide (no netuid filter). `limit` caps the returned page;
// `distinct_setters` always reports the true network-wide total regardless of `limit`. Each
// setter's share is its count over the network total, null when the total is zero (no rows).
// Null-safe: null/absent inputs yield the schema-stable empty card.
export function buildChainWeightSetters(
  rows,
  totals,
  { window, limit = CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_WEIGHT_SETTERS_LIMIT_MAX))
    : CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT;
  const totalSets = toCount(totals?.weight_sets);
  const setters = list.slice(0, normalizedLimit).map((row) => {
    const weightSets = toCount(row?.weight_sets);
    return {
      hotkey: toHotkey(row?.hotkey),
      uid: toUid(row?.uid),
      weight_sets: weightSets,
      share: totalSets > 0 ? round(weightSets / totalSets) : null,
      first_set_at: toIso(row?.first_set),
      last_set_at: toIso(row?.last_set),
    };
  });
  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(totals?.newest_observed),
    distinct_setters: toCount(totals?.distinct_setters),
    weight_sets: totalSets,
    setter_count: setters.length,
    setters,
  };
}

// The network-wide weight-setter leaderboard, computed live. Two bounded reads over the
// account_events WeightsSet stream over the window (observed_at >= now - windowDays, epoch ms; no
// netuid filter): the per-setter leaderboard (GROUP BY the hotkey-or-(netuid,uid) identity, top-N
// by count) and the network-wide totals (count + true distinct setters + newest observed_at,
// matching /chain/weights). Cold/absent store -> the schema-stable empty card.
export async function loadChainWeightSetters(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT MAX(hotkey) AS hotkey, MAX(uid) AS uid, COUNT(*) AS weight_sets, " +
      "MIN(observed_at) AS first_set, MAX(observed_at) AS last_set " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ? " +
      "AND (" +
      SETTER_IDENTITY +
      ") IS NOT NULL GROUP BY " +
      SETTER_IDENTITY +
      " ORDER BY weight_sets DESC, last_set DESC LIMIT ?",
    [WEIGHTS_EVENT_KIND, cutoff, CHAIN_WEIGHT_SETTERS_LIMIT_MAX],
  );
  const totals = await d1(
    "SELECT COUNT(*) AS weight_sets, COUNT(DISTINCT " +
      SETTER_IDENTITY +
      ") AS distinct_setters, MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ?",
    [WEIGHTS_EVENT_KIND, cutoff],
  );
  return buildChainWeightSetters(rows, totals?.[0] ?? null, {
    window: windowLabel,
    limit,
  });
}
