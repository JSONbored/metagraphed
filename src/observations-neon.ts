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
// 2. `surface_checks.ok` is INTEGER 0/1 in the store and BOOLEAN in Neon, so `SUM(ok)`
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
// OK_LATENCY is shared with the store readers rather than restated here (#10086).
// It used to be defined twice -- `ok AND ...` in this file, `ok = 1 AND ...` in
// health-sql.ts -- which is precisely how the two stores drifted apart without
// anything failing: each spelling was correct for the store its own file
// targeted, and neither could run against the other.
import { OK_LATENCY } from "./health-sql.ts";
import { hyperdriveConnectionString } from "./read-store.ts";

/** The runner shape createPgSql hands out. Declared here rather than imported
 * so this module depends on the SHAPE and not on another lane's file. */
export interface ObservationsSql {
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
}

type Row = Record<string, unknown>;

export interface ObservationWrite {
  ok: boolean;
  reason?: string;
}

/**
 * The ranked CTE, Postgres form.
 *
 * Ranks each stable surface's ok-latency rows by latency and counts them,
 * passing every row through so uptime still totals over all checks.
 * A current status owns its display alias. If history contains another key
 * under that alias, retain it under a history-qualified identity instead of
 * colliding with or merging into the current surface. Metadata comes from
 * the latest check, so missing older metadata cannot split one identity.
 */
function rankedChecksCte(): string {
  return `WITH windowed AS (
    SELECT surface_id, COALESCE(surface_key, surface_id) AS surface_key,
           netuid, ok, latency_ms, checked_at
    FROM surface_checks
    WHERE checked_at >= $1 AND checked_at < $2
  ), latest_identity AS (
    SELECT DISTINCT ON (c.surface_key)
      c.surface_key, c.netuid,
      COALESCE(s.surface_id, c.surface_id) AS alias,
      s.surface_id IS NOT NULL AS current_alias, c.checked_at
    FROM windowed c
    LEFT JOIN surface_status s ON s.surface_key = c.surface_key
    ORDER BY c.surface_key, c.checked_at DESC, c.surface_id DESC
  ), identities AS (
    SELECT surface_key, netuid,
      CASE WHEN ROW_NUMBER() OVER (
        PARTITION BY alias
        ORDER BY current_alias DESC, checked_at DESC, surface_key
      ) = 1 THEN alias ELSE 'history:' || surface_key END AS surface_id
    FROM latest_identity
  ), ranked AS (
    SELECT
      i.surface_id,
      c.surface_key,
      i.netuid,
      ok,
      latency_ms,
      CASE WHEN ${OK_LATENCY} THEN ROW_NUMBER() OVER (
        PARTITION BY c.surface_key,
                     CASE WHEN ${OK_LATENCY} THEN 0 ELSE 1 END
        ORDER BY latency_ms
      ) END AS rn,
      COUNT(*) FILTER (WHERE ${OK_LATENCY}) OVER (
        PARTITION BY c.surface_key
      ) AS lat_cnt
    FROM windowed c
    JOIN identities i ON i.surface_key = c.surface_key
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
  sql: ObservationsSql,
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
 * A display alias may already belong to another stable key (#12005). Evict
 * that obsolete latest-status alias and upsert by stable key in ONE statement,
 * so an occupied alias cannot abort the sweep or leave a half-applied rename.
 * Keep displaced stable-key status under a history alias: the next probe may
 * have no cached last_ok, and deleting its status would lose a measured success.
 * Raw checks remain intact. Keyless rows retain the display-id arbiter.
 *
 * Older probes still enter history, but cannot evict a newer alias or replace
 * newer status. last_ok remains a high-water mark of measured successes.
 */
export async function persistProbesToNeon(
  sql: ObservationsSql,
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
        const keyed = Boolean(row.surface_key);
        await sql.unsafe(
          `${
            keyed
              ? `WITH alias_conflict AS (
             SELECT surface_id, surface_key FROM surface_status
             WHERE surface_id = $1 AND surface_key IS DISTINCT FROM $2
               AND COALESCE(last_checked, 0) <= $11
               AND NOT EXISTS (
                 SELECT 1 FROM surface_status newer
                 WHERE newer.surface_key = $2 AND newer.last_checked > $11
               )
           ), displaced_alias AS (
             UPDATE surface_status SET surface_id = 'history:' || surface_key
             WHERE surface_id IN (
               SELECT surface_id FROM alias_conflict WHERE surface_key IS NOT NULL
             )
             RETURNING surface_id
           ), displaced_keyless AS (
             DELETE FROM surface_status
             WHERE surface_id IN (
               SELECT surface_id FROM alias_conflict WHERE surface_key IS NULL
             )
             RETURNING surface_id
           )`
              : ""
          }
           INSERT INTO surface_status
             (surface_id, surface_key, netuid, kind, url, provider, status,
              classification, latency_ms, status_code, last_checked, last_ok,
              consecutive_failures, updated_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
           ${
             keyed
               ? `FROM (SELECT COUNT(*) FROM displaced_alias) displaced
             CROSS JOIN (SELECT COUNT(*) FROM displaced_keyless) legacy
             WHERE NOT EXISTS (
               SELECT 1 FROM surface_status newer
               WHERE newer.surface_id = $1
                 AND newer.surface_key IS DISTINCT FROM $2
                 AND newer.last_checked > $11
             )`
               : ""
           }
           ON CONFLICT ${keyed ? "(surface_key) WHERE surface_key IS NOT NULL" : "(surface_id)"} DO UPDATE SET
             surface_id=excluded.surface_id,
             surface_key=COALESCE(excluded.surface_key, surface_status.surface_key),
             netuid=excluded.netuid, kind=excluded.kind, url=excluded.url,
             provider=excluded.provider, status=excluded.status,
             classification=excluded.classification,
             latency_ms=excluded.latency_ms, status_code=excluded.status_code,
             last_checked=excluded.last_checked,
             last_ok=GREATEST(excluded.last_ok, surface_status.last_ok),
             consecutive_failures=excluded.consecutive_failures,
             updated_at=excluded.updated_at
           WHERE surface_status.last_checked IS NULL
              OR surface_status.last_checked <= excluded.last_checked`,
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
  sql: ObservationsSql,
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
  sql: ObservationsSql,
  days: { date: string; start: number; end: number }[],
  runAt: number,
): Promise<ObservationWrite> {
  return attempt(
    sql,
    async () => {
      for (const { date, start, end } of days) {
        await sql.unsafe(
          // Today and yesterday are recomputed from the retained raw window.
          // Replace the day's aliases atomically, including alias swaps; an
          // upsert cannot arbitrate both (display id, day) and (stable key, day).
          // No raw checks means no evidence to replace a previous rollup.
          `${rankedChecksCte()}, replaced_day AS (
             DELETE FROM surface_uptime_daily
             WHERE day = $3 AND EXISTS (SELECT 1 FROM ranked)
             RETURNING surface_id
           )
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
           CROSS JOIN (SELECT COUNT(*) FROM replaced_day) previous
           GROUP BY surface_key, netuid`,
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
  sql: ObservationsSql,
  cutoff: number,
): Promise<ObservationWrite> {
  return attempt(
    sql,
    () =>
      sql.unsafe(`DELETE FROM surface_checks WHERE checked_at < $1`, [cutoff]),
    "pruneChecksNeon",
  );
}

/** The completeness/economics trajectory upsert: one row per (netuid, day).
 *
 * The only member of this family that could have moved on its own -- a plain
 * row upsert on the primary key, which writeRowsToNeon already covers. It rides
 * here because it shares a module and a producer with the other four, not
 * because it shares their constraint. `emission_enabled` and `subtoken_enabled`
 * are 0/1 with a CHECK in the store and real BOOLEAN in Neon. */
export async function upsertSubnetSnapshotsToNeon(
  sql: ObservationsSql,
  rows: Row[],
): Promise<ObservationWrite> {
  if (!rows.length) return { ok: false, reason: "no_rows" };
  const toBool = (v: unknown) => (v == null ? null : Boolean(v));
  return attempt(
    sql,
    async () => {
      for (const row of rows) {
        await sql.unsafe(
          `INSERT INTO subnet_snapshots
             (netuid, snapshot_date, completeness_score, surface_count,
              endpoint_count, monitored_count, candidate_count, captured_at,
              validator_count, miner_count, total_stake_tao, alpha_price_tao,
              emission_share, tao_in_pool_tao, alpha_in_pool, alpha_out_pool,
              subnet_volume_tao, tao_in_emission_tao, excess_tao,
              alpha_in_emission, alpha_out_emission, miner_burned_fraction,
              emission_enabled, subtoken_enabled, first_emission_block,
              pipeline_block, pipeline_block_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                   $18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (netuid, snapshot_date) DO UPDATE SET
             completeness_score=excluded.completeness_score,
             surface_count=excluded.surface_count,
             endpoint_count=excluded.endpoint_count,
             monitored_count=excluded.monitored_count,
             candidate_count=excluded.candidate_count,
             captured_at=excluded.captured_at,
             validator_count=excluded.validator_count,
             miner_count=excluded.miner_count,
             total_stake_tao=excluded.total_stake_tao,
             alpha_price_tao=excluded.alpha_price_tao,
             emission_share=excluded.emission_share,
             tao_in_pool_tao=excluded.tao_in_pool_tao,
             alpha_in_pool=excluded.alpha_in_pool,
             alpha_out_pool=excluded.alpha_out_pool,
             subnet_volume_tao=excluded.subnet_volume_tao,
             tao_in_emission_tao=excluded.tao_in_emission_tao,
             excess_tao=excluded.excess_tao,
             alpha_in_emission=excluded.alpha_in_emission,
             alpha_out_emission=excluded.alpha_out_emission,
             miner_burned_fraction=excluded.miner_burned_fraction,
             emission_enabled=excluded.emission_enabled,
             subtoken_enabled=excluded.subtoken_enabled,
             first_emission_block=excluded.first_emission_block,
             pipeline_block=excluded.pipeline_block,
             pipeline_block_hash=excluded.pipeline_block_hash`,
          [
            row.netuid,
            row.snapshot_date,
            row.completeness_score ?? null,
            row.surface_count ?? null,
            row.endpoint_count ?? null,
            row.monitored_count ?? null,
            row.candidate_count ?? null,
            row.captured_at ?? null,
            row.validator_count ?? null,
            row.miner_count ?? null,
            row.total_stake_tao ?? null,
            row.alpha_price_tao ?? null,
            row.emission_share ?? null,
            row.tao_in_pool_tao ?? null,
            row.alpha_in_pool ?? null,
            row.alpha_out_pool ?? null,
            row.subnet_volume_tao ?? null,
            row.tao_in_emission_tao ?? null,
            row.excess_tao ?? null,
            row.alpha_in_emission ?? null,
            row.alpha_out_emission ?? null,
            row.miner_burned_fraction ?? null,
            toBool(row.emission_enabled),
            toBool(row.subtoken_enabled),
            row.first_emission_block ?? null,
            row.pipeline_block ?? null,
            row.pipeline_block_hash ?? null,
          ],
        );
      }
    },
    "upsertSubnetSnapshotsToNeon",
  );
}

/** The five tables this family writes, as one list, so the sole-store gate is
 * all-or-nothing over the unit that actually moves. Two of the writes
 * aggregate INSIDE the store, so a half-listed group would leave a rollup
 * reading a D1 that nothing fills. */
export const OBSERVATION_TABLES = [
  "surface_checks",
  "surface_status",
  "surface_uptime_daily",
  "surface_failure_daily",
  "subnet_snapshots",
] as const;

/** True when Neon solely owns every observation table AND Hyperdrive is bound.
 * Skipping the D1 write with nowhere to put the rows would drop a probe sweep
 * silently, and a probe not stored is gone. */
export function neonOwnsObservations(env: unknown): boolean {
  // The injected ownership predicate left with the flag (#10051): Neon is the
  // only store, so durability is the binding question alone.
  return hyperdriveConnectionString(env) !== null;
}
