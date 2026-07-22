// Per-subnet weight-setter leaderboard: for ONE subnet over a 7d/30d window, the individual
// validators driving consensus — each setter's WeightsSet event count, its share of the
// subnet's total weight-setting, and when it first/last set weights in the window — ranked by
// activity. The drill-in behind /api/v1/subnets/{netuid}/weights, which only reports the
// aggregate (distinct setters + total events + intensity) and never names the setters. Read
// live from the account_events WeightsSet stream. Pure shaping (buildSubnetWeightSetters) + a
// thin D1 loader (loadSubnetWeightSetters); the Worker adds the envelope. Null-safe: a cold
// store or a subnet with no WeightsSet events yields a schema-stable empty leaderboard.

import { WEIGHTS_EVENT_KIND } from "./subnet-weights.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// Supported windows (label -> days) + default, matching the sibling /weights route.
export const SUBNET_WEIGHT_SETTERS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW = "7d";
// Leaderboard cap — the top-N most active setters. Bounds the response and the D1 read; a
// subnet rarely has more than a few dozen active setters in a 7d/30d window.
export const SUBNET_WEIGHT_SETTERS_LIMIT = 50;

// WeightsSet ingestion can omit hotkey, so a setter is identified by its hotkey when present,
// else by its (netuid, uid) — mirroring the sibling /weights distinct-setter count so the two
// routes agree on who a "setter" is. Rows whose identity is NULL (no hotkey AND no uid) are
// excluded from the leaderboard rather than collapsed into one bogus setter.
const SETTER_IDENTITY =
  "CASE " +
  "WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey " +
  "WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid " +
  "ELSE NULL END";

// Round a share to a stable 4dp precision WITHOUT letting a sub-1 share round up to an
// exact 1 -- a setter that drove < 100% of the subnet's weight-setting must not read as a
// flat 1 while another setter still holds activity (e.g. 49999/50000 = 0.99998 -> 1.0000).
// The same anti-overstatement guard the sibling share/ratio rounders apply. A genuine sole
// setter (its count == the subnet total) keeps a true 1.
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

// A representative uid cell -> non-negative integer, or null when absent/non-integer. A
// hotkey-identified setter may carry no uid, so this stays nullable.
function toUid(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// A representative hotkey cell -> non-empty string, or null when absent/blank (a uid-only
// setter has no hotkey).
function toHotkey(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// Newest/oldest epoch-ms observed_at -> ISO, or null when not finite/absent. Guards the JS
// Date range so a finite but out-of-range epoch cannot throw, mirroring the sibling routes.
function toIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Shape the leaderboard from the per-setter aggregate rows plus the subnet-wide totals row.
// `rows` are already ordered by activity (newest-first tiebreak); `totals` carries weight_sets
// (COUNT(*)), distinct_setters (COUNT(DISTINCT identity)) and newest_observed (MAX). Each
// setter's share is its count over the subnet total, null when the total is zero (no rows).
// Null-safe: null/absent inputs yield the schema-stable empty card.
export function buildSubnetWeightSetters(
  rows,
  totals,
  netuid,
  { window } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const totalSets = toCount(totals?.weight_sets);
  const setters = list.map((row) => {
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
    netuid,
    window: window ?? null,
    observed_at: toIso(totals?.newest_observed),
    distinct_setters: toCount(totals?.distinct_setters),
    weight_sets: totalSets,
    setter_count: setters.length,
    setters,
  };
}

// One subnet's weight-setter leaderboard, computed live. Two bounded, indexed reads over the
// account_events WeightsSet stream for this netuid within the window (observed_at >= now -
// windowDays, epoch ms; served by idx_account_events(netuid, event_kind, ...) from migration
// 0024): the per-setter leaderboard (GROUP BY the hotkey-or-uid identity, top-N by count) and
// the subnet-wide totals (count + true distinct setters + newest observed_at, matching
// /weights). Cold/absent store -> the schema-stable empty card.
export async function loadSubnetWeightSetters(
  d1,
  netuid,
  { windowLabel, windowDays } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT MAX(hotkey) AS hotkey, MAX(uid) AS uid, COUNT(*) AS weight_sets, " +
      "MIN(observed_at) AS first_set, MAX(observed_at) AS last_set " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ? " +
      "AND (" +
      SETTER_IDENTITY +
      ") IS NOT NULL GROUP BY " +
      SETTER_IDENTITY +
      " ORDER BY weight_sets DESC, last_set DESC LIMIT ?",
    [netuid, WEIGHTS_EVENT_KIND, cutoff, SUBNET_WEIGHT_SETTERS_LIMIT],
  );
  const totals = await d1(
    "SELECT COUNT(*) AS weight_sets, COUNT(DISTINCT " +
      SETTER_IDENTITY +
      ") AS distinct_setters, MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, WEIGHTS_EVENT_KIND, cutoff],
  );
  return buildSubnetWeightSetters(rows, totals?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
