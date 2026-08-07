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
] as const;

/**
 * Rows below which a difference is not worth a verdict.
 *
 * Zero would be right if these tables were static. They are not: every one is
 * written continuously, and a count taken mid-pass differs by whatever that
 * pass has landed so far. This is deliberately small -- the point is to catch
 * 14, not only 29,000.
 */
export const PARITY_MIN_ROWS = 5;

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

/** One `SELECT count` per table, unioned so the sweep is a single statement. */
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
    if (Math.abs(delta) >= minRows) out.push({ table, d1: a, neon: b, delta });
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
  return current.filter((g) => seen.get(g.table) === g.delta);
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

  const statement = parityCountSql(PARITY_TABLES);
  let d1Counts: Map<string, number>;
  let neonCounts: Map<string, number>;
  try {
    const [a, b] = await Promise.all([
      db.prepare(statement).all(),
      sql.unsafe(statement) as Promise<unknown>,
    ]);
    if (!a) throw new Error("d1 returned nothing");
    d1Counts = countsFrom(a.results ?? []);
    neonCounts = countsFrom(Array.isArray(b) ? b : []);
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
