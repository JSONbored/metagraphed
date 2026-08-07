// The ONE composer for /api/v1/rpc/usage. REST, MCP and GraphQL all call
// `answerRpcUsage` and do no tier work of their own.
//
// WHY A COMPOSER AND NOT THREE CASCADES. Three surfaces each assembling the
// same card is how this route ended up serving two different answers at the
// same instant: REST reported 118,309 requests on its top endpoint while
// GraphQL's `rpc_usage(window:"7d")` reported `total_requests: 0` and an empty
// endpoint list, because #9207 wired the lakehouse tier into the REST handler
// only and the siblings still went `tryPostgresTier -> loadRpcUsage` into the
// zeroed floor (#9269). That is the second time the same shape of bug landed
// on this codebase (#9263 was the accounts version), and it recurs for a
// structural reason, not a careless one: a cascade that lives at the call site
// has to be remembered at every call site. Here there is one cascade, in one
// file, and the surfaces cannot disagree because they no longer each decide.
// Same shape, same reasoning, as src/account-summary-card.ts's
// `answerAccountSummary` (#9285) -- deliberately, so the pattern reads as one
// pattern rather than two solutions to one problem.
//
// WHY THE TWO STORES ARE SUMMED. Analytics Engine (hot) and the lakehouse
// (cold) hold DISJOINT time ranges: the lakehouse froze permanently when the
// box died, and AE only holds what it has captured since deploy. Letting the
// hot tier displace the cold one made `window=7d` report 3,990 requests over
// two hours where the seven days actually served 578,506 -- a 99.3%
// under-report with nothing in the payload to contradict the `7d` label
// (#9293). "Until capture catches up" never arrives for the history itself;
// the older days are simply absent from the number.
//
// So counts are SUMMED across the two disjoint ranges -- total/ok/error/
// failover/cache_hits, and the per-endpoint, per-network and per-bucket series
// with them -- and `coverage` publishes the span each store actually
// contributed, including the hole between them that no store covers.
//
// PERCENTILES ARE NOT SUMMED, because they are not additive.
// `quantileExactWeighted` cannot be merged with a store that has no percentile
// function at all, and reporting AE's p50 as the whole window's p50 would be a
// claim about a sub-range. They stay AE-only and `coverage.latency_percentiles`
// says which sub-range they describe. Null still means "not measured".
//
// WHEN THE LAKEHOUSE IS READ AT ALL. Only when the hot tier does not already
// cover the requested window back to its cutoff. That is what keeps this from
// becoming a permanent second scan: once AE's retention spans the window (7d
// from 2026-08-10, 30d from 2026-09-02) the cold read stops being issued and
// never resumes. The transitional cost is one sequential lakehouse read on an
// uncached request -- the cold query must know where the hot store starts
// before it can be bounded, so the two cannot be issued in parallel without
// risking a double count.
import { ANALYTICS_WINDOWS } from "../workers/config.ts";
import { tryPostgresTier } from "../workers/postgres-tier.ts";
import {
  epochMs,
  formatRpcUsage,
  type RpcUsageSegment,
} from "./health-serving.ts";
import { loadRpcUsage } from "./rpc-usage-loader.ts";
import { loadRpcUsageColdTier, windowCutoffMs } from "./rpc-usage-cold-tier.ts";
import { loadRpcUsageHotTier } from "./rpc-usage-hot-tier.ts";

type Row = Record<string, unknown>;

/** The env flag that still gates the (retired) Postgres tier for this route.
 * Kept as a named export so the surfaces cannot drift onto a different flag. */
export const RPC_USAGE_SOURCE_FLAG = "METAGRAPH_RPC_USAGE_SOURCE" as const;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A running weighted mean. Both stores publish an AVERAGE latency and a
 * request count, and the average of two averages is not the average -- so the
 * counts are the weights. A part with no measured average contributes nothing
 * to either side rather than dragging the result toward zero. */
function meanAccumulator() {
  let sum = 0;
  let weight = 0;
  return {
    add(avg: unknown, count: unknown): void {
      const a = Number(avg);
      const c = Number(count);
      if (!Number.isFinite(a) || !Number.isFinite(c) || c <= 0) return;
      sum += a * c;
      weight += c;
    },
    value(): number | null {
      return weight > 0 ? sum / weight : null;
    },
  };
}

interface Aggregate {
  requests: number;
  ok: number;
  errors: number;
  latency: ReturnType<typeof meanAccumulator>;
  row: Row;
}

/** Fold rows from both stores onto one key, summing the counts and weighting
 * the latency mean. `key` is what "the same thing" means for that series: an
 * endpoint identity, a network name, a bucket timestamp. */
function foldRows(
  parts: Row[][],
  key: (row: Row) => string,
  errorsOf: (row: Row) => number,
): Aggregate[] {
  const merged = new Map<string, Aggregate>();
  for (const rows of parts) {
    for (const row of rows) {
      const id = key(row);
      let entry = merged.get(id);
      if (!entry) {
        entry = {
          requests: 0,
          ok: 0,
          errors: 0,
          latency: meanAccumulator(),
          row,
        };
        merged.set(id, entry);
      }
      entry.requests += num(row.requests);
      entry.ok += num(row.ok_requests);
      entry.errors += errorsOf(row);
      entry.latency.add(row.avg_latency_ms, num(row.requests));
    }
  }
  return [...merged.values()];
}

/** Both tiers cap each breakdown at 100 rows in SQL; the merged list is capped
 * the same way so a merged answer cannot publish a longer list than either
 * store would have on its own. */
const BREAKDOWN_LIMIT = 100;
/** Same reasoning for the time series, matching both tiers' `LIMIT 1000`. */
const BUCKET_LIMIT = 1000;

function segmentsOf(payload: Row): RpcUsageSegment[] {
  return (payload.coverage as Row).segments as RpcUsageSegment[];
}

/** The oldest event a payload reports having measured, or null when it does
 * not report one. This is the partition point: the lakehouse read is bounded
 * strictly below it so the two stores cannot describe the same event twice. */
export function coverageStart(payload: Row | null | undefined): number | null {
  if (!payload) return null;
  const start = Number((payload.coverage as Row | undefined)?.start);
  return Number.isFinite(start) && start > 0 ? Math.trunc(start) : null;
}

/**
 * Sum two disjoint answers into one.
 *
 * BOTH arguments are `formatRpcUsage` output -- that is the precondition, and
 * it is what lets this read the payload's fields directly instead of
 * re-guarding each one. `summary`, `summary.latency_ms`, `coverage`,
 * `endpoints`, `networks` and `buckets` are unconditionally present in that
 * shape, and a defensive `?? []` on a field that is always there is an
 * untested branch wearing the costume of safety.
 *
 * `cold` is the older range, `hot` the newer -- and `hot` is the only source
 * of percentiles, which is why the argument order is not symmetric even though
 * every count in here is.
 */
export function mergeRpcUsage(cold: Row, hot: Row): Row {
  const coldSummary = cold.summary as Row;
  const hotSummary = hot.summary as Row;
  const hotLatency = hotSummary.latency_ms as Row;

  const avg = meanAccumulator();
  avg.add((coldSummary.latency_ms as Row).avg, coldSummary.total_requests);
  avg.add(hotLatency.avg, hotSummary.total_requests);

  const endpointRows = foldRows(
    [cold.endpoints as Row[], hot.endpoints as Row[]],
    // An endpoint is the same endpoint across both stores when its id AND its
    // provider match. Both are nullable -- the "no endpoint" group is a real
    // NULL in the lakehouse and the "" sentinel in Analytics Engine, mapped
    // back to NULL -- and the NUL separator keeps a provider named like a
    // suffix of an id from colliding with a different pair.
    (row) =>
      `${String(row.endpoint_id ?? "")}\u0000${String(row.provider ?? "")}`,
    (row) => Math.max(0, num(row.requests) - num(row.ok_requests)),
  )
    .sort((a, b) => b.requests - a.requests)
    .slice(0, BREAKDOWN_LIMIT)
    .map((entry) => ({
      endpoint_id: entry.row.endpoint_id,
      provider: entry.row.provider,
      requests: entry.requests,
      ok_count: entry.ok,
      avg_latency_ms: entry.latency.value(),
    }));

  const networkRows = foldRows(
    [cold.networks as Row[], hot.networks as Row[]],
    // `network` is passed through untouched by the formatter, so an
    // unlabelled group from either engine reaches here as undefined.
    (row) => String(row.network ?? ""),
    (row) => Math.max(0, num(row.requests) - num(row.ok_requests)),
  )
    .sort((a, b) => b.requests - a.requests)
    .slice(0, BREAKDOWN_LIMIT)
    .map((entry) => ({
      network: entry.row.network,
      requests: entry.requests,
      ok_count: entry.ok,
      avg_latency_ms: entry.latency.value(),
    }));

  // The buckets are time-keyed at the same granularity in both stores (both
  // align to epoch), so they concatenate cleanly -- folding on `ts` anyway is
  // what makes that a property of the code rather than of the current data.
  const bucketRows = foldRows(
    [cold.buckets as Row[], hot.buckets as Row[]],
    (row) => String(row.ts),
    // Buckets publish a literal error count rather than an ok count.
    (row) => num(row.errors),
  )
    .sort((a, b) => num(a.row.ts) - num(b.row.ts))
    .slice(0, BUCKET_LIMIT)
    .map((entry) => ({
      ts: entry.row.ts,
      requests: entry.requests,
      errors: entry.errors,
      avg_latency_ms: entry.latency.value(),
    }));

  const observedAt = Math.max(num(cold.observed_at), num(hot.observed_at));

  return formatRpcUsage({
    window: hot.window,
    observedAt: observedAt > 0 ? observedAt : null,
    bucketGranularity: hot.bucket_granularity,
    totals: {
      total: num(coldSummary.total_requests) + num(hotSummary.total_requests),
      ok_count: num(coldSummary.ok_requests) + num(hotSummary.ok_requests),
      failover_count:
        num(coldSummary.failover_requests) + num(hotSummary.failover_requests),
      cache_hits: num(coldSummary.cache_hits) + num(hotSummary.cache_hits),
      avg_latency_ms: avg.value(),
    },
    // AE-only, and scoped below to the range it actually describes.
    latency: { p50: hotLatency.p50, p95: hotLatency.p95 },
    endpointRows,
    networkRows,
    bucketRows,
    coverage: {
      segments: [...segmentsOf(cold), ...segmentsOf(hot)],
      latency: (hot.coverage as Row).latency_percentiles as {
        start?: unknown;
        end?: unknown;
      } | null,
    },
  });
}

/**
 * True when the hot tier already answers the whole requested window, so the
 * lakehouse has nothing to add.
 *
 * The tolerance is one bucket width, not zero: AE's own predicate is
 * `timestamp > now() - N DAY`, so its oldest event is always at least a moment
 * after the cutoff, and an exact comparison would keep issuing a lakehouse
 * read forever. One bucket is the resolution this route publishes anyway.
 */
export function hotTierCoversWindow(
  hot: Row | null,
  window: string,
  now: number,
): boolean {
  const start = coverageStart(hot);
  if (start === null) return false;
  const bounds = windowCutoffMs(window, now);
  if (!bounds) return false;
  return start - bounds.cutoff <= bounds.bucketMs;
}

export interface AnswerRpcUsageOptions {
  window?: string;
  /** `observed_at` for the zeroed floor -- the health cron's last run, the
   * only freshness reading available when no store answered. */
  observedAt?: unknown;
  /** The request to forward to the (retired) Postgres tier, or null to skip
   * it. Supplied per surface because each builds its own upstream request;
   * the ORDER it is tried in belongs here, not at the call site. */
  postgresRequest?: Request | null;
  now?: number;
  // Seams, so every arm of the cascade -- and the merge itself -- is testable
  // without Analytics Engine, a lakehouse, or a DATA_API binding.
  hotTier?: typeof loadRpcUsageHotTier;
  coldTier?: typeof loadRpcUsageColdTier;
  postgresTier?: typeof tryPostgresTier;
  floor?: typeof loadRpcUsage;
}

/**
 * Answer one /api/v1/rpc/usage window, whatever it takes.
 *
 * Never null and never throws: the zeroed floor is the last resort, and it is
 * only correct when NO store had anything to say -- which is exactly what
 * #9269 got wrong by reaching it while two live stores held the data.
 */
export async function answerRpcUsage(
  env: Env,
  {
    window = "7d",
    observedAt = null,
    postgresRequest = null,
    now = Date.now(),
    hotTier = loadRpcUsageHotTier,
    coldTier = loadRpcUsageColdTier,
    postgresTier = tryPostgresTier,
    floor = loadRpcUsage,
  }: AnswerRpcUsageOptions = {},
): Promise<Row> {
  const label = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";

  const hot = await hotTier(env, { window: label });

  // The lakehouse is read only for the part of the window the hot tier does
  // not already hold, and only while such a part exists at all.
  const cold = hotTierCoversWindow(hot, label, now)
    ? null
    : await coldTier(
        env as unknown as Parameters<typeof loadRpcUsageColdTier>[0],
        { window: label, now, until: coverageStart(hot) },
      );

  if (hot && cold) return mergeRpcUsage(cold, hot);
  if (hot) return hot;

  // Only reached when Analytics Engine had nothing. The Postgres tier stays
  // ahead of the lakehouse here purely to preserve the order this route has
  // always used; METAGRAPH_RPC_USAGE_SOURCE is "retired" in every deployed
  // config, so it declines without a subrequest and the flag remains what it
  // has always been -- a kill switch, not a live tier.
  if (postgresRequest) {
    const postgres = (await postgresTier(
      env,
      postgresRequest,
      RPC_USAGE_SOURCE_FLAG,
    )) as Row | null;
    // Normalised on the way out rather than trusted (#9794/#9811). This arm
    // forwards an upstream payload verbatim instead of going through
    // formatRpcUsage, so it is the one path that can publish a stamp this
    // composer never shaped. The whole defect being fixed here was `observed_at`
    // meaning different things depending on which tier answered, and a tier
    // whose representation is taken on faith is how that happens -- so the
    // composer states the type for every arm, including the ones it forwards.
    if (postgres) {
      return { ...postgres, observed_at: epochMs(postgres.observed_at) };
    }
  }

  if (cold) return cold;

  return floor({ window: label, observedAt });
}
