// Neon-side retention for the rolling-window tables (#9891).
//
// ## Why this has to exist BEFORE those tables get a mirror
//
// `surface_checks`, `subnet_burn_history` and `chain_detail_*` are not
// archives -- each is a window that D1 prunes on a cron. Mirror the writes
// without mirroring the prune and Neon grows without bound; the two stores
// then differ by the entire pruned tail, permanently and by design. The
// reconciler reads that as a deficit in the wrong direction and can never
// close it, and `neon-parity` reports a persistent gap forever -- which is
// exactly the "watchdog nobody reads" failure #9881 was.
//
// So the ordering is: prune lane first, mirror second. A mirror landing first
// starts accumulating a tail immediately, and the first parity verdict after
// that is a false alarm to be explained rather than a fault to be fixed.
//
// ## Per-store and INDEPENDENT, which is the shape the repo already chose
//
// src/health-prober.ts on its dual rollup:
//
//   each prune below is likewise per-store, and blocking D1's prune on a dead
//   Postgres (or vice versa) would freeze the surviving store's retention
//
// This does not replay D1's delete list and does not care whether D1's prune
// ran. It applies the SAME cutoff to Neon independently. Two stores computing
// the same boundary from the same constant stay aligned; one waiting on the
// other stops pruning the moment the other breaks.
//
// ## The retention constants are IMPORTED, never restated
//
// A copied `30 * 24 * 60 * 60 * 1000` here would be a second source of truth
// for the same window, and the failure when they drift is silent: the stores
// keep different amounts of history and parity reports a gap nobody can
// explain. Every plan below points at the constant its D1 prune already uses.

import { assertIdentifier } from "./neon-backfill.ts";
import { neonBackfillLanes, type PgUnsafe } from "./neon-write.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { HISTORY_RETENTION_MS } from "./health-prober.ts";
import { BURN_HISTORY_RETENTION_MS } from "./subnet-burn-history.ts";

export const NEON_PRUNE_LANE = "neon-prune";

/** Hourly, offset from the other lanes so a tick does not contend with the
 * reconciler's D1 reads. */
export const NEON_PRUNE_CRON = "52 * * * *";

export interface NeonPrunePlan {
  table: string;
  /** The epoch-MILLISECOND column the cutoff applies to. */
  column: string;
  /** Imported from the module that owns the D1 prune. Never restated here. */
  retentionMs: number;
}

/**
 * One plan per rolling window, keyed by the NEON_BACKFILL_LANES name.
 *
 * A table absent from that flag is skipped entirely rather than pruned to
 * empty: nothing is mirroring it yet, so Neon's copy is not a window with a
 * tail, it is a table that has not been filled. Deleting from it would be
 * deleting a backfill in progress.
 */
export const NEON_PRUNE_PLANS: Readonly<Record<string, NeonPrunePlan>> = {
  surface_checks: {
    table: "surface_checks",
    column: "checked_at",
    retentionMs: HISTORY_RETENTION_MS,
  },
  subnet_burn_history: {
    table: "subnet_burn_history",
    column: "observed_at",
    retentionMs: BURN_HISTORY_RETENTION_MS,
  },
};

/**
 * The shortest retention this lane will act on.
 *
 * A DELETE lane running unattended needs a floor that a typo cannot get under.
 * `30 * 1000` instead of `30 * 24 * 60 * 60 * 1000` is a plausible slip and
 * would erase everything older than thirty seconds on the next tick.
 */
export const MIN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PruneTableOutcome {
  table: string;
  deleted: number;
  skipped?: string;
}

/**
 * What a cutoff would do, BEFORE doing it.
 *
 * This is the guard that matters, and it is aimed at a mistake this repo has
 * already made once: #9382 is the standing reminder of a seconds value stored
 * where milliseconds were expected. Read as ms, a seconds timestamp lands in
 * 1970 -- so a cutoff computed in ms against a column accidentally holding
 * seconds is ABOVE every row, and the DELETE takes the whole table.
 *
 * Counting survivors first turns that from data loss into a refusal. A window
 * whose every row is older than its own retention is not a window that needs
 * pruning, it is a column that is not what the plan thinks it is.
 */
export async function pruneImpact(
  sql: PgUnsafe,
  plan: NeonPrunePlan,
  cutoff: number,
): Promise<{ doomed: number; survivors: number } | null> {
  const table = assertIdentifier(plan.table, "prune table");
  const column = assertIdentifier(plan.column, "prune column");
  try {
    const rows = (await sql.unsafe(
      `SELECT COUNT(*) FILTER (WHERE ${column} < $1) AS doomed, ` +
        `COUNT(*) FILTER (WHERE ${column} >= $1) AS survivors FROM ${table}`,
      [cutoff],
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    const doomed = Number(row.doomed);
    const survivors = Number(row.survivors);
    if (!Number.isFinite(doomed) || !Number.isFinite(survivors)) return null;
    return { doomed, survivors };
  } catch {
    return null;
  }
}

/** Prune one table. Never throws; a failure costs a verdict, not the tick. */
export async function pruneNeonTable(
  sql: PgUnsafe,
  plan: NeonPrunePlan,
  now: number,
): Promise<PruneTableOutcome> {
  const base = { table: plan.table, deleted: 0 };
  if (plan.retentionMs < MIN_RETENTION_MS) {
    return {
      ...base,
      skipped: `retention below the ${MIN_RETENTION_MS}ms floor`,
    };
  }
  const cutoff = now - plan.retentionMs;
  const impact = await pruneImpact(sql, plan, cutoff);
  if (!impact) return { ...base, skipped: "impact unreadable" };
  if (impact.doomed === 0) return base;
  // THE REFUSAL. Everything older than its own retention means the column is
  // not what the plan believes -- seconds where milliseconds were expected, a
  // table never written, a cutoff computed against the wrong clock. Any of
  // those is a reason to stop, and none of them is a reason to delete.
  if (impact.survivors === 0) {
    return {
      ...base,
      skipped: `refused: every one of ${impact.doomed} row(s) is older than the cutoff`,
    };
  }
  const table = assertIdentifier(plan.table, "prune table");
  const column = assertIdentifier(plan.column, "prune column");
  try {
    await sql.unsafe(`DELETE FROM ${table} WHERE ${column} < $1`, [cutoff]);
    return { table: plan.table, deleted: impact.doomed };
  } catch (error) {
    return {
      ...base,
      skipped: `delete failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function describePrune(outcomes: readonly PruneTableOutcome[]): string {
  if (outcomes.length === 0) return "no mirrored window to prune";
  return outcomes
    .map((o) =>
      o.skipped ? `${o.table} ${o.skipped}` : `${o.table} -${o.deleted}`,
    )
    .join(", ");
}

export interface PruneDeps {
  sql?: PgUnsafe | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

export interface PruneOutcome {
  attempted: boolean;
  outcomes?: PruneTableOutcome[];
}

export async function runNeonPrune(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike,
  deps: PruneDeps = {},
): Promise<PruneOutcome> {
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql = deps.sql ?? (hyperdrive ? createPgSql(hyperdrive, ctx) : null);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;
  if (!sql?.unsafe) return { attempted: false };

  // Only tables Neon is actually being given rows for. One absent from the
  // flag has an EMPTY Neon copy, not a window with a tail.
  const enabled = new Set(neonBackfillLanes(env));
  const plans = Object.entries(NEON_PRUNE_PLANS)
    .filter(([lane]) => enabled.has(lane))
    .map(([, plan]) => plan);

  const outcomes: PruneTableOutcome[] = [];
  const at = now();
  for (const plan of plans) outcomes.push(await pruneNeonTable(sql, plan, at));

  await recordLaneVerdict(laneDb, {
    lane: NEON_PRUNE_LANE,
    // A refusal is `stale`, not `ok`: it means a plan disagrees with its own
    // table and somebody has to look. Silence would make the guard pointless.
    verdict: outcomes.some((o) => o.skipped) ? "stale" : "ok",
    age_ms: null,
    detail: describePrune(outcomes),
    checked_at: at,
  });
  return { attempted: true, outcomes };
}
