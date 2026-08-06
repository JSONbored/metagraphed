// The producer behind /api/v1/chain/concentration/history (#9628): one
// network-wide concentration card per UTC day.
//
// ## IT RUNS THE SERVING BUILDER, NOT A SQL REIMPLEMENTATION
//
// Gini, HHI, Nakamoto and the top-K cutoffs ARE expressible in SQL with window
// functions. Writing them a second time here would create two definitions of
// one metric that agree until they quietly do not -- and the one that drifts
// would be the historical one, discovered long after the divergence. This
// instead reads a day's raw rows out of `neuron_daily` and hands them to
// `buildChainConcentration`, the same function /chain/concentration serves, so
// a historical point and the live card are the same computation by
// construction.
//
// ## IT BACKFILLS ITSELF, BOUNDED
//
// `neuron_daily` already held 27 days when this shipped, and none of them could
// be aggregated by a migration for the reason above. Rather than a one-off
// script -- a second code path that can drift from this one -- each tick asks
// which days have no rollup row yet and processes the newest few. That fills
// the existing history within a few ticks, survives a gap in the cron, and
// needs no separate recovery path.
//
// The bound matters: a day is ~30,100 rows, so an unbounded catch-up would read
// 800,000 in one tick on first run.

import { buildChainConcentration } from "./concentration.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

type Row = Record<string, unknown>;

/**
 * Days processed per tick.
 *
 * One day is ~30,100 `neuron_daily` rows, and the tick also has to hold them in
 * memory to compute entity grouping. Three is a full catch-up of the 27 days
 * already present inside half a day of hourly ticks, without any single tick
 * reading a hundred thousand rows.
 */
export const CHAIN_CONCENTRATION_ROLLUP_MAX_DAYS_PER_TICK = 3;

export const CHAIN_CONCENTRATION_DAILY_TABLE = "chain_concentration_daily";

/** The columns buildChainConcentration reads, from the DATED table. */
export const CHAIN_CONCENTRATION_DAILY_READ_COLUMNS =
  "stake_tao, emission_tao, coldkey, validator_permit, netuid, captured_at";

export interface RollupDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
      run?(): Promise<unknown>;
    };
  };
}

/**
 * Days present in `neuron_daily` with no rollup row yet, newest first.
 *
 * Newest first because a fresh gap matters more than an old one: if the lane
 * has been down, the days a caller is most likely to ask for are the recent
 * ones, and they should come back first rather than after the backfill has
 * walked forward from the beginning.
 *
 * TODAY IS EXCLUDED. `neuron_daily` gains rows for the current day as the
 * capture proceeds, so rolling it up mid-day would store a card computed over a
 * partial network and then never revisit it -- a point that looks like a real
 * measurement of a much smaller network. Only complete days are rolled.
 */
export function pendingDaysSql(): string {
  return (
    "SELECT DISTINCT nd.snapshot_date AS day" +
    " FROM neuron_daily nd" +
    ` LEFT JOIN ${CHAIN_CONCENTRATION_DAILY_TABLE} c ON c.day = nd.snapshot_date` +
    " WHERE c.day IS NULL AND nd.snapshot_date < ?" +
    " ORDER BY nd.snapshot_date DESC LIMIT ?"
  );
}

/**
 * Roll up every day that has no card yet, newest first, bounded per tick.
 *
 * Best-effort per day: one day that fails must not stop the others, because the
 * failure is most likely that day's data and the rest of the backfill is still
 * worth having. A failed day simply stays pending and is retried next tick,
 * which is the recovery path -- there is no other one to drift from.
 */
export async function rollupChainConcentration(
  db: RollupDb | null | undefined,
  {
    nowMs = Date.now(),
    maxDays = CHAIN_CONCENTRATION_ROLLUP_MAX_DAYS_PER_TICK,
    env = null,
  }: { nowMs?: number; maxDays?: number; env?: unknown } = {},
): Promise<Row> {
  if (!db?.prepare) return { rolled: false, reason: "unavailable" };

  let pending: string[];
  try {
    const res = await db
      .prepare(pendingDaysSql())
      .bind(utcDay(nowMs), maxDays)
      .all?.();
    pending = ((res?.results ?? []) as Row[])
      .map((r) => r?.day)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
  } catch (error) {
    await recordExceptionEvent(env as never, {
      error,
      route: "chain-concentration-rollup-scan",
    });
    return { rolled: false, reason: "scan_failed" };
  }

  const rolled: string[] = [];
  const failed: string[] = [];
  for (const day of pending) {
    try {
      const res = await db
        .prepare(
          `SELECT ${CHAIN_CONCENTRATION_DAILY_READ_COLUMNS}` +
            " FROM neuron_daily WHERE snapshot_date = ?",
        )
        .bind(day)
        .all?.();
      const rows = (res?.results ?? []) as Row[];
      // A day with no rows is not a day of zero concentration -- it is a day
      // the capture did not run. Storing a card for it would manufacture a
      // point; leaving it pending costs one scan a tick and stays honest.
      if (rows.length === 0) {
        failed.push(day);
        continue;
      }
      const card = buildChainConcentration(rows) as unknown as Row;
      await db
        .prepare(
          `INSERT INTO ${CHAIN_CONCENTRATION_DAILY_TABLE}` +
            " (day, neuron_count, card, source_captured_at, computed_at," +
            " builder_version)" +
            " VALUES (?, ?, ?, ?, ?, ?)" +
            " ON CONFLICT(day) DO UPDATE SET" +
            " neuron_count = excluded.neuron_count," +
            " card = excluded.card," +
            " source_captured_at = excluded.source_captured_at," +
            " computed_at = excluded.computed_at," +
            " builder_version = excluded.builder_version",
        )
        .bind(
          day,
          // The row count, not a field read back out of the card: it is the
          // same number by definition, and taking it from the rows keeps the
          // one NOT NULL count an integer by construction. subnet_count and
          // entity_count are NOT lifted out -- they are already in the card,
          // and a second copy is a second thing that can disagree.
          rows.length,
          JSON.stringify(card),
          capturedAtMs(rows),
          nowMs,
          // No fallback: the builder declares this, and if it ever stops, the
          // NOT NULL column rejects the row, the day is marked failed, and the
          // next tick retries it. A defaulted version would instead record a
          // point as computed under a definition it was not, which is the one
          // thing this column exists to prevent.
          Number(card.schema_version),
        )
        .run?.();
      rolled.push(day);
    } catch (error) {
      failed.push(day);
      await recordExceptionEvent(env as never, {
        error,
        route: "chain-concentration-rollup",
      });
    }
  }

  return {
    rolled: rolled.length > 0,
    days_rolled: rolled,
    days_failed: failed,
    // Pending BEFORE this tick, so a reader of the cron summary can see the
    // backfill draining rather than only its last step.
    days_pending: pending.length,
  };
}

/**
 * The newest `captured_at` among a day's rows -- WHEN the network looked like
 * this, as distinct from when it was computed.
 */
function capturedAtMs(rows: Row[]): number | null {
  let newest: number | null = null;
  for (const r of rows) {
    const n = Number(r?.captured_at);
    if (Number.isFinite(n) && n > 0 && (newest === null || n > newest)) {
      newest = n;
    }
  }
  return newest;
}

/** 'YYYY-MM-DD' in UTC, matching snapshot_date's own format. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
