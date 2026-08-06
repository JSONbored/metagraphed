// D1 writes for the observation tables — resurrected, not invented.
//
// Every statement here ran in production until 2026-07-16, when the D1 copies
// of surface_checks / surface_status / surface_uptime_daily / subnet_snapshots
// were retired in favour of the self-hosted Postgres mirrors (#4832 series).
// That box is being decommissioned, and these tables hold OBSERVATIONS — a
// probe not stored is gone forever, with no chain to replay it from — so the
// D1 halves come back, from this repo's own history (the pre-flip
// src/health-prober.mjs), with types added and nothing about the SQL changed.
// migrations/d1/0002_observations.sql recreates the tables with the same keys
// the double ON CONFLICT targets below have always required.
//
// DUAL-WRITE, INDEPENDENTLY BEST-EFFORT. While the box lives, the Postgres
// syncs continue unchanged and reads stay on Postgres; these writes land the
// same observations in D1 alongside. When the box dies, the Postgres syncs
// degrade to their long-standing `{ synced: false }` no-ops and D1 is simply
// the copy that keeps accumulating — the cutover is the removal of a mirror,
// not a switch. This is the exact posture the pre-flip code documented for the
// other direction ("each store's rollup is independently best-effort"), now
// pointed the other way.
//
// Absent binding => no-op, the same convention as every optional binding in
// this codebase. Nothing here throws past its own boundary.
import { rankedChecksCte, latencyStatColumns } from "./health-sql.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

// The slice of the D1 API these writers use. Structural rather than the global
// D1Database type so tests can hand in node:sqlite-backed fakes and the real
// binding both.
export interface ObservationsDb {
  prepare(sql: string): {
    bind(...values: unknown[]): unknown;
  };
  batch(statements: unknown[]): Promise<unknown>;
}

type Row = Record<string, unknown>;

// D1's own per-call statement ceiling comfortably exceeds this; 50 keeps each
// batch's payload small enough that one slow statement can't stall a large
// probe sweep's whole write. Same figure the pre-flip code shipped with.
export const D1_STATEMENTS_PER_BATCH = 50;

export async function runD1StatementBatches(
  db: ObservationsDb,
  statements: unknown[],
  batchSize = D1_STATEMENTS_PER_BATCH,
): Promise<{ ok: boolean; batches: number }> {
  if (!statements.length) return { ok: true, batches: 0 };
  for (let i = 0; i < statements.length; i += batchSize) {
    await db.batch(statements.slice(i, i + batchSize));
  }
  return { ok: true, batches: Math.ceil(statements.length / batchSize) };
}

// One probe sweep -> one surface_checks row per surface plus the latest-status
// upsert. The status upsert targets BOTH conflict paths (#1005): surface_key
// when present so a display-id rename updates the alias in place, surface_id
// as the fallback for keyless rows.
export async function persistProbesToD1(
  db: ObservationsDb | undefined,
  probed: Row[],
  runAt: number,
  env?: Env | null,
): Promise<{ ok: boolean; reason?: string; batches?: number }> {
  if (!db?.prepare) return { ok: false, reason: "unavailable" };
  if (!Array.isArray(probed) || probed.length === 0) {
    return { ok: false, reason: "no_rows" };
  }
  try {
    const checkStmt = db.prepare(
      `INSERT INTO surface_checks
       (surface_id, surface_key, netuid, kind, status, classification, latency_ms, status_code, ok, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const statusStmt = db.prepare(
      `INSERT INTO surface_status
       (surface_id, surface_key, netuid, kind, url, provider, status, classification, latency_ms, status_code, last_checked, last_ok, consecutive_failures, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surface_key) WHERE surface_key IS NOT NULL DO UPDATE SET
         surface_id=excluded.surface_id,
         netuid=excluded.netuid, kind=excluded.kind, url=excluded.url,
         provider=excluded.provider, status=excluded.status,
         classification=excluded.classification, latency_ms=excluded.latency_ms,
         status_code=excluded.status_code, last_checked=excluded.last_checked,
         last_ok=excluded.last_ok, consecutive_failures=excluded.consecutive_failures,
         updated_at=excluded.updated_at
       ON CONFLICT(surface_id) DO UPDATE SET
         surface_key=excluded.surface_key,
         netuid=excluded.netuid, kind=excluded.kind, url=excluded.url,
         provider=excluded.provider, status=excluded.status,
         classification=excluded.classification, latency_ms=excluded.latency_ms,
         status_code=excluded.status_code, last_checked=excluded.last_checked,
         last_ok=excluded.last_ok, consecutive_failures=excluded.consecutive_failures,
         updated_at=excluded.updated_at`,
    );
    const statements: unknown[] = [];
    for (const row of probed) {
      statements.push(
        checkStmt.bind(
          row.surface_id,
          row.surface_key,
          row.netuid,
          row.kind,
          row.status,
          row.classification,
          row.latency_ms,
          row.status_code,
          row.status === "ok" ? 1 : 0,
          row.checked_at_ms,
        ),
        statusStmt.bind(
          row.surface_id,
          row.surface_key,
          row.netuid,
          row.kind,
          row.url,
          row.provider,
          row.status,
          row.classification,
          row.latency_ms,
          row.status_code,
          row.checked_at_ms,
          row.last_ok_ms,
          row.consecutive_failures,
          runAt,
        ),
      );
    }
    return await runD1StatementBatches(db, statements);
  } catch (error) {
    // A failed history write must never take the probe sweep (or its KV serve
    // path) down with it -- log and report, exactly as the pre-flip code did.
    // With Postgres gone these writes are the only durable copy of a probe,
    // so the failure also lands in the $exception inbox, not just the logs.
    console.error("[persistProbesToD1]", String((error as Error)?.message));
    await recordExceptionEvent(env, {
      error,
      route: "observations-d1-persist",
    });
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * The failure-REASON rollup (#9622): aggregate a UTC day's raw checks into one
 * row per (day, netuid, kind, classification).
 *
 * The sibling rollup above keeps how OFTEN a surface failed and throws away
 * WHY: `surface_uptime_daily` carries samples, ok_count, uptime_ratio and the
 * latency tail, and no classification at all. Once pruneHealthHistory deletes
 * the raw window at 30 days, the reason is gone and nothing downstream can
 * reconstruct it -- which is what this table exists to stop.
 *
 * `live` rows are rolled up too, not just the failures. A failure mix without
 * its denominator is a count rather than a rate, and a reader forced to fetch
 * the total from somewhere else would be free to pair it with a different
 * window.
 *
 * The ON CONFLICT target is the EXPRESSION `ifnull(netuid, -1)`, matching
 * 0025's unique index: netuid is nullable for registry-level surfaces, SQLite
 * treats NULLs as distinct in a unique constraint, and a plain column key would
 * therefore append a new row for those surfaces on every hourly tick instead of
 * updating the one it wrote last time.
 */
export async function rollupFailureReasonsToD1(
  db: ObservationsDb | undefined,
  days: { date: string; start: number; end: number }[],
  runAt: number,
  env?: Env | null,
): Promise<{ rolled: boolean; error?: string }> {
  if (!db?.prepare) return { rolled: false };
  try {
    const stmt = db.prepare(
      `INSERT INTO surface_failure_daily
         (day, netuid, kind, classification, checks, updated_at)
       SELECT ? AS day, netuid, kind, classification, COUNT(*) AS checks,
              ? AS updated_at
         FROM surface_checks
        WHERE checked_at >= ? AND checked_at < ?
          AND kind IS NOT NULL
          AND classification IS NOT NULL
        GROUP BY netuid, kind, classification
       ON CONFLICT(day, ifnull(netuid, -1), kind, classification) DO UPDATE SET
         checks = excluded.checks,
         updated_at = excluded.updated_at`,
    );
    await db.batch(
      days.map(({ date, start, end }) => stmt.bind(date, runAt, start, end)),
    );
    return { rolled: true };
  } catch (error) {
    // Same posture as the uptime rollup: a silent failure here freezes the
    // reason series while the uptime series keeps advancing, which reads as
    // "no failures had a reason" rather than as a broken lane.
    const message = String((error as Error)?.message ?? error);
    console.error("[rollupFailureReasonsToD1]", message);
    await recordExceptionEvent(env, {
      error,
      route: "observations-d1-failure-rollup",
    });
    return { rolled: false, error: message };
  }
}

// The day rollup, verbatim from the pre-flip implementation: aggregate the raw
// checks for a UTC day into one row per (surface, day), with the exact
// clamped-ratio and status semantics the daily series has always had, and the
// p50/p95/p99 tail computed by health-sql.ts's rank CTE (percentiles cannot be
// rebuilt from a mean after the raw prune).
export async function rollupUptimeDailyToD1(
  db: ObservationsDb | undefined,
  days: { date: string; start: number; end: number }[],
  runAt: number,
  env?: Env | null,
): Promise<{ rolled: boolean; error?: string }> {
  if (!db?.prepare) return { rolled: false };
  const conflictColumns = `
       surface_id = excluded.surface_id,
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
  try {
    const stmt = db.prepare(
      `${rankedChecksCte("checked_at >= ? AND checked_at < ?")}
     INSERT INTO surface_uptime_daily
       (surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio,
        latency_samples, avg_latency_ms, p50_latency_ms, p95_latency_ms,
        p99_latency_ms, status, updated_at)
     SELECT
       MAX(surface_id) AS surface_id,
       surface_key,
       netuid,
       ? AS day,
       COUNT(*) AS samples,
       SUM(ok) AS ok_count,
       CASE
         WHEN SUM(ok) = COUNT(*) THEN 1.0
         WHEN ROUND(CAST(SUM(ok) AS REAL) / COUNT(*), 4) >= 1.0 THEN 0.9999
         ELSE ROUND(CAST(SUM(ok) AS REAL) / COUNT(*), 4)
       END AS uptime_ratio,
       ${latencyStatColumns({ roundedAvg: true, includeMinMax: false })},
       CASE
         WHEN SUM(ok) = COUNT(*) THEN 'ok'
         WHEN SUM(ok) = 0 THEN 'failed'
         ELSE 'degraded'
       END AS status,
       ? AS updated_at
     FROM ranked
     GROUP BY surface_key, netuid
     ON CONFLICT(surface_key, day) WHERE surface_key IS NOT NULL DO UPDATE SET${conflictColumns}
     ON CONFLICT(surface_id, day) DO UPDATE SET${conflictColumns}`,
    );
    await db.batch(
      days.map(({ date, start, end }) => stmt.bind(start, end, date, runAt)),
    );
    return { rolled: true };
  } catch (error) {
    // Not swallowed silently: a failing rollup freezes the daily series
    // invisibly, so the hourly cron's result must stay diagnosable.
    const message = String((error as Error)?.message ?? error);
    console.error("[rollupUptimeDailyToD1]", message);
    await recordExceptionEvent(env, { error, route: "observations-d1-rollup" });
    return { rolled: false, error: message };
  }
}

// The raw-window prune. Runs ONLY after the day rollup reported success --
// the caller owns that ordering, as it always has (raw rows must never be
// deleted without being aggregated first).
export async function pruneChecksD1(
  db: ObservationsDb | undefined,
  cutoff: number,
  env?: Env | null,
): Promise<{ pruned: boolean }> {
  if (!db?.prepare) return { pruned: false };
  try {
    await db.batch([
      db
        .prepare(`DELETE FROM surface_checks WHERE checked_at < ?`)
        .bind(cutoff),
    ]);
    return { pruned: true };
  } catch (error) {
    console.error("[pruneChecksD1]", String((error as Error)?.message));
    await recordExceptionEvent(env, { error, route: "observations-d1-prune" });
    return { pruned: false };
  }
}

// One row per (netuid, day): the completeness/economics trajectory upsert,
// carrying the full post-retirement column set (v440 pipeline inputs + #8744
// provenance). Booleans land as 0/1 against the schema's CHECKs.
export async function upsertSubnetSnapshotsToD1(
  db: ObservationsDb | undefined,
  rows: Row[],
  env?: Env | null,
): Promise<{ ok: boolean; reason?: string; batches?: number }> {
  if (!db?.prepare) return { ok: false, reason: "unavailable" };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: "no_rows" };
  }
  const toBit = (value: unknown) => (value == null ? null : value ? 1 : 0);
  try {
    const stmt = db.prepare(
      `INSERT INTO subnet_snapshots
       (netuid, snapshot_date, completeness_score, surface_count, endpoint_count,
        monitored_count, candidate_count, captured_at, validator_count, miner_count,
        total_stake_tao, alpha_price_tao, emission_share, tao_in_pool_tao,
        alpha_in_pool, alpha_out_pool, subnet_volume_tao, tao_in_emission_tao,
        excess_tao, alpha_in_emission, alpha_out_emission, miner_burned_fraction,
        emission_enabled, subtoken_enabled, first_emission_block,
        pipeline_block, pipeline_block_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(netuid, snapshot_date) DO UPDATE SET
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
    );
    const statements = rows.map((row) =>
      stmt.bind(
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
        toBit(row.emission_enabled),
        toBit(row.subtoken_enabled),
        row.first_emission_block ?? null,
        row.pipeline_block ?? null,
        row.pipeline_block_hash ?? null,
      ),
    );
    return await runD1StatementBatches(db, statements);
  } catch (error) {
    console.error(
      "[upsertSubnetSnapshotsToD1]",
      String((error as Error)?.message),
    );
    await recordExceptionEvent(env, {
      error,
      route: "observations-d1-snapshots",
    });
    return { ok: false, reason: "write_failed" };
  }
}
