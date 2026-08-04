// Per-subnet weight-setter leaderboard: for ONE subnet over a 7d/30d window, the individual
// validators driving consensus — each setter's WeightsSet event count, its share of the
// subnet's total weight-setting, and when it first/last set weights in the window — ranked by
// activity. The drill-in behind /api/v1/subnets/{netuid}/weights, which only reports the
// aggregate (distinct setters + total events + intensity) and never names the setters. Read
// live from the account_events WeightsSet stream. Pure shaping (buildSubnetWeightSetters) + a
// thin D1 loader (loadSubnetWeightSetters); the Worker adds the envelope. Null-safe: a cold
// store or a subnet with no WeightsSet events yields a schema-stable empty leaderboard.

import { WEIGHTS_EVENT_KIND } from "./subnet-weights.ts";

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// Supported windows (label -> days) + default, matching the sibling /weights route.
export const SUBNET_WEIGHT_SETTERS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
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
function round(value: number, dp = 4): number {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A representative uid cell -> non-negative integer, or null when absent/non-integer. A
// hotkey-identified setter may carry no uid, so this stays nullable.
function toUid(value: unknown): number | null {
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
function toHotkey(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// Newest/oldest epoch-ms observed_at -> ISO, or null when not finite/absent. Guards the JS
// Date range so a finite but out-of-range epoch cannot throw, mirroring the sibling routes.
function toIso(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Nominal seconds per block. Subtensor targets 12s and this repo already reasons in it
 * throughout (chain-detail-prune, the staleness watchdogs, the events cold tier).
 *
 * It is NOMINAL on purpose. `tempo` is expressed in blocks and `last_set_at` is a
 * wall-clock stamp, so converting between them requires a block time, and the chain's
 * real one drifts. That drift is why the overdue rule below is a coarse multiple of
 * tempo rather than a tight deadline: a rule that fired on a few seconds of block-time
 * drift would be noise, and noise in an alarm is worse than no alarm.
 */
export const NOMINAL_BLOCK_SECONDS = 12;

/**
 * How many tempos a setter may fall behind before it is reported overdue.
 *
 * ONE missed tempo is ordinary: a restart, a slow epoch, a few seconds of block-time
 * drift against the nominal 12s above. Alarming on it would page an operator for a
 * healthy validator, which is the failure #9330 spent a whole PR removing from the
 * watchdogs — a threshold has to sit above its producer's own cadence.
 *
 * THREE is comfortably above that jitter and still far below the cases this exists to
 * catch. Measured live on 2026-08-04, SN8 had two setters past it: one ~6 tempos behind
 * and one ~126 tempos (6.3 days) behind, the latter having set weights 45 times earlier
 * in the same window — a healthy-looking count with a dead tail, which is precisely what
 * `weight_sets` alone hides.
 */
export const OVERDUE_TEMPO_MULTIPLE = 3;

/**
 * A usable `tempo`, or null.
 *
 * Bounded to the u16 the chain actually stores it in, not merely "finite and positive".
 * An unbounded check accepts 1.5e308, which is finite, positive, and makes every setter
 * read as 0 tempos behind — i.e. a confident `overdue: false` for the entire subnet,
 * derived from a value that cannot exist. Zero is excluded for the same reason: it is
 * not a cadence, and dividing by it would report Infinity tempos behind.
 */
const MAX_TEMPO_BLOCKS = 65535;

function toTempoBlocks(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n > 0 && n <= MAX_TEMPO_BLOCKS ? n : null;
}

/**
 * How far behind one setter is, in tempos, and whether that is overdue.
 *
 * Every field is null when it cannot be computed — an unknown tempo, an unreadable
 * `last_set_at`, or an `observed_at` this window never saw. `overdue: null` means "not
 * evaluated", which is deliberately distinct from `false` ("evaluated, on time"): the
 * whole point of the change is to tell an operator something, and a silent `false` for a
 * setter we could not measure would be the confident-wrong-answer this repo keeps
 * removing.
 */
interface OverdueView {
  seconds_since_last_set: number | null;
  tempos_since_last_set: number | null;
  /** null = not evaluated; false = evaluated and on time. */
  overdue: boolean | null;
}

function overdueView(
  lastSetMs: number | null,
  observedMs: number | null,
  tempo: number | null,
): OverdueView {
  if (lastSetMs == null || observedMs == null || tempo == null) {
    return {
      seconds_since_last_set: null,
      tempos_since_last_set: null,
      overdue: null,
    };
  }
  // Measured against the window's own newest event, not wall-clock now: the payload is
  // then internally consistent, and a stale read reports the lag it actually observed
  // rather than one inflated by how long ago the tier answered.
  const elapsedSeconds = Math.max(
    0,
    Math.round((observedMs - lastSetMs) / 1000),
  );
  const tempoSeconds = tempo * NOMINAL_BLOCK_SECONDS;
  const tempos = Math.round((elapsedSeconds / tempoSeconds) * 100) / 100;
  return {
    seconds_since_last_set: elapsedSeconds,
    tempos_since_last_set: tempos,
    overdue: tempos > OVERDUE_TEMPO_MULTIPLE,
  };
}

// Shape the leaderboard from the per-setter aggregate rows plus the subnet-wide totals row.
// `rows` are already ordered by activity (newest-first tiebreak); `totals` carries weight_sets
// (COUNT(*)), distinct_setters (COUNT(DISTINCT identity)) and newest_observed (MAX). Each
// setter's share is its count over the subnet total, null when the total is zero (no rows).
// Null-safe: null/absent inputs yield the schema-stable empty card.
export function buildSubnetWeightSetters(
  rows: Row[] | null | undefined,
  totals: Row | null | undefined,
  netuid: unknown,
  { window, tempo }: { window?: string; tempo?: unknown } = {},
): Row {
  const list = Array.isArray(rows) ? rows : [];
  const totalSets = toCount(totals?.weight_sets);
  // #9389: the subnet's own cadence, which turns `last_set_at` from a fact into a
  // verdict. Absent (no hyperparams row) leaves every overdue field null rather than
  // defaulting to some assumed tempo -- subnets set their own, and guessing one would
  // manufacture alarms on the subnets we know least about.
  const tempoBlocks = toTempoBlocks(tempo);
  const observedMs = Number(totals?.newest_observed);
  const observed =
    Number.isFinite(observedMs) && observedMs > 0 ? observedMs : null;

  const setters = list.map((row) => {
    const weightSets = toCount(row?.weight_sets);
    const lastMs = Number(row?.last_set);
    return {
      hotkey: toHotkey(row?.hotkey),
      uid: toUid(row?.uid),
      weight_sets: weightSets,
      share: totalSets > 0 ? round(weightSets / totalSets) : null,
      first_set_at: toIso(row?.first_set),
      last_set_at: toIso(row?.last_set),
      ...overdueView(
        Number.isFinite(lastMs) && lastMs > 0 ? lastMs : null,
        observed,
        tempoBlocks,
      ),
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
    // Echoed so a consumer can see WHICH cadence the verdict was measured against, and
    // so a null overdue is explainable from the payload alone rather than by guessing.
    tempo: tempoBlocks,
    overdue_tempo_multiple: OVERDUE_TEMPO_MULTIPLE,
    // Counts only setters actually evaluated; `null` overdue rows are not "on time".
    overdue_setter_count: setters.filter((s) => s.overdue === true).length,
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
  d1: D1Runner,
  netuid: number,
  { windowLabel, windowDays }: { windowLabel?: string; windowDays: number },
): Promise<Row> {
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
  // #9389: this subnet's own tempo, from the same D1 the reads above use. A third
  // single-row indexed lookup by primary key, not a scan -- and it is deliberately NOT
  // fatal: if the hyperparams row is missing the leaderboard still serves, with the
  // overdue fields null. Losing the whole card because a cadence was unknown would trade
  // a useful answer for no answer.
  const tempo = await d1(
    "SELECT tempo FROM subnet_hyperparams WHERE netuid = ?",
    [netuid],
  )
    .then((hp) => hp?.[0]?.tempo ?? null)
    .catch(() => null);
  return buildSubnetWeightSetters(rows, totals?.[0] ?? null, netuid, {
    window: windowLabel,
    tempo,
  });
}
