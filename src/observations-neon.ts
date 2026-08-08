// The observation family, against Neon (#10069).
//
// FIVE TABLES, ONE UNIT. Two of these writes are `INSERT ... SELECT FROM
// surface_checks` -- they aggregate INSIDE the store. So the moment
// surface_checks stops being written to D1, both rollups aggregate an empty
// table unless they move with it. There is no table-at-a-time path here, which
// is why this file covers the whole family rather than one lane.
//
// Every statement below was checked against the live database rather than
// translated by eye. The three that do not survive a naive port:
//
// 1. `CAST(x AS INTEGER)` TRUNCATES in SQLite and ROUNDS in Postgres --
//    CAST(1.7) is 1 there and 2 here, CAST(2.5) is 2 and 3. latencyStatColumns
//    picks p50/p95/p99 by nearest rank with
//      `CAST(q*n AS INTEGER) + (q*n > CAST(q*n AS INTEGER))`
//    which is SQLite's ceil written as trunc-plus-carry, because SQLite has no
//    ceil. In Postgres that breaks twice: the CAST rounds, AND `(a > b)` is a
//    boolean Postgres will not add to an integer. The second half errors; the
//    FIRST HALF WOULD NOT -- it would return a confidently wrong percentile.
//    Postgres has the function SQLite lacked, so the port is simpler than the
//    original: `ceil(q * lat_cnt)::int`, verified identical to the SQLite
//    expression at lat_cnt = 1, 3, 7, 20 and 100 for all three quantiles.
//
// 2. `surface_checks.ok` is INTEGER 0/1 in D1 and BOOLEAN in Neon, so `SUM(ok)`
//    and `ok = 1` are both type errors. Counting moves to
//    `COUNT(*) FILTER (WHERE ok)`, which is also what it always meant.
//
// 3. `ROUND(x, 4)` has no double-precision overload in Postgres, so the ratio
//    is rounded as numeric and cast back.
//
// `ifnull(netuid, -1)` needs no translation at all: Neon's
// ux_surface_failure_daily_key is already `(day, netuid, kind, classification)
// NULLS NOT DISTINCT`, the native form of the expression-index trick D1 needed
// because SQLite treats NULLs as distinct in a unique constraint.
import type { PassTallySql } from "./pass-completeness.ts";

type Row = Record<string, unknown>;

export interface ObservationWrite {
  ok: boolean;
  reason?: string;
}

/** A probe whose latency counts. `ok` is a real boolean here, so it stands on
 * its own -- `ok = 1` is the D1 spelling and a type error in Postgres. */
const OK_LATENCY = "ok AND latency_ms IS NOT NULL";

/**
 * The ranked CTE, Postgres form.
 *
 * Ranks each stable surface's ok-latency rows by latency and counts them,
 * passing every row through so uptime still totals over all checks.
 */
function rankedChecksCte(): string {
  return `WITH ranked AS (
    SELECT
      surface_id,
      COALESCE(surface_key, surface_id) AS surface_key,
      netuid,
      ok,
      latency_ms,
      CASE WHEN ${OK_LATENCY} THEN ROW_NUMBER() OVER (
        PARTITION BY COALESCE(surface_key, surface_id), netuid,
                     CASE WHEN ${OK_LATENCY} THEN 0 ELSE 1 END
        ORDER BY latency_ms
      ) END AS rn,
      COUNT(*) FILTER (WHERE ${OK_LATENCY}) OVER (
        PARTITION BY COALESCE(surface_key, surface_id), netuid
      ) AS lat_cnt
    FROM surface_checks
    WHERE checked_at >= $1 AND checked_at < $2
  )`;
}

/** Nearest-rank order statistic: the value at 1-based position ceil(q*N) among
 * the N ok-latency rows. `ceil` directly, NOT SQLite's trunc-plus-carry -- see
 * this file's header for why that expression cannot come across. */
function pick(q: number, name: string): string {
  return `MAX(CASE WHEN rn = ceil(${q} * lat_cnt)::int THEN latency_ms END) AS ${name}`;
}

const LATENCY_COLUMNS = [
  "MAX(lat_cnt) AS latency_samples",
  `ROUND(AVG(CASE WHEN ${OK_LATENCY} THEN latency_ms END))::int AS avg_latency_ms`,
  pick(0.5, "p50"),
  pick(0.95, "p95"),
  pick(0.99, "p99"),
].join(",\n       ");

async function attempt(
  sql: PassTallySql,
  run: () => Promise<unknown>,
  label: string,
): Promise<ObservationWrite> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    console.error(`[${label}]`, reason);
    void sql;
    return { ok: false, reason };
  }
}

/**
 * One probe sweep: a surface_checks row per surface, plus the latest-status
 * upsert.
 *
 * THE RENAME, AND WHY IT IS TWO STATEMENTS. D1's upsert names two conflict
 * targets -- surface_key when present, so a display-id rename updates the alias
 * in place, and surface_id as the fallback for keyless rows. Postgres permits
 * exactly ONE ON CONFLICT clause per statement, and both arbiters exist in Neon
 * (idx_surface_status_key partial-unique, surface_status_pkey), so they cannot
 * be combined.
 *
 * Splitting rows by whether surface_key is present would ALMOST work, and fails
 * on the one case the second arbiter was added for: a keyed row whose
 * surface_id already exists under a different key raises a unique violation
 * instead of updating. So the rename is RESOLVED FIRST -- the row holding this
 * surface_key adopts the new surface_id -- and the upsert then has a single
 * arbiter with nothing left to collide on. Verified against the live schema:
 * one row, the new id, and last_ok preserved.
 *
 * LAST_OK IS A HIGH-WATER MARK (#9634). Every other column takes what this run
 * measured; last_ok records when the surface was last seen WORKING, so a run
 * that did not see it working has observed nothing about it and must not clear
 * it. COALESCE rather than a WHERE guard, because excluded.last_ok is
 * authoritative whenever it is non-null and only "we do not know" arrives null.
 */
export async function persistProbesToNeon(
  sql: PassTallySql,
  probed: Row[],
  runAt: number,
): Promise<ObservationWrite> {
  if (!probed.length) return { ok: false, reason: "no_rows" };
  return attempt(
    sql,
    async () => {
      for (const row of probed) {
        await sql.unsafe(
          `INSERT INTO surface_checks
             (surface_id, surface_key, netuid, kind, status, classification,
              latency_ms, status_code, ok, checked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (surface_id, checked_at) DO NOTHING`,
          [
            row.surface_id,
            row.surface_key ?? null,
            row.netuid ?? null,
            row.kind ?? null,
            row.status ?? null,
            row.classification ?? null,
            row.latency_ms ?? null,
            row.status_code ?? null,
            row.status === "ok",
            row.checked_at_ms,
          ],
        );
        if (row.surface_key) {
          // Resolve the rename before the upsert -- see this function's header.
          await sql.unsafe(
            `UPDATE surface_status SET surface_id = $1
              WHERE surface_key = $2 AND surface_id <> $1`,
            [row.surface_id, row.surface_key],
          );
        }
        await sql.unsafe(
          `INSERT INTO surface_status
             (surface_id, surface_key, netuid, kind, url, provider, status,
              classification, latency_ms, status_code, last_checked, last_ok,
              consecutive_failures, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (surface_id) DO UPDATE SET
             surface_key=excluded.surface_key,
             netuid=excluded.netuid, kind=excluded.kind, url=excluded.url,
             provider=excluded.provider, status=excluded.status,
             classification=excluded.classification,
             latency_ms=excluded.latency_ms, status_code=excluded.status_code,
             last_checked=excluded.last_checked,
             last_ok=COALESCE(excluded.last_ok, surface_status.last_ok),
             consecutive_failures=excluded.consecutive_failures,
             updated_at=excluded.updated_at`,
          [
            row.surface_id,
            row.surface_key ?? null,
            row.netuid ?? null,
            row.kind ?? null,
            row.url ?? null,
            row.provider ?? null,
            row.status ?? null,
            row.classification ?? null,
            row.latency_ms ?? null,
            row.status_code ?? null,
            row.checked_at_ms,
            row.last_ok_ms ?? null,
            row.consecutive_failures ?? 0,
            runAt,
          ],
        );
      }
    },
    "persistProbesToNeon",
  );
}

/**
 * The failure-REASON rollup: one row per (day, netuid, kind, classification).
 *
 * The conflict target is the plain column list, NOT an expression: Neon's
 * unique index is NULLS NOT DISTINCT, so a NULL netuid collides with itself
 * the way D1 needed `ifnull(netuid, -1)` to arrange.
 */
export async function rollupFailureReasonsToNeon(
  sql: PassTallySql,
  days: { date: string; start: number; end: number }[],
  runAt: number,
): Promise<ObservationWrite> {
  return attempt(
    sql,
    async () => {
      for (const { date, start, end } of days) {
        await sql.unsafe(
          `INSERT INTO surface_failure_daily
             (day, netuid, kind, classification, checks, updated_at)
           SELECT $1, netuid, kind, classification, COUNT(*), $2
             FROM surface_checks
            WHERE checked_at >= $3 AND checked_at < $4
              AND kind IS NOT NULL AND classification IS NOT NULL
            GROUP BY netuid, kind, classification
           ON CONFLICT (day, netuid, kind, classification) DO UPDATE SET
             checks = excluded.checks,
             updated_at = excluded.updated_at`,
          [date, runAt, start, end],
        );
      }
    },
    "rollupFailureReasonsToNeon",
  );
}

/**
 * The day rollup, with the clamped-ratio and status semantics the daily series
 * has always had.
 *
 * The ratio is clamped BELOW 1.0 unless every sample was ok, so a surface with
 * one failure in ten thousand cannot round to a clean 100%.
 */
export async function rollupUptimeDailyToNeon(
  sql: PassTallySql,
  days: { date: string; start: number; end: number }[],
  runAt: number,
): Promise<ObservationWrite> {
  const conflictColumns = `
       surface_key = excluded.surface_key,
       netuid = excluded.netuid,
       samples = excluded.samples,
       ok_count = excluded.ok_count,
       uptime_ratio = excluded.uptime_ratio,
       avg_latency_ms = excluded.avg_latency_ms,
       latency_samples = excluded.latency_samples,
       p50_latency_ms = excluded.p50_latency_ms,
       p95_latency_ms = excluded.p95_latency_ms,
       p99_latency_ms = excluded.p99_latency_ms,
       status = excluded.status,
       updated_at = excluded.updated_at`;
  return attempt(
    sql,
    async () => {
      for (const { date, start, end } of days) {
        await sql.unsafe(
          `${rankedChecksCte()}
           INSERT INTO surface_uptime_daily
             (surface_id, surface_key, netuid, day, samples, ok_count,
              uptime_ratio, latency_samples, avg_latency_ms, p50_latency_ms,
              p95_latency_ms, p99_latency_ms, status, updated_at)
           SELECT
             MAX(surface_id),
             surface_key,
             netuid,
             $3,
             COUNT(*),
             COUNT(*) FILTER (WHERE ok),
             CASE
               WHEN COUNT(*) FILTER (WHERE ok) = COUNT(*) THEN 1.0
               WHEN ROUND((COUNT(*) FILTER (WHERE ok))::numeric
                          / COUNT(*), 4) >= 1.0 THEN 0.9999
               ELSE ROUND((COUNT(*) FILTER (WHERE ok))::numeric
                          / COUNT(*), 4)::float8
             END,
             ${LATENCY_COLUMNS},
             CASE
               WHEN COUNT(*) FILTER (WHERE ok) = COUNT(*) THEN 'ok'
               WHEN COUNT(*) FILTER (WHERE ok) = 0 THEN 'failed'
               ELSE 'degraded'
             END,
             $4
           FROM ranked
           GROUP BY surface_key, netuid
           ON CONFLICT (surface_id, day) DO UPDATE SET${conflictColumns}`,
          [start, end, date, runAt],
        );
      }
    },
    "rollupUptimeDailyToNeon",
  );
}

/** The raw-window prune. Runs ONLY after the day rollup reported success --
 * the caller owns that ordering, as it always has. */
export async function pruneChecksNeon(
  sql: PassTallySql,
  cutoff: number,
): Promise<ObservationWrite> {
  return attempt(
    sql,
    () => sql.unsafe(`DELETE FROM surface_checks WHERE checked_at < $1`, [
      cutoff,
    ]),
    "pruneChecksNeon",
  );
}
