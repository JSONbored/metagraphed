// The D1 -> Neon reconciler (infra#336).
//
// Two kinds of table, two units of work -- see BackfillPartition:
//
//   date   the ACCUMULATING tables. One unit per snapshot_date; a past date is
//          finished, so a per-date count difference is exact and a tick can
//          copy a few dates and stop.
//   whole  the DIMENSION tables (#9814). No date column to divide on, rewritten
//          in place, and small enough that the whole table is one unit.
//
// The comparison differs with the unit, and for a real reason. A dated table
// only grows, so counts alone settle it. A dimension table is UPDATED IN PLACE
// -- an identity changes, a subnet retunes -- so both stores can hold the same
// number of rows and different data indefinitely. Those compare on
// (COUNT(*), MAX(captured_at)).
//
// ## Why the mirror alone does not finish the job
//
// #9712/#9729/#9733/#9739 mirror every write into Neon, which is enough for the
// five LATEST-ONLY tables: `neurons`, `nominator_positions` and the three flat
// ledgers are fully rewritten each producer cycle, so one cycle after the
// mirror turns on the two stores agree. Measured, `neurons` matched D1 exactly
// on the first pass -- 129 netuids, 30,109 rows, identical SUM(uid).
//
// `neuron_daily` and `account_position_daily` accumulate by date and are never
// rewritten, so a mirror can only ever cover the days it was running for.
// Measured 2026-08-07 with the mirror healthy and current:
//
//     neuron_daily            D1 846,912   NEON  30,109   (today, and nothing else)
//     account_position_daily  D1 834,081   NEON 833,849
//
// ## Why this is a reconciler and not a script
//
// A script closes that gap once. It does not close it the next time a mirror
// write fails mid-chunk, a lane is turned off and back on, or a deploy lands
// between two halves of a producer cycle. And until this file existed nothing
// in the system compared the two stores AT ALL -- which is the blind spot that
// let a frozen Neon serve `GET /api/v1/accounts/{ss58}/subnets/{netuid}/history`
// for two days without a single failing check (#9705).
//
// So the deficit is recomputed from both sides every tick. When there is
// nothing missing this is a no-op costing one grouped count per store, and it
// stays wired afterwards as the consistency check the pilot never had.
//
// ## The deficit IS the cursor
//
// There is no stored progress and no state table. Each tick asks both stores
// for their per-date row counts and copies the newest date where Neon has fewer
// rows than D1. An interrupted tick, a redeploy mid-copy, and two ticks
// overlapping all resolve to the same place, because the only state is the data
// itself. That is also why the unit of work is a WHOLE DATE: stopping halfway
// through one would leave a deficit the next tick recomputes correctly but
// restarts, so the budget is checked between dates rather than inside one.
//
// ## Newest date first
//
// Both tables are read as "the last N days", so copying backwards from today
// makes the served window correct progressively rather than all at once at the
// end. If this never finishes, what it did finish is the part anything asks
// for.

import {
  neonBackfillLanes,
  writeRowsToNeon,
  type NeonWriteResult,
  type PgUnsafe,
} from "./neon-write.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
} from "./neurons-d1-write.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  type LaneHealthDb,
} from "./lane-health.ts";

type Row = Record<string, unknown>;

/** Rows read from D1 per page. Two thousand rows of the wider table is roughly
 * a megabyte of JSON, which is a comfortable D1 response and a comfortable
 * slice to hold while the Neon statements for it are built. */
export const D1_PAGE_ROWS = 2_000;

/** Hard ceiling on dates copied per tick, whatever the clock or the row budget
 * says. This is a runaway guard, not the working limit -- TICK_ROW_BUDGET is.
 *
 * It used to be 4, chosen for `neuron_daily` where a date is ~32,000 rows, and
 * the docstring said it was there for the case where "a date turns out to be
 * far smaller". It did the opposite: capping on DATE COUNT makes a table with
 * small dates crawl. `subnet_snapshots` is one row per subnet per day, so four
 * dates is 516 rows -- against a 20-second budget -- and its 406-date backlog
 * would have taken five hours at three minutes a tick. */
export const MAX_DATES_PER_TICK = 64;

/** The working per-tick limit, in ROWS.
 *
 * Rows are what a tick actually costs -- D1 reads, Neon statements, memory
 * held while the page is in flight -- and dates are only a proxy that happens
 * to hold for one table. Budgeting in rows makes a tick's cost the same across
 * plans whose dates differ by two orders of magnitude.
 *
 * Checked BETWEEN dates, like the clock budget, because a date is the unit of
 * work: stopping inside one would leave a deficit the next tick recomputes
 * correctly but restarts. So a tick can overshoot by at most one date. */
export const TICK_ROW_BUDGET = 40_000;

/** Wall-clock budget, checked BETWEEN dates. Cron ticks here are 3 minutes
 * apart, so finishing well inside one leaves the next tick a clean start
 * rather than an overlap. */
export const TICK_BUDGET_MS = 20_000;

/** How long a clean verdict suppresses the next comparison.
 *
 * The comparison is two grouped counts over ~840,000 rows each. During the
 * backfill that cost is worth paying every tick; once the stores agree it is
 * ~600M D1 rows read a month to re-learn the same thing. So a lane that just
 * reported no deficit skips the comparison until this much time has passed,
 * which turns a 3-minute reconciler into an hourly one exactly when it becomes
 * a watchdog rather than a copier. */
export const IDLE_RECHECK_MS = 60 * 60 * 1000;

/** The minimal D1 surface this needs, so a test can hand it a fake. */
export interface BackfillDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] } | null>;
    };
    all(): Promise<{ results?: unknown[] } | null>;
  };
}

/**
 * How a table divides into units of work.
 *
 * `date` -- one unit per `snapshot_date`. Right for the ACCUMULATING tables:
 * a past date is finished, so a per-date count difference is an exact and
 * complete signal, and a tick can copy a few dates and stop.
 *
 * `whole` -- one unit, the entire table. Right for the DIMENSION tables, which
 * have no date column to divide on and are rewritten in place. They are small
 * enough that the whole table IS a reasonable unit: 129 rows for
 * subnet_hyperparams and 497 for account_identity, measured 2026-08-07.
 *
 * `append` -- the tail above Neon's high-water mark. Right for the tables that
 * only ever gain rows, in increasing order of a time column, and never rewrite
 * one. `whole` is pathological for these: it recopies the ENTIRE table
 * whenever the signature moves, which measured against production is 36,894
 * rows an hour to add ~510 for subnet_burn_history, and exceeds the tick
 * budget outright for surface_checks at 1,349,625 (#9908).
 *
 * Two properties a plan MUST have before claiming it, neither of which the
 * type can check:
 *
 *   the cursor is assigned AT INSERT, so no row ever arrives with a timestamp
 *   below the high-water mark -- a backdated row is invisible to this partition
 *
 *   rows are never rewritten, so "already above the mark" means "already
 *   copied"
 */
export type BackfillPartition = "date" | "whole" | "append";

export interface BackfillPlan {
  table: string;
  columns: readonly string[];
  /** Neon's primary key. Matches D1's, which is why one row shape serves both. */
  conflict: readonly string[];
  /** The primary key MINUS snapshot_date, in key order: the columns a page
   * within one date resumes from. For a `whole` plan, the full key. */
  keyset: readonly string[];
  /** Declared on every plan rather than defaulted, because the wrong value is
   * silent: a dated table read as `whole` would copy itself end to end every
   * tick, and an undated one read as `date` would query a column it lacks. */
  partition: BackfillPartition;
  /** Columns D1 stores as 0/1 and Neon declares BOOLEAN.
   *
   * NOT a stylistic difference -- it is the one shape mismatch between the two
   * stores, and it has already caused an outage in this lane. The rows the
   * live mirror sends carry real JS booleans (the bit conversion lives in
   * SQLite's implicit binding, not in the shared row shaping), so Neon's
   * columns are BOOLEAN and its writes succeed. Rows read BACK out of D1 are
   * integers, so this path -- and only this path -- has to convert them. */
  booleans: readonly string[];
  /**
   * The column that says WHEN a row was last written. Defaults to
   * `captured_at`, which is what every plan in the neurons family carries.
   *
   * It is a plan field rather than a constant because it stops being universal
   * the moment the migration leaves that family: the probe-derived tables name
   * it `checked_at` (surface_checks) or `updated_at` (the rollups), and the
   * append-only histories have no such column at all.
   *
   * Two things depend on getting it right, and both fail SILENTLY on the wrong
   * name -- which is why this is declared per plan rather than guessed:
   *
   *   backfillGuard   an out-of-order page must be a no-op, not a regression
   *   TableSignature  a `whole` plan compares (COUNT, MAX(freshness)); with no
   *                   freshness column the count alone is the signal
   */
  freshness?: string | null;
}

/**
 * The freshness column for a plan, or null when the table has none.
 *
 * `undefined` means "not stated, use the family default". Explicit `null`
 * means "this table genuinely has no such column" -- an append-only log whose
 * rows are never rewritten. The two are different and the distinction is load
 * bearing: defaulting a log to `captured_at` would put a nonexistent column in
 * the guard, and every backfill write for it would throw.
 */
export function freshnessColumn(plan: BackfillPlan): string | null {
  return plan.freshness === undefined ? "captured_at" : plan.freshness;
}

/** subnet_snapshots, read off pragma_table_info 2026-08-07. */
const SUBNET_SNAPSHOTS_COLUMNS = [
  "netuid",
  "snapshot_date",
  "completeness_score",
  "surface_count",
  "endpoint_count",
  "monitored_count",
  "candidate_count",
  "captured_at",
  "validator_count",
  "miner_count",
  "total_stake_tao",
  "alpha_price_tao",
  "emission_share",
  "tao_in_pool_tao",
  "alpha_in_pool",
  "alpha_out_pool",
  "subnet_volume_tao",
  "tao_in_emission_tao",
  "excess_tao",
  "alpha_in_emission",
  "alpha_out_emission",
  "miner_burned_fraction",
  "emission_enabled",
  "subtoken_enabled",
  "first_emission_block",
  "pipeline_block",
  "pipeline_block_hash",
] as const;

/** subnet_hyperparams. Every `*_enabled` column is a 0/1 CHECK in D1. */
const SUBNET_HYPERPARAMS_COLUMNS = [
  "netuid",
  "kappa_ratio",
  "immunity_period",
  "min_allowed_weights",
  "max_weight_limit_ratio",
  "tempo",
  "weights_version",
  "weights_rate_limit",
  "activity_cutoff",
  "activity_cutoff_factor",
  "registration_allowed",
  "target_regs_per_interval",
  "min_burn_tao",
  "max_burn_tao",
  "burn_half_life",
  "burn_increase_mult",
  "bonds_moving_avg_raw",
  "max_regs_per_block",
  "serving_rate_limit",
  "max_validators",
  "commit_reveal_period",
  "commit_reveal_enabled",
  "alpha_high_ratio",
  "alpha_low_ratio",
  "liquid_alpha_enabled",
  "alpha_sigmoid_steepness",
  "yuma_version",
  "subnet_is_active",
  "transfers_enabled",
  "bonds_reset_enabled",
  "user_liquidity_enabled",
  "owner_cut_enabled",
  "owner_cut_auto_lock_enabled",
  "min_childkey_take_ratio",
  "block_number",
  "captured_at",
] as const;

/** nominator_positions. */
const NOMINATOR_POSITIONS_COLUMNS = [
  "coldkey",
  "hotkey",
  "netuid",
  "share_fraction",
  "captured_at",
] as const;

/** validator_nominator_counts. */
const VALIDATOR_NOMINATOR_COUNTS_COLUMNS = [
  "hotkey",
  "nominator_count",
  "captured_at",
] as const;

/** account_identity. */
const ACCOUNT_IDENTITY_COLUMNS = [
  "account",
  "name",
  "url",
  "github",
  "image",
  "discord",
  "description",
  "additional",
  "captured_at",
] as const;

/**
 * One plan per table, keyed by the name used in NEON_BACKFILL_LANES.
 *
 * The conflict keys are D1's declared PRIMARY KEYs, read off sqlite_master /
 * pragma_table_info rather than assumed, and they match Neon's. An ON CONFLICT
 * naming columns with no unique index behind them is a runtime error, not a
 * slower query.
 *
 * A plan here is INERT until NEON_BACKFILL_LANES names its table, so the three
 * added for #9814 do nothing until both their Neon tables exist and the flag
 * lists them.
 */
/**
 * The five LOW-CHURN history tables (#9895), read off pragma_table_info
 * 2026-08-07. 895 rows between them.
 *
 * `subnet_burn_history` and `tao_usd_index` are deliberately NOT here despite
 * sharing the schema family. They are high-churn -- 12,255 and 1,440 rows a
 * DAY respectively, measured -- and a `whole` plan recopies the entire table
 * whenever the signature moves. For subnet_burn_history that is 36,894 rows
 * rewritten every hour to add ~510. Those two need a live mirror so the
 * reconciler idles, and get plans once they have one.
 *
 * `id` IS ABSENT FROM ALL FOUR AUTOINCREMENT TABLES, deliberately. Neon
 * declares it GENERATED ALWAYS and assigns its own, because a mirror cannot
 * preserve a value D1 hands out at insert time. That costs nothing: the
 * natural key is unique in every one of them (531/531, 137/137, 123/123,
 * 77/77 measured), so D1's own `(account, observed_at DESC, id DESC)` ordering
 * never reaches the id tiebreaker.
 */
const ACCOUNT_IDENTITY_HISTORY_COLUMNS = [
  "account",
  "observed_at",
  "name",
  "url",
  "github",
  "image",
  "discord",
  "description",
  "additional",
  "identity_hash",
] as const;

const SUBNET_HYPERPARAMS_HISTORY_COLUMNS = [
  "netuid",
  "block_number",
  "observed_at",
  "kappa_ratio",
  "immunity_period",
  "min_allowed_weights",
  "max_weight_limit_ratio",
  "tempo",
  "weights_version",
  "weights_rate_limit",
  "activity_cutoff",
  "activity_cutoff_factor",
  "registration_allowed",
  "target_regs_per_interval",
  "min_burn_tao",
  "max_burn_tao",
  "burn_half_life",
  "burn_increase_mult",
  "bonds_moving_avg_raw",
  "max_regs_per_block",
  "serving_rate_limit",
  "max_validators",
  "commit_reveal_period",
  "commit_reveal_enabled",
  "alpha_high_ratio",
  "alpha_low_ratio",
  "liquid_alpha_enabled",
  "alpha_sigmoid_steepness",
  "yuma_version",
  "subnet_is_active",
  "transfers_enabled",
  "bonds_reset_enabled",
  "user_liquidity_enabled",
  "owner_cut_enabled",
  "owner_cut_auto_lock_enabled",
  "min_childkey_take_ratio",
  "hyperparams_hash",
] as const;

const EMISSION_GATE_PARAM_HISTORY_COLUMNS = [
  "param",
  "value",
  "previous_value",
  "source",
  "block_number",
  "observed_at",
  "predates_capture",
] as const;

const SUBNET_EMISSION_ENABLED_HISTORY_COLUMNS = [
  "netuid",
  "enabled",
  "previous_enabled",
  "block_number",
  "observed_at",
  "predates_capture",
] as const;

const CHAIN_CONCENTRATION_DAILY_COLUMNS = [
  "day",
  "neuron_count",
  "card",
  "source_captured_at",
  "computed_at",
  "builder_version",
] as const;

export const NEON_BACKFILL_PLANS: Readonly<Record<string, BackfillPlan>> = {
  neuron_daily: {
    table: "neuron_daily",
    columns: NEURON_DAILY_COLUMNS,
    conflict: ["netuid", "uid", "snapshot_date"],
    keyset: ["netuid", "uid"],
    partition: "date",
    booleans: ["active", "validator_permit", "is_immunity_period"],
  },
  account_position_daily: {
    table: "account_position_daily",
    columns: ACCOUNT_POSITION_DAILY_COLUMNS,
    conflict: ["account", "netuid", "snapshot_date"],
    keyset: ["account", "netuid"],
    partition: "date",
    booleans: ["active", "validator_permit"],
  },
  // The three tables #9814 needs. Four routes read one of them through a side
  // loader and therefore cannot move to Neon until they exist there:
  // /validators, /subnets/{n}/concentration/history, /accounts and
  // /accounts/{ss58}/subnets.
  subnet_snapshots: {
    table: "subnet_snapshots",
    columns: SUBNET_SNAPSHOTS_COLUMNS,
    conflict: ["netuid", "snapshot_date"],
    keyset: ["netuid"],
    partition: "date",
    booleans: ["emission_enabled", "subtoken_enabled"],
  },
  subnet_hyperparams: {
    table: "subnet_hyperparams",
    columns: SUBNET_HYPERPARAMS_COLUMNS,
    conflict: ["netuid"],
    keyset: ["netuid"],
    partition: "whole",
    booleans: [
      "registration_allowed",
      "commit_reveal_enabled",
      "liquid_alpha_enabled",
      "subnet_is_active",
      "transfers_enabled",
      "bonds_reset_enabled",
      "user_liquidity_enabled",
      "owner_cut_enabled",
      "owner_cut_auto_lock_enabled",
    ],
  },
  // Latest-only AND mirrored, which by the rule below would need no lane --
  // except measurement says otherwise. D1 held 112,250 rows and Neon 112,236
  // on 2026-08-07, and the gap did not move across repeated checks. It is not
  // churn: it is 14 hotkeys D1 wrote BEFORE the mirror lane existed and has
  // not rewritten since, so no producer cycle will ever carry them.
  //
  // That is the hole in "a mirror covers a latest-only table": it does, but
  // only for rows the producer still emits. A validator that stopped having
  // nominators keeps its D1 row forever (upsert-only, no prune) and never
  // reaches Neon. /validators reads this table, so 14 wrong rows is 14 wrong
  // nominator counts on a leaderboard.
  // Same shape as validator_nominator_counts below, and the same evidence.
  // Measured 2026-08-07: D1 123,522 rows, Neon 110,120 -- Neon short 13,402.
  //
  // Checked the write path before believing the numbers this time (#9832 was
  // a lesson): the consumer hands BOTH writers the identical
  // `{ rows, coldkeyMaxCapturedAt }`, so they share a prune contract, and
  // chunkStatements applies no filter for this table. There is no asymmetry to
  // explain the gap, which leaves the ordinary one -- rows written to D1
  // before the mirror lane existed, for coldkeys the producer no longer emits.
  // The mirror carries ~485 rows a pass; it will never reach them.
  nominator_positions: {
    table: "nominator_positions",
    columns: NOMINATOR_POSITIONS_COLUMNS,
    conflict: ["coldkey", "hotkey", "netuid"],
    keyset: ["coldkey", "hotkey", "netuid"],
    partition: "whole",
    booleans: [],
  },
  validator_nominator_counts: {
    table: "validator_nominator_counts",
    columns: VALIDATOR_NOMINATOR_COUNTS_COLUMNS,
    conflict: ["hotkey"],
    keyset: ["hotkey"],
    partition: "whole",
    booleans: [],
  },
  account_identity: {
    table: "account_identity",
    columns: ACCOUNT_IDENTITY_COLUMNS,
    conflict: ["account"],
    keyset: ["account"],
    partition: "whole",
    booleans: [],
  },
  // The five low-churn history tables (#9895). Four are APPEND-ONLY -- a row,
  // once written, is never rewritten -- so `freshness: null` and the signature
  // degrades to COUNT, which is complete for them.
  account_identity_history: {
    table: "account_identity_history",
    columns: ACCOUNT_IDENTITY_HISTORY_COLUMNS,
    conflict: ["account", "observed_at"],
    keyset: ["account", "observed_at"],
    partition: "whole",
    booleans: [],
    freshness: null,
  },
  subnet_hyperparams_history: {
    table: "subnet_hyperparams_history",
    columns: SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
    conflict: ["netuid", "observed_at"],
    keyset: ["netuid", "observed_at"],
    partition: "whole",
    booleans: [
      "registration_allowed",
      "commit_reveal_enabled",
      "liquid_alpha_enabled",
      "subnet_is_active",
      "transfers_enabled",
      "bonds_reset_enabled",
      "user_liquidity_enabled",
      "owner_cut_enabled",
      "owner_cut_auto_lock_enabled",
    ],
    freshness: null,
  },
  emission_gate_param_history: {
    table: "emission_gate_param_history",
    columns: EMISSION_GATE_PARAM_HISTORY_COLUMNS,
    conflict: ["param", "observed_at"],
    keyset: ["param", "observed_at"],
    partition: "whole",
    booleans: ["predates_capture"],
    freshness: null,
  },
  subnet_emission_enabled_history: {
    table: "subnet_emission_enabled_history",
    columns: SUBNET_EMISSION_ENABLED_HISTORY_COLUMNS,
    conflict: ["netuid", "observed_at"],
    keyset: ["netuid", "observed_at"],
    partition: "whole",
    booleans: ["enabled", "previous_enabled", "predates_capture"],
    freshness: null,
  },
  // The ONE exception in the family: keyed on `day`, and today's row is
  // RECOMPUTED as the day fills in. COUNT alone would let the two stores hold
  // 27 rows each and disagree about today's card indefinitely, so this one
  // compares on computed_at.
  chain_concentration_daily: {
    table: "chain_concentration_daily",
    columns: CHAIN_CONCENTRATION_DAILY_COLUMNS,
    conflict: ["day"],
    keyset: ["day"],
    partition: "whole",
    booleans: [],
    freshness: "computed_at",
  },
};

/**
 * The guard every backfill write carries.
 *
 * Without it this path can REGRESS live data. Today's rows are rewritten by
 * the producer all day, so a page read from D1 at 12:00 and written to Neon at
 * 12:01 would overwrite whatever the mirror wrote at 12:00:30. With it, an
 * older freshness stamp is a no-op and the newer row stands.
 *
 * A table with NO freshness column gets no guard, and that is safe for the
 * reason it has none: its rows are never rewritten, so there is no newer
 * version for a stale page to clobber. Returning a guard over a column that
 * does not exist would instead fail every write for that table.
 */
export function backfillGuard(
  table: string,
  freshness: string | null = "captured_at",
): string | undefined {
  if (!freshness) return undefined;
  return `${table}.${freshness} < EXCLUDED.${freshness}`;
}

/**
 * The keyset predicate for resuming a page, as SQL plus its bind values.
 *
 * Expanded rather than written as a row-value comparison -- `(a, b) > (?, ?)`
 * is valid SQLite but the expanded form is what the (snapshot_date, a, b)
 * index seeks on unambiguously, and this query's whole cost model depends on
 * that index being used.
 */
export function keysetPredicate(
  keyset: readonly string[],
  cursor: readonly unknown[],
): { sql: string; values: unknown[] } {
  const terms: string[] = [];
  const values: unknown[] = [];
  for (let i = 0; i < keyset.length; i += 1) {
    const equals = keyset.slice(0, i).map((column) => `${column} = ?`);
    terms.push([...equals, `${keyset[i]} > ?`].join(" AND "));
    values.push(...cursor.slice(0, i), cursor[i]);
  }
  return { sql: `(${terms.map((term) => `(${term})`).join(" OR ")})`, values };
}

/** Per-date row counts from D1, as a map of snapshot_date to count. */
export async function d1DateCounts(
  db: BackfillDb | null | undefined,
  table: string,
): Promise<Map<string, number> | null> {
  try {
    const result = await db
      ?.prepare(
        `SELECT snapshot_date AS d, COUNT(*) AS n FROM ${table} GROUP BY snapshot_date`,
      )
      .all();
    if (!result) return null;
    return countMap(result.results ?? [], "d", "n");
  } catch {
    // Null, never an empty map: "D1 did not answer" and "D1 has no rows" would
    // otherwise both read as a deficit of everything Neon holds, and the second
    // one is the shape of a catastrophic mistaken copy.
    return null;
  }
}

/** Per-date row counts from Neon, in the same shape. */
export async function neonDateCounts(
  sql: PgUnsafe | null | undefined,
  table: string,
): Promise<Map<string, number> | null> {
  if (!sql?.unsafe) return null;
  try {
    const rows = (await sql.unsafe(
      `SELECT snapshot_date::text AS d, COUNT(*) AS n FROM ${table} GROUP BY snapshot_date`,
    )) as unknown[];
    return countMap(Array.isArray(rows) ? rows : [], "d", "n");
  } catch {
    return null;
  }
}

function countMap(
  rows: readonly unknown[],
  dateKey: string,
  countKey: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of rows) {
    const row = raw as Row;
    const date = row?.[dateKey];
    if (date == null) continue;
    const n = Number(row[countKey]);
    out.set(String(date), Number.isFinite(n) ? n : 0);
  }
  return out;
}

export interface DateDeficit {
  date: string;
  d1: number;
  neon: number;
}

/**
 * Dates where Neon holds fewer rows than D1, NEWEST FIRST.
 *
 * Strictly `neon < d1`. A date where Neon holds MORE is not reported and not
 * acted on: this path only ever adds rows, and a surplus in Neon is a question
 * about deletes that copying cannot answer and must not paper over.
 */
export function dateDeficits(
  d1Counts: ReadonlyMap<string, number>,
  neonCounts: ReadonlyMap<string, number>,
): DateDeficit[] {
  const out: DateDeficit[] = [];
  for (const [date, d1] of d1Counts) {
    const neon = neonCounts.get(date) ?? 0;
    if (neon < d1) out.push({ date, d1, neon });
  }
  // ISO dates sort lexicographically, so `localeCompare` reversed is the whole
  // ordering -- and the keys came from a Map, so there are no ties to break.
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** D1's integers where Neon declares BOOLEAN, and nothing else touched. */
export function shapeRowForNeon(row: Row, booleans: readonly string[]): Row {
  const out: Row = { ...row };
  for (const column of booleans) {
    const value = out[column];
    if (value != null) out[column] = Boolean(value);
  }
  return out;
}

/** One page of a date's rows from D1, in keyset order. */
export async function readDatePage(
  db: BackfillDb,
  plan: BackfillPlan,
  date: string,
  cursor: readonly unknown[] | null,
  limit: number,
): Promise<Row[]> {
  const keyset = cursor ? keysetPredicate(plan.keyset, cursor) : null;
  const sql =
    `SELECT ${plan.columns.join(", ")} FROM ${plan.table} ` +
    `WHERE snapshot_date = ?${keyset ? ` AND ${keyset.sql}` : ""} ` +
    `ORDER BY ${plan.keyset.join(", ")} LIMIT ?`;
  const result = await db
    .prepare(sql)
    .bind(date, ...(keyset?.values ?? []), limit)
    .all();
  return (result?.results ?? []) as Row[];
}

export interface DateCopyResult extends NeonWriteResult {
  date: string;
  pages: number;
}

/**
 * Copy one date, page by page, until D1 returns a short page.
 *
 * Stops at the first failed write rather than continuing to the next page, for
 * the same reason `writeRowsToNeon` stops at the first failed chunk: continuing
 * past a failure produces a row count that looks nearly complete over a table
 * that is not.
 */
export async function copyDateToNeon(
  db: BackfillDb,
  sql: PgUnsafe,
  plan: BackfillPlan,
  date: string,
  pageRows: number = D1_PAGE_ROWS,
): Promise<DateCopyResult> {
  let cursor: unknown[] | null = null;
  let rows = 0;
  let statements = 0;
  let pages = 0;
  for (;;) {
    let page: Row[];
    try {
      page = await readDatePage(db, plan, date, cursor, pageRows);
    } catch (error) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: reason(error),
      };
    }
    if (page.length === 0) return { ok: true, rows, statements, pages, date };
    pages += 1;
    const result = await writeRowsToNeon(
      sql,
      plan.table,
      plan.columns,
      page.map((row) => shapeRowForNeon(row, plan.booleans)),
      plan.conflict,
      backfillGuard(plan.table, freshnessColumn(plan)),
    );
    rows += result.rows;
    statements += result.statements;
    if (!result.ok) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: result.reason,
      };
    }
    if (page.length < pageRows)
      return { ok: true, rows, statements, pages, date };
    const last = page[page.length - 1];
    cursor = plan.keyset.map((column) => last[column]);
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BackfillTableOutcome {
  table: string;
  /** Deficient dates found this tick, before any were copied. */
  deficits: number;
  /** Rows still missing across all deficient dates, before any were copied. */
  missing: number;
  /**
   * Rows still missing over the dates this tick did NOT reach.
   *
   * NOT `missing - rowsCopied`, which is the wrong subtraction and goes
   * negative in the ordinary case. The unit of work is a whole DATE, so
   * copying a date 231 rows short writes all 30,278 of its rows -- the upsert
   * makes the other 30,047 no-ops. Reporting "-30,047 rows still behind" is
   * how that first showed up in production.
   */
  remaining: number;
  copied: DateCopyResult[];
  ok: boolean;
  reason?: string;
  /** True when the comparison was skipped because a clean verdict is recent. */
  skipped?: boolean;
}

export interface BackfillDeps {
  sql?: PgUnsafe | null;
  db?: BackfillDb | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  /** Injectable so a test can drive the budget without waiting on a clock. */
  elapsed?: () => number;
}

/**
 * Reconcile one table. Never throws.
 *
 * The verdict is `stale` whenever a deficit remains after this tick, including
 * the tick that found one and copied it successfully -- because "there is still
 * a gap" is the thing a reader of `lane_health` needs to know, and a verdict of
 * `ok` on a tick that copied 4 of 26 missing dates would report progress as
 * completion. #9698's alarm escalates a lane that stays stale, which during a
 * backfill is exactly the signal that it has stopped converging.
 */
/**
 * The unit label a whole-table plan reports, where a dated plan reports a date.
 *
 * Whole-table plans have exactly one unit of work, so the outcome shape and
 * describeOutcome need no special case -- the lane verdict reads the same for
 * both kinds of plan.
 */
export const WHOLE_TABLE_UNIT = "*";

/**
 * Row count and newest `captured_at` for a table, on either side.
 *
 * COUNT ALONE IS NOT ENOUGH for these tables, and that is the whole reason
 * this is a pair. The dated plans divide into units that only ever grow, so a
 * per-date count difference is a complete signal. A dimension table is
 * UPDATED IN PLACE -- `account_identity` rewrites a row when an identity
 * changes, `subnet_hyperparams` when a subnet retunes -- so the two stores can
 * hold the same number of rows and different data indefinitely. The freshness
 * column moves on every write, so the pair catches drift the count cannot see.
 *
 * For a table with NO freshness column the pair degrades to the count, and
 * that is not a weakening: such a table is append-only -- its rows are never
 * rewritten -- so there is no in-place drift for a timestamp to reveal.
 */
export interface TableSignature {
  rows: number;
  /** Null when the stores agree there is nothing to compare: an empty table,
   * or a plan whose table has no freshness column at all. */
  maxCapturedAt: number | null;
}

/**
 * A signature row, or null if the store did not actually answer.
 *
 * `COUNT(*)` ALWAYS returns exactly one row, even over an empty table. So no
 * row here does not mean "no data" -- it means the response was not the shape
 * a count produces, and reading it as `{rows: 0}` would report the other
 * store's entire contents as a deficit. That is the same rule d1DateCounts
 * follows by returning null rather than an empty map, and it exists because
 * the failure it prevents is a catastrophic mistaken copy.
 */
function signatureOf(raw: unknown): TableSignature | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Row;
  const rows = Number(row.n);
  // MAX() over an empty table is SQL NULL, and `Number(null)` is 0 -- which
  // would make an empty table indistinguishable from one written at epoch, and
  // would let two empty stores agree for the wrong reason. Check the null
  // before coercing.
  const rawMax = row.max_captured;
  const max = rawMax == null ? Number.NaN : Number(rawMax);
  return {
    rows: Number.isFinite(rows) ? rows : 0,
    maxCapturedAt: Number.isFinite(max) ? max : null,
  };
}

/**
 * The signature query. `MAX(freshness)` only when the table HAS one --
 * selecting a nonexistent column would throw and be swallowed as "the store
 * did not answer", turning a schema mistake into an indefinite `unknown`.
 */
export function signatureSql(table: string, freshness: string | null): string {
  const max = freshness ? `, MAX(${freshness}) AS max_captured` : "";
  return `SELECT COUNT(*) AS n${max} FROM ${table}`;
}

/** D1's signature. Null on failure, never a zeroed one -- see d1DateCounts. */
export async function d1TableSignature(
  db: BackfillDb | null | undefined,
  table: string,
  freshness: string | null = "captured_at",
): Promise<TableSignature | null> {
  try {
    const result = await db?.prepare(signatureSql(table, freshness)).all();
    if (!result) return null;
    return signatureOf((result.results ?? [])[0]);
  } catch {
    return null;
  }
}

/** Neon's signature, in the same shape. */
export async function neonTableSignature(
  sql: PgUnsafe | null | undefined,
  table: string,
  freshness: string | null = "captured_at",
): Promise<TableSignature | null> {
  if (!sql?.unsafe) return null;
  try {
    const rows = (await sql.unsafe(
      signatureSql(table, freshness),
    )) as unknown[];
    if (!Array.isArray(rows)) return null;
    return signatureOf(rows[0]);
  } catch {
    return null;
  }
}

/** Two signatures agree when both the count and the newest write match. */
export function signaturesAgree(a: TableSignature, b: TableSignature): boolean {
  return a.rows === b.rows && a.maxCapturedAt === b.maxCapturedAt;
}

/** One page of a whole-table read, resumed from the keyset cursor. */
export async function readWholePage(
  db: BackfillDb,
  plan: BackfillPlan,
  cursor: readonly unknown[] | null,
  limit: number,
): Promise<Row[]> {
  const keyset = cursor ? keysetPredicate(plan.keyset, cursor) : null;
  const sql =
    `SELECT ${plan.columns.join(", ")} FROM ${plan.table}` +
    `${keyset ? ` WHERE ${keyset.sql}` : ""} ` +
    `ORDER BY ${plan.keyset.join(", ")} LIMIT ?`;
  const result = await db
    .prepare(sql)
    .bind(...(keyset?.values ?? []), limit)
    .all();
  return (result?.results ?? []) as Row[];
}

/**
 * Copy an entire table, page by page. The whole-table twin of copyDateToNeon,
 * and it stops at the first failed write for the same reason.
 */
export async function copyWholeTableToNeon(
  db: BackfillDb,
  sql: PgUnsafe,
  plan: BackfillPlan,
  pageRows: number = D1_PAGE_ROWS,
): Promise<DateCopyResult> {
  let cursor: unknown[] | null = null;
  let rows = 0;
  let statements = 0;
  let pages = 0;
  const date = WHOLE_TABLE_UNIT;
  for (;;) {
    let page: Row[];
    try {
      page = await readWholePage(db, plan, cursor, pageRows);
    } catch (error) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: reason(error),
      };
    }
    if (page.length === 0) return { ok: true, rows, statements, pages, date };
    pages += 1;
    const result = await writeRowsToNeon(
      sql,
      plan.table,
      plan.columns,
      page.map((row) => shapeRowForNeon(row, plan.booleans)),
      plan.conflict,
      backfillGuard(plan.table, freshnessColumn(plan)),
    );
    rows += result.rows;
    statements += result.statements;
    if (!result.ok) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: result.reason,
      };
    }
    if (page.length < pageRows)
      return { ok: true, rows, statements, pages, date };
    const last = page[page.length - 1];
    cursor = plan.keyset.map((column) => last[column]);
  }
}

/**
 * Reconcile an undated table by comparing its signature and copying if they
 * differ.
 *
 * `missing` is a LOWER BOUND here, unlike the dated path where it is exact.
 * An updated-in-place row is drift with no row-count difference at all, so a
 * table can be out of sync with `missing: 0`. Reporting the count difference
 * anyway keeps the field meaning the same thing on both paths -- rows Neon
 * does not have -- rather than inventing a second meaning for one of them.
 */
async function reconcileWholeTable(
  db: BackfillDb,
  sql: PgUnsafe,
  plan: BackfillPlan,
): Promise<BackfillTableOutcome> {
  const table = plan.table;
  const base = { table, deficits: 0, missing: 0, remaining: 0, copied: [] };
  const freshness = freshnessColumn(plan);
  const [d1Sig, neonSig] = await Promise.all([
    d1TableSignature(db, table, freshness),
    neonTableSignature(sql, table, freshness),
  ]);
  if (!d1Sig || !neonSig) {
    return {
      ...base,
      ok: false,
      reason: `signature failed: ${!d1Sig ? "d1" : "neon"}`,
    };
  }
  if (signaturesAgree(d1Sig, neonSig)) return { ...base, ok: true };

  const missing = Math.max(0, d1Sig.rows - neonSig.rows);
  const result = await copyWholeTableToNeon(db, sql, plan);
  return {
    table,
    deficits: 1,
    missing,
    // One unit of work, so reaching the end of it clears the backlog whatever
    // the row arithmetic said going in.
    remaining: result.ok ? 0 : missing,
    copied: [result],
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason }),
  };
}

/**
 * Guard for an identifier that is about to be INTERPOLATED into SQL.
 *
 * Every table and column name in this module comes from NEON_BACKFILL_PLANS,
 * which is a frozen const in this file -- none of it is reachable from a
 * request, so there is no injection path today. This exists because "today"
 * is doing a lot of work in that sentence: the plans are the kind of thing a
 * later change makes configurable, and `sql.unsafe` interpolation is exactly
 * where that becomes a vulnerability rather than a bug.
 *
 * Throwing rather than escaping is deliberate. A plan naming something that is
 * not a bare identifier is a mistake in the plan, and the loud failure belongs
 * at the lane, not quoted into a query that then does something unintended.
 */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(name: string, what: string): string {
  if (!BARE_IDENTIFIER.test(name)) {
    throw new Error(
      `${what} is not a bare SQL identifier: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Neon's high-water mark for an append plan, or null when it holds nothing.
 *
 * Null and 0 are different answers and the difference is the whole table: null
 * means "copy everything", 0 would mean "copy everything above the epoch",
 * which for a millisecond timestamp is the same set but for a signed or
 * negative cursor would not be. Returning null explicitly keeps the caller's
 * branch honest.
 *
 * `undefined` is returned for a store that would not ANSWER, which is again a
 * third thing -- see d1DateCounts. Copying from the beginning because Neon was
 * briefly unreachable would re-send the entire table.
 */
export async function neonHighWaterMark(
  sql: PgUnsafe | null | undefined,
  table: string,
  cursor: string,
): Promise<number | null | undefined> {
  if (!sql?.unsafe) return undefined;
  try {
    const rows = (await sql.unsafe(
      `SELECT MAX(${assertIdentifier(cursor, "append cursor")}) AS high ` +
        `FROM ${assertIdentifier(table, "table")}`,
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    const raw = (rows[0] as Row)?.high;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One page of the tail, at or above the high-water mark.
 *
 * THE BOUND IS `>=`, NOT `>`, AND THAT IS NOT AN OFF-BY-ONE. Several rows can
 * share the newest cursor value -- one probe sweep writes many rows and only
 * the millisecond distinguishes them -- so `>` would skip every row that ties
 * with the mark but had not been copied when the tick ended. `>=` re-sends the
 * boundary rows instead, which the ON CONFLICT upsert makes free. Given a
 * choice between re-sending a handful of rows and silently dropping them,
 * this lane re-sends.
 */
export async function readAppendPage(
  db: BackfillDb,
  plan: BackfillPlan,
  cursor: readonly unknown[] | null,
  highWater: number | null,
  limit: number,
): Promise<Row[]> {
  const column = freshnessColumn(plan);
  if (!column) throw new Error(`${plan.table}: an append plan needs a cursor`);
  const keyset = cursor ? keysetPredicate(plan.keyset, cursor) : null;
  const bounds: string[] = [];
  const values: unknown[] = [];
  if (highWater != null) {
    bounds.push(`${assertIdentifier(column, "append cursor")} >= ?`);
    values.push(highWater);
  }
  if (keyset) {
    bounds.push(keyset.sql);
    values.push(...keyset.values);
  }
  const where = bounds.length > 0 ? ` WHERE ${bounds.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `SELECT ${plan.columns.map((c) => assertIdentifier(c, "column")).join(", ")} ` +
        `FROM ${assertIdentifier(plan.table, "table")}${where} ` +
        `ORDER BY ${plan.keyset.map((c) => assertIdentifier(c, "keyset column")).join(", ")} LIMIT ?`,
    )
    .bind(...values, limit)
    .all();
  return (result?.results ?? []) as Row[];
}

/**
 * Copy the tail, stopping on the tick budget.
 *
 * UNLIKE copyWholeTableToNeon THIS IS BUDGETED, and it has to be: that one
 * loops until the table is exhausted, which is fine for 129 rows and fatal for
 * 1,349,625. A tick that stops early is not a failure here -- the next tick
 * recomputes the high-water mark, which has moved, and continues. That is the
 * same "the deficit IS the cursor" property the dated path has, and it is why
 * no progress is stored anywhere.
 *
 * A partial copy reports `ok: false` with `remaining`, deliberately: a lane
 * that said `ok` after copying 40,000 of 1,300,000 rows would read as in sync
 * to every watcher.
 */
export async function copyAppendTailToNeon(
  db: BackfillDb,
  sql: PgUnsafe,
  plan: BackfillPlan,
  highWater: number | null,
  budgetRows: number = TICK_ROW_BUDGET,
  pageRows: number = D1_PAGE_ROWS,
): Promise<DateCopyResult> {
  let cursor: unknown[] | null = null;
  let rows = 0;
  let statements = 0;
  let pages = 0;
  const date = WHOLE_TABLE_UNIT;
  for (;;) {
    let page: Row[];
    try {
      page = await readAppendPage(db, plan, cursor, highWater, pageRows);
    } catch (error) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: reason(error),
      };
    }
    if (page.length === 0) return { ok: true, rows, statements, pages, date };
    pages += 1;
    const result = await writeRowsToNeon(
      sql,
      plan.table,
      plan.columns,
      page.map((row) => shapeRowForNeon(row, plan.booleans)),
      plan.conflict,
      backfillGuard(plan.table, freshnessColumn(plan)),
    );
    rows += result.rows;
    statements += result.statements;
    if (!result.ok) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: result.reason,
      };
    }
    if (page.length < pageRows)
      return { ok: true, rows, statements, pages, date };
    if (rows >= budgetRows) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: "tick budget reached",
      };
    }
    const last = page[page.length - 1];
    cursor = plan.keyset.map((column) => last[column]);
  }
}

async function reconcileAppendTable(
  db: BackfillDb,
  sql: PgUnsafe,
  plan: BackfillPlan,
): Promise<BackfillTableOutcome> {
  const table = plan.table;
  const base = { table, deficits: 0, missing: 0, remaining: 0, copied: [] };
  const column = freshnessColumn(plan);
  if (!column) {
    return { ...base, ok: false, reason: "append plan has no cursor column" };
  }
  const [d1Sig, highWater] = await Promise.all([
    d1TableSignature(db, table, column),
    neonHighWaterMark(sql, table, column),
  ]);
  if (!d1Sig || highWater === undefined) {
    return {
      ...base,
      ok: false,
      reason: `signature failed: ${!d1Sig ? "d1" : "neon"}`,
    };
  }
  // Nothing above the mark means nothing to do. Note this compares the CURSOR,
  // not the count: for a pruned table (#9891) D1's oldest rows are gone while
  // Neon still holds them, so the counts legitimately differ forever and only
  // the tail is this lane's business.
  if (
    highWater != null &&
    d1Sig.maxCapturedAt != null &&
    d1Sig.maxCapturedAt <= highWater
  ) {
    return { ...base, ok: true };
  }
  const result = await copyAppendTailToNeon(db, sql, plan, highWater);
  return {
    table,
    deficits: 1,
    missing: 0,
    remaining: result.ok ? 0 : 1,
    copied: [result],
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason }),
  };
}

export async function reconcileTableToNeon(
  db: BackfillDb | null | undefined,
  sql: PgUnsafe | null | undefined,
  plan: BackfillPlan,
  deps: BackfillDeps = {},
): Promise<BackfillTableOutcome> {
  const table = plan.table;
  const base = {
    table,
    deficits: 0,
    missing: 0,
    remaining: 0,
    copied: [] as DateCopyResult[],
  };
  if (!db?.prepare || !sql?.unsafe) {
    return { ...base, ok: false, reason: "unbound" };
  }
  if (plan.partition === "whole") {
    return await reconcileWholeTable(db, sql, plan);
  }
  if (plan.partition === "append") {
    return await reconcileAppendTable(db, sql, plan);
  }
  const [d1Counts, neonCounts] = await Promise.all([
    d1DateCounts(db, table),
    neonDateCounts(sql, table),
  ]);
  if (!d1Counts || !neonCounts) {
    // A store that would not answer is NOT a deficit of everything the other
    // holds. Refusing to act on a half-read comparison is the whole reason
    // both counters return null rather than an empty map.
    return {
      ...base,
      ok: false,
      reason: `count failed: ${!d1Counts ? "d1" : "neon"}`,
    };
  }
  const deficits = dateDeficits(d1Counts, neonCounts);
  const missing = deficits.reduce((sum, d) => sum + (d.d1 - d.neon), 0);
  if (deficits.length === 0) return { ...base, ok: true };

  const elapsed = deps.elapsed ?? (() => 0);
  const copied: DateCopyResult[] = [];
  // Rows still owed, counted over the dates this tick did NOT reach. Each
  // date's own deficit comes off as that date completes, so the figure never
  // depends on how many rows were WRITTEN -- copying a whole date to close a
  // 231-row gap writes 30,278 rows, and subtracting those would report a
  // negative backlog.
  let remaining = missing;
  let rowsThisTick = 0;
  for (const deficit of deficits.slice(0, MAX_DATES_PER_TICK)) {
    // Both budgets guard the SECOND date onward, never the first: a tick that
    // copied nothing would make no progress at all, and the backlog would sit
    // there while the lane reported it forever.
    if (
      copied.length > 0 &&
      (elapsed() >= TICK_BUDGET_MS || rowsThisTick >= TICK_ROW_BUDGET)
    ) {
      break;
    }
    const result = await copyDateToNeon(db, sql, plan, deficit.date);
    copied.push(result);
    rowsThisTick += result.rows;
    if (!result.ok) {
      return {
        table,
        deficits: deficits.length,
        missing,
        remaining,
        copied,
        ok: false,
        reason: result.reason,
      };
    }
    remaining -= deficit.d1 - deficit.neon;
  }
  return {
    table,
    deficits: deficits.length,
    missing,
    remaining,
    copied,
    ok: true,
  };
}

/** One line per table, for the lane verdict's detail column. */
export function describeOutcome(outcome: BackfillTableOutcome): string {
  if (outcome.skipped) return "no deficit at last check";
  if (!outcome.ok) {
    const rows = outcome.copied.reduce((sum, c) => sum + c.rows, 0);
    return `${rows} row(s) copied before failure: ${outcome.reason ?? "unknown"}`;
  }
  if (outcome.deficits === 0) return "in sync";
  const rows = outcome.copied.reduce((sum, c) => sum + c.rows, 0);
  const dates = outcome.deficits - outcome.copied.length;
  // `remaining` counts the dates NOT reached, not `missing - rows`. Rows
  // written and rows owed are different quantities: a date 231 rows short is
  // closed by writing all 30,278 of its rows.
  return (
    `${rows} row(s) over ${outcome.copied.length} date(s); ` +
    `${dates} date(s) / ${outcome.remaining} row(s) still behind`
  );
}

export interface BackfillOutcome {
  attempted: boolean;
  tables: BackfillTableOutcome[];
}

/**
 * Run the reconciler for every table named in NEON_BACKFILL_LANES.
 *
 * Never throws: this is a cron lane behind no request, and a fault here must
 * cost a verdict rather than a tick.
 */
export async function runNeonBackfill(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  deps: BackfillDeps = {},
): Promise<BackfillOutcome> {
  const lanes = neonBackfillLanes(env);
  if (lanes.size === 0) return { attempted: false, tables: [] };

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const db = deps.db ?? (env?.METAGRAPH_HEALTH_DB as BackfillDb | undefined);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = deps.elapsed ?? (() => now() - startedAt);

  const latest = await loadLatestLaneHealth(laneDb);
  const tables: BackfillTableOutcome[] = [];
  for (const lane of lanes) {
    const plan = NEON_BACKFILL_PLANS[lane];
    // An unknown lane is a no-op rather than a throw: the flag is a free-text
    // list and a typo must not take down the tick for the lanes spelled right.
    if (!plan) continue;

    const previous = latest[`neon:backfill:${lane}`];
    if (
      previous?.verdict === "ok" &&
      now() - previous.checked_at < IDLE_RECHECK_MS
    ) {
      tables.push({
        table: plan.table,
        deficits: 0,
        missing: 0,
        remaining: 0,
        copied: [],
        ok: true,
        skipped: true,
      });
      continue;
    }

    let outcome: BackfillTableOutcome;
    try {
      outcome = await reconcileTableToNeon(db, sql, plan, { elapsed });
    } catch (error) {
      outcome = {
        table: plan.table,
        deficits: 0,
        missing: 0,
        remaining: 0,
        copied: [],
        ok: false,
        reason: reason(error),
      };
    }
    tables.push(outcome);
    // `ok` ONLY when the comparison itself found nothing missing -- never on
    // the tick that copied the last date. A copy reports what it wrote, not
    // what is now true, so the tick after the final one re-counts both stores
    // and is what actually declares them equal. That is one extra tick and it
    // is the difference between "we sent the rows" and "they are there".
    const settled = outcome.ok && outcome.deficits === 0;
    await recordLaneVerdict(laneDb, {
      lane: `neon:backfill:${lane}`,
      verdict: settled ? "ok" : "stale",
      age_ms: null,
      detail: describeOutcome(outcome),
      checked_at: now(),
    });
  }
  return { attempted: true, tables };
}
