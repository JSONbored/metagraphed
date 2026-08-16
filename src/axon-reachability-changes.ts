// What actually happens when a subnet's announced axons disappear (#10805).
//
// ## The event does not exist, so this is derived from state
//
// `AxonInfoRemoved` has ZERO occurrences in the complete pallet-level stream,
// genesis to head (898M rows, measured 2026-08-03). The three axon-removal
// routes were modelled on it and have answered a permanent zero ever since.
// The chain never emits the event; it does perform the state transition, and
// `neuron_daily` records the state daily.
//
// ## The naive derivation is 95% WRONG, which is why this module exists
//
// The obvious implementation -- "had a routable axon yesterday, does not
// today" -- reports every one of these as a removal. Measured over the full
// 38 days `neuron_daily` retains (2026-07-10 to 08-16), network-wide:
//
//   deregistration, the UID changed hands      1,915   the newcomer never served
//   moved to an unroutable address               166   still announcing
//   truly stopped announcing                     105   the only real removal
//   total                                      2,186
//
// So 2,081 of 2,186 are not removals. Reporting them as such is the error
// #11370 and #11392 each fixed inside the watchdog; putting it on a public
// contract would repeat it somewhere consumers cannot see it.
//
// SN126 is the case that makes this concrete: 160 same-hotkey transitions over
// 14 days, the largest source on the network and larger than the SN101 event
// #11328 was filed for -- and almost entirely MOVES. Run the same window with
// `axon IS NOT NULL` instead of the routable test and SN126 has one.
//
// ## ONE definition, shared with the alarm
//
// `AXON_TRANSITION_SEQ_SQL` is the single window definition. The
// axon-announcement watchdog reads it too, so the alarm and the API cannot
// drift about what a withdrawal is -- which is the failure this whole family
// keeps producing. `src/axon-routable.ts` owns the routability predicate
// underneath it, shared in turn with the serving path (#11376).
//
// ## What this cannot answer, and says so
//
// Daily resolution, because the source is a daily snapshot: a transition is
// dated to a day and carries no block height. Bounded by retention, currently
// 38 days -- a longer window is not an empty page, it is out of range. Both
// are stated in the response rather than left for a caller to discover.
//
// ## THE NEWEST DAY IS STILL BEING WRITTEN
//
// Measured 2026-08-16: every completed `snapshot_date` carries exactly ONE
// `captured_at` (written ~23:46 UTC), and the current day carried TWO, fifteen
// minutes apart, with rows moving between them. Running the same aggregate
// forty minutes apart returned 1,915 then 1,916 deregistrations off the same
// query.
//
// So the newest day is not a settled observation. A UID can read
// `stopped-announcing` on one request and `moved-unroutable` on the next,
// because the row the comparison rests on was refreshed in between -- and
// nothing about the response would show that it moved.
//
// Every scope therefore reports `start_date` and `end_date` for what it
// actually read, and flags the trailing day as unsettled rather than
// presenting it as final. Silently excluding it would be worse: a caller
// asking for 7d would get 6 and no way to tell.

import { ROUTABLE_AXON_SQL } from "./axon-routable.ts";
import { windowCoverage } from "./turnover.ts";

/**
 * How a UID stopped having a reachable axon.
 *
 * - `deregistered`: the UID changed hands. The announcing miner is gone and
 *   the newcomer never served. Nobody withdrew anything.
 * - `moved-unroutable`: the SAME miner is still announcing, at an address in
 *   documentation or private space that nothing can reach.
 * - `stopped-announcing`: the same miner stopped publishing an axon at all.
 *   The only one that means what "axon removal" sounds like.
 */
export type AxonChangeKind =
  "deregistered" | "moved-unroutable" | "stopped-announcing";

export const AXON_CHANGE_KINDS: readonly AxonChangeKind[] = [
  "deregistered",
  "moved-unroutable",
  "stopped-announcing",
];

/** Days of history the source table retains, and therefore the widest window. */
export const AXON_CHANGES_MAX_WINDOW_DAYS = 38;

/**
 * The per-UID day-over-day sequence every scope reads from.
 *
 * Emits one row per (netuid, uid, snapshot_date) carrying the previous day's
 * routability, hotkey and axon, so a transition is a comparison between two
 * adjacent columns rather than a self-join. `prev_hotkey` is what separates a
 * deregistration from a withdrawal, and `axon` is what separates a move from a
 * stop -- both were missing from earlier versions of this question, and each
 * omission produced a confidently wrong answer.
 */
export const AXON_TRANSITION_SEQ_SQL =
  "SELECT netuid, uid, snapshot_date, hotkey, coldkey, axon, " +
  `(${ROUTABLE_AXON_SQL}) AS routable, ` +
  `LAG(${ROUTABLE_AXON_SQL}) OVER w AS prev_routable, ` +
  "LAG(hotkey) OVER w AS prev_hotkey, LAG(axon) OVER w AS prev_axon " +
  "FROM neuron_daily";

/** The window clause `AXON_TRANSITION_SEQ_SQL` needs. Kept adjacent so a
 * caller cannot use one without the other. */
export const AXON_TRANSITION_WINDOW_SQL =
  "WINDOW w AS (PARTITION BY netuid, uid ORDER BY snapshot_date)";

/**
 * A UID that HAD a reachable axon and no longer does.
 *
 * Deliberately not "lost an axon": a move keeps the axon and loses only the
 * reachability, and that distinction is the whole point of the family.
 */
export const AXON_CHANGE_PREDICATE_SQL = "prev_routable AND NOT routable";

/**
 * The kind, as a SQL CASE, so aggregation and row listing agree by
 * construction rather than by two developers reading the same comment.
 *
 * ORDER MATTERS. A deregistration is decided first and unconditionally: when
 * the UID changed hands the newcomer's axon says nothing about what the
 * previous occupant did, so asking "is it still announcing" would attribute
 * the newcomer's state to a miner that has left.
 */
export const AXON_CHANGE_KIND_SQL =
  "CASE WHEN hotkey IS DISTINCT FROM prev_hotkey THEN 'deregistered' " +
  "WHEN axon IS NOT NULL AND axon <> '' THEN 'moved-unroutable' " +
  "ELSE 'stopped-announcing' END";

/** One derived transition, as the routes serve it. */
export interface AxonReachabilityChange {
  netuid: number;
  uid: number;
  date: string;
  kind: AxonChangeKind;
  hotkey: string | null;
  /** The hotkey that was announcing. Differs from `hotkey` on a deregistration. */
  previous_hotkey: string | null;
  coldkey: string | null;
  /** The address that was reachable. */
  previous_axon: string | null;
  /** What is announced now: an unroutable address on a move, else null. */
  current_axon: string | null;
}

/** A non-negative integer, or null for anything that is not one. */
function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A non-empty string, or null. Blank and absent are the same claim here. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The kind a row carries, validated against the closed set.
 *
 * An unrecognised value returns null and the caller DROPS the row. Defaulting
 * to any of the three would attribute a mechanism nothing measured -- the
 * mistake #11381 fixed in the alarm, which had defaulted to the loudest
 * reading and published it as a finding.
 */
export function axonChangeKind(value: unknown): AxonChangeKind | null {
  return typeof value === "string" &&
    (AXON_CHANGE_KINDS as readonly string[]).includes(value)
    ? (value as AxonChangeKind)
    : null;
}

/** Shape one derived row, or null when it is not usable. */
export function toAxonReachabilityChange(
  row: Record<string, unknown> | null | undefined,
): AxonReachabilityChange | null {
  const netuid = intOrNull(row?.netuid);
  const uid = intOrNull(row?.uid);
  const date = textOrNull(row?.snapshot_date ?? row?.date);
  const kind = axonChangeKind(row?.kind);
  if (netuid == null || uid == null || date == null || kind == null)
    return null;
  return {
    netuid,
    uid,
    date,
    kind,
    hotkey: textOrNull(row?.hotkey),
    previous_hotkey: textOrNull(row?.prev_hotkey ?? row?.previous_hotkey),
    coldkey: textOrNull(row?.coldkey),
    previous_axon: textOrNull(row?.prev_axon ?? row?.previous_axon),
    current_axon: textOrNull(row?.axon ?? row?.current_axon),
  };
}

/** Counts by kind, always carrying every kind so a zero is stated not absent. */
export interface AxonChangeBreakdown {
  deregistered: number;
  moved_unroutable: number;
  stopped_announcing: number;
  total: number;
}

export function emptyAxonChangeBreakdown(): AxonChangeBreakdown {
  return {
    deregistered: 0,
    moved_unroutable: 0,
    stopped_announcing: 0,
    total: 0,
  };
}

/**
 * Tally a set of changes by kind.
 *
 * EVERY KIND IS PRESENT even at zero. "No miner stopped announcing" is a
 * finding worth stating, and an absent key reads as "not measured" -- the
 * distinction this family has got wrong at every previous turn.
 */
export function tallyAxonChanges(
  changes: readonly AxonReachabilityChange[] | null | undefined,
): AxonChangeBreakdown {
  const out = emptyAxonChangeBreakdown();
  for (const change of changes ?? []) {
    if (change?.kind === "deregistered") out.deregistered += 1;
    else if (change?.kind === "moved-unroutable") out.moved_unroutable += 1;
    else if (change?.kind === "stopped-announcing") out.stopped_announcing += 1;
    else continue;
    out.total += 1;
  }
  return out;
}

/**
 * The provenance every scope stamps onto its answer.
 *
 * NOT a `degraded` block. Degraded means "we could not measure"; this is a
 * complete measurement of a different thing from what the route name implies,
 * and saying so is the point. The family answered a permanent zero for months
 * behind an honest degraded marker -- an honest marker on a useless answer is
 * still a useless answer.
 */
export interface AxonChangesDerivation {
  source: "neuron_daily";
  resolution: "daily";
  /** Widest window the retained history can answer, in days. */
  max_window_days: number;
  note: string;
}

export function axonChangesDerivation(): AxonChangesDerivation {
  return {
    source: "neuron_daily",
    resolution: "daily",
    max_window_days: AXON_CHANGES_MAX_WINDOW_DAYS,
    note:
      "Derived from daily metagraph state, not from a chain event: " +
      "AxonInfoRemoved has never been emitted. A change is dated to a day and " +
      "carries no block height. Reachability is judged by axon_routable, so a " +
      "miner that moved to an unroutable address is a change with kind " +
      "moved-unroutable, not a removal.",
  };
}

/** Supported lookback windows (label -> days), matching the routes they feed. */
export const AXON_CHANGES_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_AXON_CHANGES_WINDOW = "7d";

/** The account scope keeps its wider set, as its route always has. */
export const ACCOUNT_AXON_CHANGES_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_ACCOUNT_AXON_CHANGES_WINDOW = "30d";

/**
 * What a scope actually read, flat, the way every other windowed route says it.
 *
 * `windowCoverage` already answers covered/requested/truncated and is shared
 * with turnover and movers, so this only adds the one fact those routes have
 * no reason to carry: whether the last day had settled.
 */
export interface AxonChangesCoverage {
  start_date: string | null;
  end_date: string | null;
  covered_days: number | null;
  requested_days: number | null;
  window_truncated: boolean | null;
  /**
   * False when the window's last day is the newest the table has -- the one
   * still being rewritten. See the module header: the same aggregate returned
   * different counts forty minutes apart off that day.
   */
  end_date_settled: boolean;
}

export function axonChangesCoverage(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  requestedDays: number | null | undefined,
  newestDate: string | null | undefined,
): AxonChangesCoverage {
  return {
    start_date: startDate ?? null,
    end_date: endDate ?? null,
    ...windowCoverage(startDate, endDate, requestedDays),
    // Unsettled only when there IS an end date and it is the newest row the
    // table has. A window stopping short of today read settled days only.
    end_date_settled: endDate == null ? false : endDate !== newestDate,
  };
}

/** Per-subnet aggregate as the derived SQL returns it, before shaping. */
export interface AxonChangeSubnetAggregate {
  netuid: number;
  changes: AxonChangeBreakdown;
  /** Distinct hotkeys that STOPPED ANNOUNCING -- the honest remover count. */
  distinct_removers: number;
}

/**
 * Fold `{netuid, kind, n, removers}` rows into per-subnet aggregates.
 *
 * The SQL groups by (netuid, kind), so a subnet arrives as up to three rows.
 * Anything with an unrecognised kind is DROPPED rather than bucketed, for the
 * reason `toAxonReachabilityChange` drops it: a mechanism nothing measured
 * must not be attributed (#11381).
 */
export function foldAxonChangeRows(
  rows: Array<Record<string, unknown>> | null | undefined,
): AxonChangeSubnetAggregate[] {
  const perSubnet = new Map<number, AxonChangeSubnetAggregate>();
  for (const row of rows ?? []) {
    const netuid = intOrNull(row?.netuid);
    const kind = axonChangeKind(row?.kind);
    if (netuid == null || kind == null) continue;
    const n = countOrZero(row?.n);
    const entry = perSubnet.get(netuid) ?? {
      netuid,
      changes: emptyAxonChangeBreakdown(),
      distinct_removers: 0,
    };
    if (kind === "deregistered") entry.changes.deregistered += n;
    else if (kind === "moved-unroutable") entry.changes.moved_unroutable += n;
    else {
      entry.changes.stopped_announcing += n;
      // Only the stopped-announcing row carries a remover count; the other two
      // kinds have no remover, because nobody removed anything.
      entry.distinct_removers += countOrZero(row?.removers);
    }
    entry.changes.total += n;
    perSubnet.set(netuid, entry);
  }
  return [...perSubnet.values()];
}

/** A non-negative whole count from a COUNT() cell (int8 arrives as a string). */
function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Rank subnets by what the route NAME means, not by volume.
 *
 * Sorting by total would put SN126's 160 moves above every genuine withdrawal
 * on the network -- exactly the misreading this family exists to prevent. So
 * removals lead, then total, then netuid for a stable order.
 */
export function rankAxonChangeSubnets(
  subnets: readonly AxonChangeSubnetAggregate[],
): AxonChangeSubnetAggregate[] {
  return [...subnets].sort(
    (a, b) =>
      b.changes.stopped_announcing - a.changes.stopped_announcing ||
      b.changes.total - a.changes.total ||
      a.netuid - b.netuid,
  );
}

/** Sum per-subnet aggregates into the network rollup. */
export function sumAxonChangeBreakdowns(
  subnets: readonly AxonChangeSubnetAggregate[],
): AxonChangeBreakdown {
  const out = emptyAxonChangeBreakdown();
  for (const subnet of subnets) {
    out.deregistered += subnet.changes.deregistered;
    out.moved_unroutable += subnet.changes.moved_unroutable;
    out.stopped_announcing += subnet.changes.stopped_announcing;
    out.total += subnet.changes.total;
  }
  return out;
}

/**
 * The envelope's `generated_at` for a daily derivation.
 *
 * MIDNIGHT UTC of the last day read, not `Date.now()`. The answer describes a
 * day, and stamping it with the request time would claim a freshness the
 * source does not have -- the snapshot behind it is up to 24h old.
 */
export function axonChangesObservedAt(
  endDate: string | null | undefined,
): string | null {
  if (typeof endDate !== "string" || endDate.trim() === "") return null;
  const parsed = Date.parse(`${endDate.trim()}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The grouped read every scope runs, as one statement.
 *
 * Takes the window's first date and an optional scope filter, and returns one
 * row per (netuid, kind). `prev_hotkey` is the remover on a stop -- the hotkey
 * that WAS announcing -- because `hotkey` on that row is the same account and
 * on a deregistration would be the newcomer.
 */
export function axonChangesGroupedSql(scopeFilter: string): string {
  return (
    `WITH seq AS (${AXON_TRANSITION_SEQ_SQL} ` +
    `WHERE snapshot_date >= ?${scopeFilter ? ` AND ${scopeFilter}` : ""} ` +
    `${AXON_TRANSITION_WINDOW_SQL}) ` +
    `SELECT netuid, ${AXON_CHANGE_KIND_SQL} AS kind, COUNT(*) AS n, ` +
    "COUNT(DISTINCT prev_hotkey) AS removers " +
    `FROM seq WHERE ${AXON_CHANGE_PREDICATE_SQL} GROUP BY netuid, kind`
  );
}

/**
 * The account-scoped read.
 *
 * THE FILTER CANNOT GO IN THE CTE. Restricting the sequence to one hotkey's
 * rows removes the row that REPLACED it, and a deregistration is defined by
 * exactly that row -- the UID would then look like the account stopped
 * announcing when in fact it lost the slot. So the account filter is applied
 * to `prev_hotkey` on the OUTSIDE, after the comparison has been made.
 *
 * The CTE is still pruned to the netuids the account has appeared on, which is
 * a small set for any real account and keeps this from scanning the network.
 */
export function axonChangesAccountSql(): string {
  return (
    `WITH seq AS (${AXON_TRANSITION_SEQ_SQL} ` +
    "WHERE snapshot_date >= ? AND netuid IN " +
    "(SELECT DISTINCT netuid FROM neuron_daily WHERE hotkey = ?) " +
    `${AXON_TRANSITION_WINDOW_SQL}) ` +
    `SELECT netuid, ${AXON_CHANGE_KIND_SQL} AS kind, COUNT(*) AS n, ` +
    "MIN(snapshot_date) AS first_date, MAX(snapshot_date) AS last_date " +
    `FROM seq WHERE ${AXON_CHANGE_PREDICATE_SQL} AND prev_hotkey = ? ` +
    "GROUP BY netuid, kind"
  );
}

/**
 * Distinct hotkeys that stopped announcing anywhere in the window.
 *
 * Separate from the grouped read because it is a network-wide COUNT DISTINCT:
 * one hotkey that stopped on three subnets is ONE remover, and summing the
 * per-subnet counts would treble it.
 */
export function axonChangesNetworkRemoversSql(): string {
  return (
    `WITH seq AS (${AXON_TRANSITION_SEQ_SQL} ` +
    `WHERE snapshot_date >= ? ${AXON_TRANSITION_WINDOW_SQL}) ` +
    "SELECT COUNT(DISTINCT prev_hotkey) AS removers FROM seq " +
    `WHERE ${AXON_CHANGE_PREDICATE_SQL} AND hotkey = prev_hotkey ` +
    "AND (axon IS NULL OR axon = '')"
  );
}
