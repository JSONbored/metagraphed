// RPC reverse-proxy usage capture, on Workers Analytics Engine (#9228).
//
// This is the writer that stopped existing. D1's `rpc_proxy_events` went with
// the chain-data retirement, the Postgres mirror went with the box, and the
// lakehouse is a read tier nothing appends to -- so the only writer left was
// a per-request POST to an internal route that has answered 503
// unconditionally since #9193. The proxy paid a subrequest per call to write
// nothing, and 578,682 frozen lakehouse rows kept /api/v1/rpc/usage looking
// healthy the whole time.
//
// WHY ANALYTICS ENGINE RATHER THAN A TABLE. `writeDataPoint` is non-blocking
// by design: it hands the point to the runtime and returns, so the "telemetry
// must never add latency to a proxied call" constraint is satisfied
// STRUCTURALLY rather than by our own ctx.waitUntil discipline. There is no
// promise to defer, no batch to flush, and no failure to swallow at the call
// site. It also keeps request telemetry out of D1, which holds product data.
//
// RETENTION IS THE PLATFORM'S. AE stores data points for three months and
// expires them itself, so this lane has NO prune cron and nothing to size a
// retention window against. The largest window the route serves is 30 days,
// comfortably inside that.
//
// ===========================================================================
// THE POSITIONAL SCHEMA -- read this before changing anything below.
// ===========================================================================
//
// AE rows have no column names. A dataset is blob1..blob20, double1..double20,
// index1, timestamp and _sample_interval, and the mapping from meaning to
// slot exists ONLY here. That mapping is effectively an unmigratable schema:
// old data points keep whatever a slot meant when they were written, and
// there is no ALTER to fix them. So:
//
//   * APPEND ONLY. A new dimension takes the next free slot. Never re-purpose
//     an occupied one -- a reader cannot tell an old meaning from a new one,
//     and the result is two different quantities averaged together.
//   * If a slot's meaning genuinely must change, the dataset name has to
//     change with it (a versioned dataset), because the old points cannot be
//     rewritten.
//   * The reader (src/rpc-usage-hot-tier.ts) imports these constants rather
//     than retyping "blob3", so the query and the write cannot drift.
//
// Limits this layout respects: 20 blobs, 20 doubles and exactly 1 index per
// data point; all blobs together <=16 KB; the index <=96 bytes; <=250 data
// points per Worker invocation (this writes exactly one per proxied request).

/** Dataset name -- must match the `dataset` in wrangler.jsonc's
 * analytics_engine_datasets binding, and is the table name in every query.
 * Deliberately the name the retired D1/Postgres table had: this is the same
 * measurement, restored, and a reader who greps the old name should land
 * here. */
export const RPC_USAGE_DATASET = "rpc_proxy_events";

/** Slot -> meaning. The reader imports these; nothing quotes "blob3" twice. */
export const RPC_USAGE_BLOBS = {
  /** "public" | "fullnode" -- WHICH PROXY. The two pools are deliberately
   * isolated (ADR 0021): the gated fullnode gate has its own origins, its
   * own circuit breaker, and must never influence the public pool's health
   * or its published endpoint distribution. Capturing both into one dataset
   * with this discriminator means the fullnode gate finally has usage
   * telemetry of its own, while /api/v1/rpc/usage keeps meaning exactly what
   * it meant before by filtering to "public". Merging them without this
   * would have silently redefined a published route. */
  pool: "blob1",
  /** "finney" | "test" for the public proxy (the /rpc/v1/{network} path
   * segment); "fullnode" for the gated gate, which is not network-scoped. */
  network: "blob2",
  /** Pool endpoint that served. "" when none did -- a cache hit, or no
   * eligible endpoint at all. Empty string rather than a missing slot so the
   * GROUP BY always has a value to bucket. */
  endpointId: "blob3",
  /** The served endpoint's provider label; "" when there is no endpoint. */
  provider: "blob4",
  /** "hit" | "miss" | "bypass" -- the response-cache disposition. */
  cache: "blob5",
} as const;

export const RPC_USAGE_DOUBLES = {
  /** 1 when the proxy reached a responding upstream (or served from cache),
   * 0 otherwise. A double rather than a blob so `SUM(_sample_interval * ...)`
   * gives the ok count directly. */
  ok: "double1",
  /** Upstream attempts. >1 means a failover happened. Kept as the real count
   * rather than a boolean so failover DEPTH stays queryable -- the thing the
   * old rollup design would have thrown away. */
  attempts: "double2",
  /** End-to-end proxy latency in ms. This is the column the weighted
   * quantiles run over, and the reason this tier can report a real p50/p95
   * where the lakehouse tier cannot. */
  latencyMs: "double3",
  /** HTTP status returned to the caller. Not surfaced by formatRpcUsage
   * today; captured because a status distribution is the first thing anyone
   * investigating an error-rate spike will want, and a slot not written now
   * is a slot that can never be backfilled. */
  status: "double4",
} as const;

/** AE allows exactly one index, and it is the SAMPLING key: the engine
 * samples per index value, so a value that appears rarely keeps its
 * resolution instead of being drowned out by a busy neighbour. That is worth
 * more here than anywhere else -- the measured 30-day window had 118,326
 * requests on the busiest group and 22 on each testnet endpoint, and a single
 * global index would sample the testnet endpoints away first, breaking
 * exactly the "is the load balancer actually balancing" question this route
 * exists to answer. So the index is the full grouping key. */
export const RPC_USAGE_INDEX_SEPARATOR = "/";

export interface RpcUsageEvent {
  /** Which proxy produced this. */
  pool: "public" | "fullnode";
  network: string;
  endpointId: string | null;
  provider: string | null;
  ok: boolean;
  status: number;
  attempts: number;
  latencyMs: number;
  cache: "hit" | "miss" | "bypass";
}

/** The AE binding surface this module uses -- deliberately narrow, so a test
 * double is the two lines it should be. */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

const MAX_INDEX_BYTES = 96;

/**
 * Truncate to AE's 96-BYTE index ceiling, not 96 characters.
 *
 * Endpoint ids and provider labels are ours and ASCII by construction, so in
 * practice this never fires. It is here because the failure it prevents is
 * silent: an over-long index makes AE reject the data point, which looks
 * exactly like "the proxy stopped receiving traffic" from the reading end --
 * the same indistinguishable-from-healthy failure this whole issue is about.
 */
export function truncateIndex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= MAX_INDEX_BYTES) return value;
  // Cut on a character boundary: decoding a byte slice that splits a
  // multi-byte sequence yields U+FFFD, which would be a different index value
  // for two inputs that should share one.
  let end = MAX_INDEX_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The sampling key: pool, network and endpoint, joined. */
export function usageIndex(event: RpcUsageEvent): string {
  return truncateIndex(
    [event.pool, event.network, event.endpointId || "none"].join(
      RPC_USAGE_INDEX_SEPARATOR,
    ),
  );
}

/**
 * One proxied request as an AE data point, in the declared slot order.
 *
 * Exported so tests can assert the layout positionally -- the schema is the
 * ORDER of these arrays, and an assertion on a named object would not catch
 * two fields being swapped.
 */
export function usageDataPoint(event: RpcUsageEvent): {
  blobs: string[];
  doubles: number[];
  indexes: string[];
} {
  const latency = Number(event.latencyMs);
  return {
    blobs: [
      event.pool,
      typeof event.network === "string" ? event.network : "",
      event.endpointId ?? "",
      event.provider ?? "",
      event.cache,
    ],
    doubles: [
      event.ok ? 1 : 0,
      finiteOrZero(event.attempts),
      // A negative or non-finite reading is impossible from a wall-clock
      // delta, but zero is the honest floor if one ever appears: a NaN here
      // would poison every average and quantile in the window, and unlike a
      // row in a table there is no way to delete it afterwards.
      Number.isFinite(latency) && latency > 0 ? latency : 0,
      finiteOrZero(event.status),
    ],
    indexes: [usageIndex(event)],
  };
}

function finiteOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Record one proxied request. Never throws, never blocks.
 *
 * `writeDataPoint` is synchronous and non-blocking -- there is no promise to
 * await and nothing for ctx.waitUntil to hold -- so the only way this could
 * reach the request path is by throwing, which the try/catch closes. A
 * missing binding (local dev, CI, a self-hoster) is a no-op: the proxy
 * degrades to "no analytics", never to "broken".
 */
export function recordRpcUsageEvent(
  dataset: AnalyticsEngineDatasetLike | undefined | null,
  event: RpcUsageEvent,
): boolean {
  if (typeof dataset?.writeDataPoint !== "function") return false;
  try {
    dataset.writeDataPoint(usageDataPoint(event));
    return true;
  } catch {
    // Telemetry must never surface into the request path. Deliberately silent
    // rather than reported: this runs once per proxied request, so a
    // persistent fault would turn the error channel into the firehose it is
    // meant to protect. The staleness watchdog is what notices a writer that
    // has stopped -- see src/rpc-usage-staleness-watchdog.ts.
    return false;
  }
}
