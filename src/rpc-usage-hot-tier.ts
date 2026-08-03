// RPC reverse-proxy usage analytics, served from Workers Analytics Engine.
//
// The live half of the pair src/rpc-usage-cold-tier.ts is the frozen half of.
// Both feed the SAME formatter (`formatRpcUsage`) -- that is the contract, not
// an implementation detail: /api/v1/rpc/usage has one published shape and it
// does not change with whichever store answered.
//
// ===========================================================================
// PERCENTILES: THE TWO TIERS DELIBERATELY DIFFER, AND SAY SO.
// ===========================================================================
//
// The cold tier reports p50/p95 as null because R2 SQL has no percentile
// function -- `approx_percentile` is rejected outright (measured 2026-08-03)
// -- and computing them in JS would need every latency in the window. Its
// null is "we did not measure this", which is true of it.
//
// AE does have weighted quantiles, so THIS tier reports real, measured
// p50/p95, sampling-corrected via `_sample_interval`. That is a product
// improvement, and it is also the one place the two tiers are not
// interchangeable, so it is stated rather than left to be discovered:
//
//   * A window the hot tier answers carries real percentiles.
//   * A window only the cold tier can answer carries null percentiles --
//     still never a number synthesised from an average, which is the thing
//     #9228 explicitly refuses.
//
// NULL THEREFORE STAYS UNAMBIGUOUS, which is why this does not need a new
// payload field to disambiguate it. `p50: null` means "not measured" in both
// tiers and in every case: the hot tier only answers a window it has events
// for, and every one of those events carries a wall-clock latency, so it can
// never answer with a null percentile over real traffic. A caller reading a
// number is reading a measurement; a caller reading null is being told the
// measurement does not exist. Adding a source marker would have renegotiated
// a published response schema to restate what null already says.
//
// Every other field means the same thing in both tiers.
//
// SAMPLING. AE stores a subset of data points at volume and exposes the rate
// as `_sample_interval`. Every aggregate below therefore goes through the
// sampling-aware builders in src/analytics-engine-sql.ts; a raw COUNT(*) here
// would silently undercount once traffic grows enough to trigger sampling,
// and would agree with the corrected form right up until it did.
import { ANALYTICS_WINDOWS, RPC_USAGE_BUCKETS } from "../workers/config.ts";
import { formatRpcUsage } from "./health-serving.ts";
import {
  analyticsSqlQuery,
  isAnalyticsSqlConfigured,
  sampledMean,
  sampledCount,
  sampledCountIf,
  sampledSum,
  weightedQuantile,
  type AnalyticsSqlDeps,
} from "./analytics-engine-sql.ts";
import {
  RPC_USAGE_BLOBS,
  RPC_USAGE_DATASET,
  RPC_USAGE_DOUBLES,
} from "./rpc-usage-capture.ts";

type Row = Record<string, unknown>;

/** The `coverage.segments[].source` label for this store. Exported so the
 * composer and its tests name the tier the same way the payload does. */
export const HOT_TIER_SOURCE = "analytics-engine";

const B = RPC_USAGE_BLOBS;
const D = RPC_USAGE_DOUBLES;

/** The bucket width as an AE INTERVAL. RPC_USAGE_BUCKETS is declared in ms
 * (1h for 7d, 6h for 30d) and AE's toStartOfInterval takes a unit, so the two
 * representations are reconciled here rather than at the call site. Null for
 * a width that is not a whole number of hours -- there is no INTERVAL that
 * expresses it, and rounding would silently bucket the series wrongly. */
export function bucketInterval(bucketMs: number): string | null {
  const hours = bucketMs / 3_600_000;
  if (!Number.isInteger(hours) || hours <= 0) return null;
  return `INTERVAL '${hours}' HOUR`;
}

/**
 * Everything one window needs inlined into SQL, or null when the config
 * cannot express it.
 *
 * Both values reach the query as LITERALS -- AE has no bound parameters, the
 * same hazard R2 SQL has -- so `days` is forced through `Number.isInteger`
 * and the bucket width through `bucketInterval`. Neither comes from caller
 * input today; these guards are what keep a future refactor from making
 * either one an injection point.
 *
 * `bucketOverride` is a test seam, not a feature: every configured window is
 * a whole number of hours, so the rejection arm has no other way to be
 * exercised, and an arm nothing verifies is an arm that stops working
 * quietly.
 */
export function hotWindowBounds(
  window: string,
  bucketOverride?: number,
): { days: number; interval: string; granularity: string } | null {
  const days = (ANALYTICS_WINDOWS as Record<string, number>)[window];
  const bucket = (
    RPC_USAGE_BUCKETS as Record<
      string,
      { granularity: string; bucketMs: number }
    >
  )[window];
  if (!Number.isInteger(days) || days <= 0 || !bucket) return null;
  const interval = bucketInterval(bucketOverride ?? bucket.bucketMs);
  if (!interval) return null;
  return { days, interval, granularity: bucket.granularity };
}

/** '' is the writer's "no endpoint" sentinel; the lakehouse tier's equivalent
 * group carries a real NULL. Mapped back so the two tiers serve the same
 * endpoint rows for the same traffic. */
function orNull(value: unknown): unknown {
  return value === "" || value === undefined ? null : value;
}

/**
 * Turn a rollup's sampled latency SUM into the mean this route publishes.
 *
 * `latency_sum` is an artefact of AE having no way to guard a division, not a
 * field the payload has ever carried, so it is dropped rather than passed
 * through -- a query column must not become a published one by accident.
 */
function withMeanLatency(row: Row, count: unknown): Row {
  const { latency_sum: latencySum, ...rest } = row;
  return { ...rest, avg_latency_ms: sampledMean(latencySum, count) };
}

/** AE returns `toUnixTimestamp` in SECONDS; every timestamp in this route's
 * published payload is epoch MILLISECONDS (the lakehouse tier's `observed_at`
 * and bucket `ts` both are). Converted here, once. */
function secondsToMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) * 1000 : null;
}

/**
 * Serve one usage window from Analytics Engine, or null to let the caller
 * fall through to the lakehouse cold tier.
 *
 * Null on ANY miss -- no token provisioned, a failed query, an unknown
 * window, or an empty window -- rather than a partial answer, the same
 * decline contract the cold tier uses. "No token provisioned" is the state
 * this ships in: until the secret exists the route keeps answering exactly
 * as it does today, from the lakehouse.
 */
export async function loadRpcUsageHotTier(
  env: Env | null | undefined,
  {
    window = "7d",
    // Injectable so every arm -- each rollup's SQL, each decline path -- is
    // testable without a live dataset, the same seam the cold tier uses.
    query = analyticsSqlQuery,
    deps,
    // Same test seam hotWindowBounds documents: every configured window is a
    // whole number of hours, so the "the config cannot express this window"
    // decline has no other way to be exercised -- and a decline arm nothing
    // verifies is one that stops working quietly.
    bucketMs,
  }: {
    window?: string;
    query?: typeof analyticsSqlQuery;
    deps?: AnalyticsSqlDeps;
    bucketMs?: number;
  } = {},
): Promise<Row | null> {
  if (!isAnalyticsSqlConfigured(env)) return null;
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const bounds = hotWindowBounds(windowLabel, bucketMs);
  if (!bounds) return null;

  // The public proxy only. The gated fullnode gate writes into the same
  // dataset (its own `pool` value) so it finally has usage telemetry, but
  // /api/v1/rpc/usage is the PUBLIC pool's endpoint distribution and has
  // been since B3 -- folding an isolated, separately-scored pool into it
  // would silently redefine a published route's meaning. ADR 0021's
  // isolation requirement is a data-modelling constraint here, not just a
  // routing one.
  const where =
    `WHERE ${B.pool} = 'public'` +
    ` AND timestamp > now() - INTERVAL '${bounds.days}' DAY`;

  const [totalsRows, endpointRows, networkRows, bucketRows] = await Promise.all(
    [
      query(
        env,
        `SELECT ${sampledCount()} AS total,` +
          ` ${sampledSum(D.ok)} AS ok_count,` +
          ` ${sampledCountIf(`${D.attempts} > 1`)} AS failover_count,` +
          ` ${sampledCountIf(`${B.cache} = 'hit'`)} AS cache_hits,` +
          ` ${sampledSum(D.latencyMs)} AS latency_sum,` +
          // The measured percentiles -- see the header. Weighted by
          // _sample_interval so they describe the underlying events, not the
          // stored sample.
          ` ${weightedQuantile(0.5, D.latencyMs)} AS p50,` +
          ` ${weightedQuantile(0.95, D.latencyMs)} AS p95,` +
          // BOTH ends of the measured span, not just the newest. AE's
          // retention starts at deploy, so the oldest event it holds is
          // usually LATER than the window's own cutoff -- that difference is
          // exactly what the payload's `coverage` has to publish, and what
          // src/rpc-usage-answer.ts partitions the lakehouse read on so the
          // two stores can be summed without double-counting.
          ` toUnixTimestamp(min(timestamp)) AS observed_from_s,` +
          ` toUnixTimestamp(max(timestamp)) AS observed_at_s` +
          ` FROM ${RPC_USAGE_DATASET} ${where}`,
        deps,
      ),
      query(
        env,
        `SELECT ${B.endpointId} AS endpoint_id, ${B.provider} AS provider,` +
          ` ${B.network} AS network, ${sampledCount()} AS requests,` +
          ` ${sampledSum(D.ok)} AS ok_count,` +
          ` ${sampledSum(D.latencyMs)} AS latency_sum` +
          ` FROM ${RPC_USAGE_DATASET} ${where}` +
          ` GROUP BY ${B.endpointId}, ${B.provider}, ${B.network}` +
          ` ORDER BY requests DESC LIMIT 100`,
        deps,
      ),
      query(
        env,
        `SELECT ${B.network} AS network, ${sampledCount()} AS requests,` +
          ` ${sampledSum(D.ok)} AS ok_count,` +
          ` ${sampledSum(D.latencyMs)} AS latency_sum` +
          ` FROM ${RPC_USAGE_DATASET} ${where}` +
          ` GROUP BY ${B.network} ORDER BY requests DESC LIMIT 100`,
        deps,
      ),
      query(
        env,
        `SELECT toUnixTimestamp(toStartOfInterval(timestamp, ${bounds.interval}))` +
          ` AS ts, ${sampledCount()} AS requests,` +
          ` ${sampledSum(D.ok)} AS ok_count,` +
          ` ${sampledSum(D.latencyMs)} AS latency_sum` +
          ` FROM ${RPC_USAGE_DATASET} ${where}` +
          ` GROUP BY ts ORDER BY ts ASC LIMIT 1000`,
        deps,
      ),
    ],
  );

  if (!totalsRows || !endpointRows || !networkRows || !bucketRows) return null;

  const totals = totalsRows[0];
  // An untouched window. Declining lets the lakehouse answer the windows it
  // still covers rather than publishing a zeroed rollup that reads as
  // measured silence.
  if (!totals || !Number(totals.total)) return null;

  const observedFrom = secondsToMs(totals.observed_from_s);
  const observedAt = secondsToMs(totals.observed_at_s);

  return formatRpcUsage({
    window: windowLabel,
    observedAt,
    // What this tier actually measured, and the sub-range its percentiles
    // describe -- the same span here, because AE is the only store that has
    // percentiles at all.
    coverage: {
      segments: [
        { source: HOT_TIER_SOURCE, start: observedFrom, end: observedAt },
      ],
      latency: { start: observedFrom, end: observedAt },
    },
    // Each rollup selects the sampled latency SUM and the sampled request
    // count; the mean is taken here because AE cannot express the empty-window
    // guard (see sampledMean). `total`/`requests` is the same denominator the
    // rollup already reports, so the published mean and the published count
    // can never disagree about how many events they describe.
    totals: withMeanLatency(totals, totals.total),
    // The one field the cold tier cannot supply. Passing it here is what
    // makes p50/p95 real numbers instead of nulls.
    latency: { p50: totals.p50, p95: totals.p95 },
    endpointRows: endpointRows.map((row) => ({
      ...withMeanLatency(row, row.requests),
      endpoint_id: orNull(row.endpoint_id),
      provider: orNull(row.provider),
    })),
    networkRows: networkRows.map((row) => withMeanLatency(row, row.requests)),
    bucketRows: bucketRows.map((row) => ({
      ...withMeanLatency(row, row.requests),
      ts: secondsToMs(row.ts),
      // endpoints/networks derive their own error_rate inside the formatter;
      // only the bucket mapping reads a literal `errors`. Clamped so a
      // malformed rollup cannot publish a negative error count.
      errors: Math.max(
        0,
        Number(row.requests ?? 0) - Number(row.ok_count ?? 0),
      ),
    })),
    bucketGranularity: bounds.granularity,
  });
}
