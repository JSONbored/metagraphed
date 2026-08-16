// Chain-prometheus served from a SCHEDULED PROJECTION artifact (#11419).
//
// ## Why this route needed a lane, when twelve siblings already had one
//
// `/chain/prometheus` is a network-wide aggregate over a 7d/30d window of
// `account_events`, recomputed on every request. `src/projection-lanes.ts`'s
// own header calls that "the hot-path misuse" R2 SQL's module warns against,
// and twelve chain-wide aggregates already moved behind a cron for exactly this
// reason. This one, its axon-serving twin, and the two weights routes did not.
//
// ## What the measurement said, and what it did NOT say
//
// The engine's own metrics (#11436) price the read at 2.6 MiB and 284 R2
// requests for a 7d window -- not a large scan. The problem is not the bytes:
// interleaved sampling of ONE query against ONE subject spanned 2.00s to
// 31.61s, a 15.8x spread wider than the difference between the query shapes
// being compared, with `cache_hits` at ~99.6% of requests. Request-time reads
// against that engine are unpredictable by construction, and
// `QUERY_TIMEOUT_MS` turns the tail into a decline.
//
// So this is not a query that can be tuned faster -- the tuning candidates were
// measured and one of them was SLOWER. It is a read that should not happen
// under a request at all. A cron pays the variance once per interval; a caller
// then pays one R2 GET.
//
// This route ALSO carries `PROMETHEUS_DEGRADED_NOT_CURATED` permanently: the
// chain emits `PrometheusServed` and our `account_events` curation drops it, so
// the card is empty whatever tier answers. Serving an empty from a cron instead
// of from a 15-second timeout does not make it less empty -- it makes it
// honest about WHY, which is the marker's job and not this lane's.
//
// The RESPONSE SHAPE is unchanged: the lane stores the same network DISTINCT
// row and per-subnet aggregate the cold tier computes, and this reader hands
// them to the SAME `buildChainPrometheus` formatter, which owns ranking, the
// network rollup, the intensity distribution and the limit slice.

import {
  buildChainPrometheus,
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
} from "./chain-prometheus.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "./route-limits.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  projectionKey,
} from "./chain-network.ts";

export const CHAIN_PROMETHEUS_PROJECTION_KEY =
  "metagraph/projections/chain-prometheus.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * The projected chain-prometheus card for one window, or null when the artifact
 * store cannot answer FAITHFULLY (unbound, missing object, unrecognized body,
 * a window the lane did not precompute) so the caller falls to its next tier.
 * Decline, never approximate.
 */
export async function loadChainPrometheusFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainPrometheus> | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(
      projectionKey(CHAIN_PROMETHEUS_PROJECTION_KEY, network),
    );
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a guess
    // -- same contract as its twelve siblings.
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    const label = query.window ?? DEFAULT_ANALYTICS_WINDOW;
    // A window outside the route's set -- or one this artifact does not carry
    // -- must never be answered with a DIFFERENT window's numbers.
    if (!Object.hasOwn(ANALYTICS_WINDOW_DAYS, label)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      network?: unknown;
      rows?: unknown;
    } | null;
    if (!Array.isArray(win?.rows)) return null;
    const chainWide = win.network ?? null;
    if (chainWide !== null && typeof chainWide !== "object") return null;
    // NO `subnetCount` PASSED, and that is correct here rather than an
    // omission: the lane stores EVERY per-subnet row, so the builder's own
    // `subnets.length` is the true population. #10249's defect was the
    // opposite case -- a loader that capped in SQL and left the builder
    // counting a page under a field named for a population.
    return buildChainPrometheus(win.rows as Record<string, unknown>[], {
      window: label,
      limit: query.limit ?? CHAIN_PROMETHEUS_LIMIT_DEFAULT,
      networkDistinct:
        (chainWide as Record<string, unknown> | null) ?? undefined,
    });
  } catch {
    return null;
  }
}
