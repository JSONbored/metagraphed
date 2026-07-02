// Shared D1 SQL for operational-health latency + uptime aggregation.
//
// One definition of "latency is a success-only signal": every latency aggregate
// counts only healthy probes that recorded a latency (`ok = 1 AND latency_ms IS
// NOT NULL`), while uptime counts every probe. Reused by the daily rollup, the
// trends route, and the percentiles route so the mean, its p50/p95/p99 tail, and
// its sample count stay consistent — and pre-fix raw rows (a stray 0/elapsed
// latency on a failure) are corrected on read, not only on the next write.

// A probe whose latency counts toward latency statistics.
export const OK_LATENCY = "ok = 1 AND latency_ms IS NOT NULL";

// CTE over `surface_checks` that ranks each stable surface's ok-latency rows by
// latency (`rn`) and counts them (`lat_cnt`), passing all rows through so uptime
// still totals over every check. The grp term in the PARTITION isolates
// ok-latency rows, so `rn` ranks among them alone. `whereSql`'s `?` binds lead.
export function rankedChecksCte(whereSql) {
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
      SUM(CASE WHEN ${OK_LATENCY} THEN 1 ELSE 0 END) OVER (
        PARTITION BY COALESCE(surface_key, surface_id), netuid
      ) AS lat_cnt
    FROM surface_checks
    WHERE ${whereSql}
  )`;
}

// SELECT columns over `ranked`: sample count, mean, optional min/max, and the
// p50/p95/p99 order statistics (SQLite has no PERCENTILE_CONT, so they are picked
// from `rn`). `roundedAvg` casts the mean to INTEGER for the rollup's column; the
// rollup table has no min/max, so it drops them via `includeMinMax: false`.
export function latencyStatColumns({
  roundedAvg = false,
  includeMinMax = true,
} = {}) {
  const avg = `AVG(CASE WHEN ${OK_LATENCY} THEN latency_ms END)`;
  // Nearest-rank order statistic: the value at 1-based ordinal position
  // ceil(q * N) among the N ok-latency rows. `CAST(x AS INTEGER)` truncates
  // toward zero (= floor for the non-negative q*N), so add 1 only when there is
  // a fractional part — that is ceil. The previous `floor(q*N) + 1` overshot by
  // one whenever q*N was an integer (e.g. N=100 → p50/p95/p99 picked ranks
  // 51/96/100 instead of 50/95/99).
  const pick = (q, name) => {
    const pos = `${q} * lat_cnt`;
    return `MAX(CASE WHEN rn = CAST(${pos} AS INTEGER) + (${pos} > CAST(${pos} AS INTEGER)) THEN latency_ms END) AS ${name}`;
  };
  const columns = [
    `MAX(lat_cnt) AS latency_samples`,
    `${roundedAvg ? `CAST(ROUND(${avg}) AS INTEGER)` : avg} AS avg_latency_ms`,
  ];
  if (includeMinMax) {
    columns.push(
      `MIN(CASE WHEN ${OK_LATENCY} THEN latency_ms END) AS min_latency_ms`,
      `MAX(CASE WHEN ${OK_LATENCY} THEN latency_ms END) AS max_latency_ms`,
    );
  }
  columns.push(pick(0.5, "p50"), pick(0.95, "p95"), pick(0.99, "p99"));
  return columns.join(",\n            ");
}

// SELECT columns that re-aggregate stored `surface_uptime_daily` rows: the
// healthy-reading count and the latency mean weighted by it. Legacy rows predate
// the latency_samples column, so weighting falls back to total samples.
// `roundedAvg` casts to INTEGER for stored/long-term views; the bulk matrix keeps
// the raw quotient and rounds in the formatter. The weighted-sum numerator is
// cast to REAL so the division is floating-point — both `avg_latency_ms` and the
// sample counts are INTEGER columns, so a plain `SUM(int)/SUM(int)` would be
// SQLite integer division and truncate the mean before it is rounded.
export function dailyLatencyColumns({ roundedAvg = false } = {}) {
  const weight = `CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END`;
  const denom = `SUM(${weight})`;
  const mean = `CAST(SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN avg_latency_ms * COALESCE(latency_samples, samples) ELSE 0 END) AS REAL) / ${denom}`;
  return `${denom} AS latency_samples,
            CASE WHEN ${denom} > 0
              THEN ${roundedAvg ? `CAST(ROUND(${mean}) AS INTEGER)` : mean}
              ELSE NULL
            END AS avg_latency_ms`;
}
