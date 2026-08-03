// RPC reverse-proxy usage analytics, served from the lakehouse.
//
// `rpc_proxy_events` was Postgres-only, so with the box gone
// /api/v1/rpc/usage served a schema-stable empty payload -- honest, but
// useless when 578,682 verified rows of it sit in the lakehouse. This tier
// serves them through the SAME formatter the Postgres tier fed
// (`formatRpcUsage`), so a caller cannot tell which tier answered.
//
// FOUR AGGREGATES, NOT ONE SCAN. R2 SQL is a second-scale engine with no
// indexes, and this table is the largest thing any request-time reader here
// touches. Each rollup is its own GROUP BY over the same windowed predicate
// rather than one wide scan re-aggregated in JS: the engine reads the column
// projection it needs per query, and a JS re-aggregation of 578k rows would
// not fit a request either way.
//
// PERCENTILES ARE DECLINED, NOT SYNTHESIZED. The Postgres route reported
// latency p50/p95. R2 SQL has no percentile function -- `approx_percentile`
// is rejected outright (measured 2026-08-03) -- and computing them in JS
// needs every latency in the window, 578,507 rows for 7d, which is not a
// request-time read. So `latency` is left undefined and the formatter
// reports p50/p95 as null: "we did not measure this", which is true.
// Deriving them from the average would put a number there that no percentile
// of the data supports, and a caller cannot tell a made-up p95 from a real
// one.
//
// THE TABLE IS FROZEN, and the window is still honest about it. The proxy
// that wrote these rows died with the box, so the newest row is fixed at the
// export. A 7d window still covers real traffic today and will cover
// progressively less until it covers none -- at which point this returns the
// same empty payload it replaced, without ever having claimed the traffic
// was current. `observed_at` in the response is the data's own newest
// reading, so freshness stays visible rather than implied.
import { ANALYTICS_WINDOWS, RPC_USAGE_BUCKETS } from "../workers/config.ts";
import { formatRpcUsage } from "./health-serving.ts";
import { r2SqlQuery } from "./r2-sql.ts";

type Row = Record<string, unknown>;

/** The `coverage.segments[].source` label for this store. Exported so the
 * composer and its tests name the tier the same way the payload does. */
export const COLD_TIER_SOURCE = "lakehouse";

/** `ok` is a real boolean in the lakehouse; the Postgres tier counted it with
 * a filtered aggregate. R2 SQL rejects `count_if`, so the portable CASE form
 * is used -- same arithmetic, and measured to work. */
const OK_COUNT = "sum(CASE WHEN ok THEN 1 ELSE 0 END)";

/**
 * Window cutoff as an epoch-ms integer literal.
 *
 * R2 SQL has NO bound parameters, so every value is interpolated. This one is
 * computed here from a clock and a config constant -- never from caller input
 * -- and is still forced through `Number.isSafeInteger` so a future refactor
 * that lets a caller influence the window cannot turn it into an injection
 * point.
 */
export function windowCutoffMs(
  window: string,
  now: number,
): { cutoff: number; bucketMs: number; granularity: string } | null {
  const days = (ANALYTICS_WINDOWS as Record<string, number>)[window];
  const bucket = (
    RPC_USAGE_BUCKETS as Record<
      string,
      { granularity: string; bucketMs: number }
    >
  )[window];
  if (typeof days !== "number" || !bucket) return null;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) return null;
  return { cutoff, bucketMs: bucket.bucketMs, granularity: bucket.granularity };
}

/**
 * Serve one usage window from the lakehouse, or null to let the caller keep
 * its existing empty payload.
 *
 * Null on ANY miss -- unconfigured lakehouse, a failed query, an unknown
 * window -- rather than a partial answer. A rollup that silently lost its
 * endpoint breakdown would read as "no endpoints served traffic", which is a
 * different and wrong claim.
 */
export async function loadRpcUsageColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  {
    window = "7d",
    now = Date.now(),
    // Exclusive upper bound, epoch ms. src/rpc-usage-answer.ts sets it to the
    // OLDEST event the hot tier holds so the two stores describe strictly
    // disjoint ranges and their counts can be summed -- without it a merge
    // would double-count any overlap, and "counts are additive" would stop
    // being true the moment the two stores share a second. Undefined keeps
    // the whole window, which is what a lakehouse-only answer wants.
    until,
    // Injectable so every rollup's SQL and every decline path is testable
    // without a lakehouse -- the same seam r2-sql.ts's scheduleAbort uses. A
    // branch that only runs against live infrastructure is a branch nothing
    // verifies.
    query = r2SqlQuery,
  }: {
    window?: string;
    now?: number;
    until?: number | null;
    query?: typeof r2SqlQuery;
  } = {},
): Promise<Record<string, unknown> | null> {
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const bounds = windowCutoffMs(windowLabel, now);
  if (!bounds) return null;
  const { cutoff, bucketMs, granularity } = bounds;
  // Same no-bound-parameters rule the cutoff obeys: the ceiling is a literal,
  // so it is forced through Number.isSafeInteger rather than trusted. A
  // non-integer ceiling is dropped (the window's own cutoff still applies)
  // instead of being interpolated.
  const ceiling =
    typeof until === "number" && Number.isSafeInteger(until) && until > 0
      ? until
      : null;
  const where =
    `WHERE observed_at >= ${cutoff}` +
    (ceiling === null ? "" : ` AND observed_at < ${ceiling}`);

  const [totalsRows, endpointRows, networkRows, bucketRows] = await Promise.all(
    [
      query(
        env,
        `SELECT count(*) AS total, ${OK_COUNT} AS ok_count,` +
          ` sum(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS failover_count,` +
          ` sum(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END) AS cache_hits,` +
          ` avg(latency_ms) AS avg_latency_ms,` +
          // Both ends of the measured span. The newest reading has always been
          // published as `observed_at`; the oldest is what `coverage` needs so
          // a merged answer can say where the lakehouse's half of it stops and
          // the gap before Analytics Engine begins starts.
          ` min(observed_at) AS observed_from,` +
          ` max(observed_at) AS observed_at` +
          ` FROM chain.rpc_proxy_events ${where}`,
      ),
      query(
        env,
        `SELECT endpoint_id, provider, network, count(*) AS requests,` +
          ` ${OK_COUNT} AS ok_count, avg(latency_ms) AS avg_latency_ms` +
          ` FROM chain.rpc_proxy_events ${where}` +
          ` GROUP BY endpoint_id, provider, network ORDER BY requests DESC LIMIT 100`,
      ),
      query(
        env,
        `SELECT network, count(*) AS requests, ${OK_COUNT} AS ok_count,` +
          ` avg(latency_ms) AS avg_latency_ms` +
          ` FROM chain.rpc_proxy_events ${where}` +
          ` GROUP BY network ORDER BY requests DESC LIMIT 100`,
      ),
      query(
        env,
        `SELECT observed_at - (observed_at % ${bucketMs}) AS ts,` +
          ` count(*) AS requests, ${OK_COUNT} AS ok_count,` +
          ` avg(latency_ms) AS avg_latency_ms` +
          ` FROM chain.rpc_proxy_events ${where}` +
          ` GROUP BY observed_at - (observed_at % ${bucketMs}) ORDER BY ts ASC LIMIT 1000`,
      ),
    ],
  );

  if (!totalsRows || !endpointRows || !networkRows || !bucketRows) return null;

  const totals = totalsRows[0];
  // A window the frozen table no longer reaches. Declining lets the caller's
  // existing empty payload stand rather than publishing a zeroed rollup that
  // looks like measured silence.
  if (!totals || Number(totals.total) === 0) return null;

  return formatRpcUsage({
    window: windowLabel,
    observedAt: totals.observed_at ?? null,
    totals,
    // Deliberately absent -- see the header. Not a TODO.
    latency: undefined,
    // What this tier measured. `latency` is omitted for the same reason
    // p50/p95 are: there is no percentile here to scope.
    coverage: {
      segments: [
        {
          source: COLD_TIER_SOURCE,
          start: totals.observed_from ?? null,
          end: totals.observed_at ?? null,
        },
      ],
    },
    // endpoints/networks derive their own error_rate from requests - ok
    // inside the formatter; only the bucket mapping reads a literal `errors`,
    // so it is the only one that needs deriving here.
    endpointRows,
    networkRows,
    bucketRows: withErrors(bucketRows),
    bucketGranularity: granularity,
  });
}

/** The bucket mapping reads a literal `errors`; the engine gives requests and
 * ok_count. Clamped at zero so a malformed rollup cannot publish a negative
 * error count. */
function withErrors(rows: Row[]): Row[] {
  return rows.map((row) => ({
    ...row,
    errors: Math.max(0, Number(row.requests ?? 0) - Number(row.ok_count ?? 0)),
  }));
}
