// Shared SQL for operational-health latency + uptime aggregation, on EITHER
// store.
//
// One definition of "latency is a success-only signal": every latency aggregate
// counts only healthy probes that recorded a latency (`ok` true AND `latency_ms
// IS NOT NULL`), while uptime counts every probe. Reused by the daily rollup,
// the trends route, and the percentiles route so the mean, its p50/p95/p99 tail,
// and its sample count stay consistent — and pre-fix raw rows (a stray
// 0/elapsed latency on a failure) are corrected on read, not only on the next
// write.
//
// ## Why the comparison against 1 is gone (#10086)
//
// `surface_checks.ok` is INTEGER in D1 and BOOLEAN in Neon. That is a TYPING
// difference, not a dialect one, so it survives every `?`->`$n` rewrite and
// every portability review that reads for syntax: `ok = 1` parses fine on both
// and only Postgres rejects it, at runtime, with `operator does not exist:
// boolean = integer`. The same shape cost the hotkey_alpha mirror twelve hours
// (#10000) one table over.
//
// A BARE `ok` is portable in both directions. Postgres takes it as the boolean
// it is; SQLite has no boolean type and treats the stored 1/0 as truthy/falsy,
// which is exactly what `ok = 1` meant. Same for `NOT ok` against `ok = 0`, and
// `CASE WHEN ok THEN 1 ELSE 0 END` against `SUM(ok)` -- the last one matters
// most, because summing a boolean is not merely wrong in Postgres, it has no
// meaning at all and the whole statement throws.
//
// Verified against BOTH production stores rather than reasoned about: the
// portable spellings return identical counts over the same 1,385,857 rows.

// A probe whose latency counts toward latency statistics.
export const OK_LATENCY = "ok AND latency_ms IS NOT NULL";

/** `SUM(ok)` is a type error in Postgres -- a boolean has no sum. This counts
 * the same thing on both stores. */
export const OK_COUNT = "SUM(CASE WHEN ok THEN 1 ELSE 0 END)";

// `surface_status` stores textual status; latency averages over it must mirror
// OK_LATENCY semantics (failures/timeouts can still carry elapsed-time latencies).
export const SURFACE_STATUS_OK_LATENCY =
  "status = 'ok' AND latency_ms IS NOT NULL";

// Mean latency over `surface_status` rows, success-only. `rounded: true` wraps
// the AVG in ROUND() for compare-style integer output.
export function surfaceStatusAvgLatencySql({
  rounded = false,
}: { rounded?: boolean } = {}): string {
  const avg = `AVG(CASE WHEN ${SURFACE_STATUS_OK_LATENCY} THEN latency_ms END)`;
  return rounded ? `ROUND(${avg})` : avg;
}

// CTE over `surface_checks` that ranks each stable surface's ok-latency rows by
// latency (`rn`) and counts them (`lat_cnt`), passing all rows through so uptime
// still totals over every check. The grp term in the PARTITION isolates
// ok-latency rows, so `rn` ranks among them alone. `whereSql`'s `?` binds lead.
export function rankedChecksCte(whereSql: string): string {
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
}: { roundedAvg?: boolean; includeMinMax?: boolean } = {}): string {
  const avg = `AVG(CASE WHEN ${OK_LATENCY} THEN latency_ms END)`;
  // Nearest-rank order statistic: the value at 1-based ordinal position
  // ceil(q * N) among the N ok-latency rows. `CAST(x AS INTEGER)` truncates
  // toward zero (= floor for the non-negative q*N), so add 1 only when there is
  // a fractional part — that is ceil. The previous `floor(q*N) + 1` overshot by
  // one whenever q*N was an integer (e.g. N=100 → p50/p95/p99 picked ranks
  // 51/96/100 instead of 50/95/99).
  const pick = (q: number, name: string): string => {
    // CEIL, not trunc-plus-carry. The carry form was written for SQLite, which
    // had no ceil, and it does not survive Postgres -- twice over. `CAST(x AS
    // INTEGER)` TRUNCATES in SQLite and ROUNDS in Postgres, and `(a > b)` is a
    // boolean Postgres will not add to an integer.
    //
    // The second half errors, which is how this was found: every serving read
    // of surface_checks threw `operator does not exist: integer + boolean`,
    // d1All degraded the failure to zero rows, and /uptime, /health/percentiles
    // and the per-subnet /health/trends each published an empty card over a
    // table with rows in it (#10200).
    //
    // The FIRST half would not have errored. On its own the rounding CAST
    // returns a confidently wrong percentile -- which is the more dangerous
    // half, and the reason this is one expression rather than a patch to the
    // comparison.
    //
    // Both engines have had ceil since SQLite 3.35, and it is what the carry
    // form was always spelling. src/observations-neon.ts made the same move for
    // the rollup path and verified the two agree at lat_cnt = 1, 3, 7, 20 and
    // 100 for all three quantiles.
    return `MAX(CASE WHEN rn = CAST(CEIL(${q} * lat_cnt) AS INTEGER) THEN latency_ms END) AS ${name}`;
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
export function dailyLatencyColumns({
  roundedAvg = false,
}: { roundedAvg?: boolean } = {}): string {
  const weight = `CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END`;
  const denom = `SUM(${weight})`;
  const mean = `CAST(SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN avg_latency_ms * COALESCE(latency_samples, samples) ELSE 0 END) AS REAL) / ${denom}`;
  return `${denom} AS latency_samples,
            CASE WHEN ${denom} > 0
              THEN ${roundedAvg ? `CAST(ROUND(${mean}) AS INTEGER)` : mean}
              ELSE NULL
            END AS avg_latency_ms`;
}
