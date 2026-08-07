// Row-count parity between D1 and Neon, for every table that exists in both.
//
// ## Why this exists
//
// Three parity gaps were found on 2026-08-07 by querying the two stores by
// hand, one table at a time. Nothing in the system was looking:
//
//   hotkey_alpha                D1  17,867   Neon  47,320   (#9832)
//   nominator_positions         D1 123,522   Neon 110,120   (#9832)
//   validator_nominator_counts  D1 112,250   Neon 112,236   (#9844)
//
// The reconciler compares the two stores, but ONLY for tables named in
// NEON_BACKFILL_LANES. Everything else -- including every table the mirror is
// supposed to keep current on its own -- had no comparison at all. "The mirror
// is green" answers whether writes SUCCEEDED, not whether the stores AGREE.
//
// ## Why a persistent deficit, not any deficit
//
// These tables are written continuously, so a single-tick difference is
// normal: a producer pass lands in D1 microseconds before its mirror reaches
// Neon, and a count taken between the two sees a gap that is gone by the next
// tick. Alarming on that would make this noise, and noise is how a check stops
// being read (see #9825's baseline, which cried wolf on every producer tick
// until it was rewritten).
//
// So a deficit alarms only when it REPEATS AT THE SAME SIZE. Churn moves;
// a structural gap does not. `validator_nominator_counts` sat at exactly 14
// across repeated checks minutes apart, which is what distinguished it from
// the ±125 that `account_balances` shows and resolves on its own.
//
// ## Direction is recorded, never assumed
//
// D1 is not the reference store. `hotkey_alpha` has 2.6x MORE rows in Neon
// than D1, because the D1 write is lossy (#9832) -- so a check written as "is
// Neon behind D1" would have reported that table healthy while it was the
// worst broken of the three. Both directions are surfaced.
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  type LaneHealthDb,
} from "./lane-health.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import type { PgUnsafe } from "./neon-write.ts";

export const NEON_PARITY_LANE = "neon-parity";

/** Cron slot. Hourly: these are whole-table counts on both sides, and a
 * structural gap does not appear between one hour and the next. */
export const NEON_PARITY_CRON = "38 * * * *";

/**
 * Every table that exists in BOTH stores, as of migrations/neon/0001.
 *
 * Hand-listed rather than discovered, because "what is in Neon" is the thing
 * being checked -- deriving the list from Neon would make a table that
 * silently vanished there look like a table nobody asked about.
 */
export const PARITY_TABLES = [
  "neurons",
  "neuron_daily",
  "account_position_daily",
  "nominator_positions",
  "account_balances",
  "hotkey_alpha",
  "validator_nominator_counts",
  "subnet_snapshots",
  "subnet_hyperparams",
  "account_identity",
  // The five low-churn history tables (#9895). Adding them takes the list past
  // ten, which is why the sweep had to be batched first (#9881): D1 parses at
  // most five UNION ALL terms and fails the WHOLE statement above that.
  "account_identity_history",
  "subnet_hyperparams_history",
  "emission_gate_param_history",
  "subnet_emission_enabled_history",
  "chain_concentration_daily",
  // The rolling window (#9891). Watched with a tolerance rather than at five
  // rows, because it is written ~2,000 times an hour and pruned on a cron
  // independent of D1's.
  "surface_checks",
  "surface_status",
  "surface_uptime_daily",
  "surface_failure_daily",
] as const;

/**
 * Rows below which a difference is not worth a verdict.
 *
 * Zero would be right if these tables were static. They are not: every one is
 * written continuously, and a count taken mid-pass differs by whatever that
 * pass has landed so far. This is deliberately small -- the point is to catch
 * 14, not only 29,000.
 */
/**
 * Tables the two stores are SUPPOSED to disagree about, with the reason.
 *
 * `hotkey_alpha` is the case that forced this to exist. D1 stores only pools a
 * `nominator_positions` row references -- `REFERENCED_BY_A_POSITION` in
 * src/hotkey-alpha-d1-write.ts, deliberate since #9558, because the other 43x
 * of `TotalHotkeyAlpha` is "written every pass, read by nothing" and saturated
 * D1. The Neon mirror is handed the RAW rows and applies no filter, so Neon
 * holds ~29,000 rows D1 refuses on purpose.
 *
 * That is a real defect (#9832) and the fix is to give the mirror the same
 * filter -- but until then the divergence is EXPECTED, and a watchdog that
 * alarms on it every hour would be teaching everyone to ignore this lane
 * before it has caught anything.
 *
 * NAMED, NOT SILENCED. An expected divergence still appears in the detail
 * line; it just does not make the verdict stale. Dropping it from the report
 * entirely would hide the day it changes size for a NEW reason.
 */
export const EXPECTED_DIVERGENCE: Readonly<Record<string, string>> = {
  hotkey_alpha:
    "D1 filters to pools a nominator_position references (#9558); the mirror does not (#9832)",
};

export const PARITY_MIN_ROWS = 5;

/**
 * Tables whose counts are EXPECTED to move by more than PARITY_MIN_ROWS, with
 * the tolerance each needs and why.
 *
 * Five rows is right for a dimension table that changes when a subnet
 * retunes. It is meaningless for a pruned window written thousands of times an
 * hour: `surface_checks` takes ~2,000 rows an hour, and the two stores prune
 * on separate crons, so the counts differ by whatever landed or was deleted
 * between the two COUNT(*)s. Held to five it would report a gap on every tick
 * forever, which is how a check stops being read (#9881).
 *
 * A tolerance is NOT a silence. The gap still appears in the detail line and a
 * difference above the tolerance still makes the verdict stale -- what changes
 * is only where "this is churn" ends and "this is structural" begins.
 */
export const PARITY_TOLERANCE: Readonly<Record<string, number>> = {
  // One hour of writes at the measured rate, plus the prune skew between two
  // independent hourly crons. Anything past this is not timing.
  surface_checks: 5_000,
};

export interface ParityDb {
  prepare(sql: string): { all(): Promise<{ results?: unknown[] } | null> };
}

export interface TableParity {
  table: string;
  d1: number;
  neon: number;
  /** d1 - neon. NEGATIVE means Neon holds more, which is a real state. */
  delta: number;
}

/**
 * D1's compound-SELECT ceiling, MEASURED against production 2026-08-07.
 *
 * Upstream SQLite defaults `SQLITE_MAX_COMPOUND_SELECT` to 500. D1 builds it
 * at FIVE. Probed directly against the production database: 3 and 5 terms
 * answer, 6 and up fail with
 *
 *     D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR
 *
 * This is not a tuning knob, it is the reason this lane never worked. It
 * shipped in #9850 sweeping ten tables in one UNION ALL -- five past the
 * limit -- so the D1 half of the comparison threw before it read a single row
 * and the watchdog recorded `unknown: counts unreadable` every hour from the
 * moment it deployed. A watchdog that cannot read its subject reports the
 * truth about itself and nothing about what it watches, which is why this was
 * only caught by looking at the lane rather than trusting that it was green.
 *
 * Batching here rather than at the call site because the ceiling grows more
 * dangerous as PARITY_TABLES grows: every table added to the migration adds a
 * term, and the failure is total (no counts at all) rather than partial.
 */
export const D1_MAX_COMPOUND_TERMS = 5;

/**
 * The sweep, split into statements no wider than D1 will parse.
 *
 * Postgres has no comparable limit, but both stores run the SAME batches so
 * the two halves stay symmetric and one row-shape reader serves both.
 */
export function parityCountBatches(
  tables: readonly string[],
  perBatch: number = D1_MAX_COMPOUND_TERMS,
): string[] {
  const batches: string[] = [];
  for (let i = 0; i < tables.length; i += perBatch) {
    batches.push(parityCountSql(tables.slice(i, i + perBatch)));
  }
  return batches;
}

/** One `SELECT count` per table, unioned. Never call with more than
 * D1_MAX_COMPOUND_TERMS tables -- use parityCountBatches. */
export function parityCountSql(tables: readonly string[]): string {
  return tables
    .map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`)
    .join(" UNION ALL ");
}

function countsFrom(rows: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (row?.t == null || row.n == null) continue;
    const n = Number(row.n);
    if (Number.isFinite(n)) out.set(String(row.t), n);
  }
  return out;
}

/** Tables whose counts differ by at least PARITY_MIN_ROWS, worst first. */
export function parityGaps(
  d1: ReadonlyMap<string, number>,
  neon: ReadonlyMap<string, number>,
  minRows: number = PARITY_MIN_ROWS,
): TableParity[] {
  const out: TableParity[] = [];
  for (const table of d1.keys()) {
    const a = d1.get(table);
    const b = neon.get(table);
    // A table missing from ONE side is not a parity gap of "everything" -- it
    // is a table that has not been created there yet, which migrations/neon
    // answers and this lane should not shout about.
    if (a == null || b == null) continue;
    const delta = a - b;
    const tolerance = Math.max(minRows, PARITY_TOLERANCE[table] ?? 0);
    if (Math.abs(delta) >= tolerance)
      out.push({ table, d1: a, neon: b, delta });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * The gaps that were ALSO present, at the same size, in the previous verdict.
 *
 * Churn moves between ticks; a structural gap does not. Comparing sizes rather
 * than merely "was it listed" is what keeps a table that is actively
 * backfilling -- deficit shrinking every tick -- from alarming while it works.
 */
export function persistentGaps(
  current: readonly TableParity[],
  previousDetail: string | null | undefined,
): TableParity[] {
  if (!previousDetail) return [];
  const seen = new Map<string, number>();
  for (const m of previousDetail.matchAll(/(\w+) ([+-]\d+)/g)) {
    seen.set(m[1]!, Number(m[2]));
  }
  return current.filter(
    (g) => seen.get(g.table) === g.delta && !EXPECTED_DIVERGENCE[g.table],
  );
}

/** `hotkey_alpha -29422` — table then signed delta, which persistentGaps reads back. */
export function describeParity(
  gaps: readonly TableParity[],
  checked: number,
): string {
  if (gaps.length === 0) return `${checked} table(s) in parity`;
  return gaps
    .map((g) => `${g.table} ${g.delta > 0 ? "+" : ""}${g.delta}`)
    .join(", ");
}

export interface ParityDeps {
  db?: ParityDb;
  sql?: PgUnsafe;
  laneHealthDb?: LaneHealthDb;
  now?: () => number;
}

export interface ParityOutcome {
  attempted: boolean;
  gaps?: TableParity[];
  persistent?: TableParity[];
  reason?: string;
}

export async function runNeonParityWatchdog(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike,
  deps: ParityDeps = {},
): Promise<ParityOutcome> {
  const db = deps.db ?? (env?.METAGRAPH_HEALTH_DB as ParityDb | undefined);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ?? (hyperdrive ? createPgSql(hyperdrive, ctx) : undefined);
  const now = deps.now ?? Date.now;
  if (!db?.prepare || !sql?.unsafe) return { attempted: false };

  const batches = parityCountBatches(PARITY_TABLES);
  let d1Counts: Map<string, number>;
  let neonCounts: Map<string, number>;
  try {
    const [a, b] = await Promise.all([
      Promise.all(batches.map((s) => db.prepare(s).all())),
      Promise.all(batches.map((s) => sql.unsafe(s) as Promise<unknown>)),
    ]);
    if (a.some((r) => !r)) throw new Error("d1 returned nothing");
    d1Counts = countsFrom(a.flatMap((r) => r?.results ?? []));
    neonCounts = countsFrom(b.flatMap((r) => (Array.isArray(r) ? r : [])));
  } catch (error) {
    // `unknown`, not `stale`: a store that would not answer is not evidence of
    // a gap, and calling it one would put every table in the detail line.
    await recordLaneVerdict(laneDb, {
      lane: NEON_PARITY_LANE,
      verdict: "unknown",
      age_ms: null,
      detail: `counts unreadable: ${error instanceof Error ? error.message : String(error)}`,
      checked_at: now(),
    });
    return { attempted: true, reason: "counts unreadable" };
  }

  const gaps = parityGaps(d1Counts, neonCounts);
  const previous = (await loadLatestLaneHealth(laneDb))[NEON_PARITY_LANE];
  const persistent = persistentGaps(gaps, previous?.detail);

  await recordLaneVerdict(laneDb, {
    lane: NEON_PARITY_LANE,
    verdict: persistent.length === 0 ? "ok" : "stale",
    age_ms: null,
    // The detail always lists CURRENT gaps, persistent or not: the next tick
    // reads it back to decide persistence, so dropping the transient ones
    // would make every gap look new forever.
    detail: describeParity(gaps, d1Counts.size),
    checked_at: now(),
  });
  return { attempted: true, gaps, persistent };
}
