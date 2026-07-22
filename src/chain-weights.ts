// Network-wide validator weight-setting activity from the account_events WeightsSet stream: a
// per-subnet leaderboard + network rollup + intensity distribution over a window. The account_events
// kind-filtered sibling of chain-transfers / chain-stake-flow. Pure shaping + a thin D1 loader; the
// Worker adds the envelope. See the schema/contracts for the full response contract.

// The account_events kind emitted when a validator sets weights on a subnet.
export const WEIGHTS_EVENT_KIND = "WeightsSet";

export const CHAIN_WEIGHTS_LIMIT_DEFAULT = 20;
export const CHAIN_WEIGHTS_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's analytics
// window set (7d/30d, default 7d). Kept next to the loader so the MCP tool's input
// schema and runtime validation cannot drift from the endpoint.
export const CHAIN_WEIGHTS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_WEIGHTS_WINDOW = "7d";

// Round an updates-per-validator ratio to a stable precision (2dp). Always finite and
// non-negative here (events / distinct setters, with the divisor guarded below).
function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed row must be skipped,
// never counted as netuid 0.
function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the
// envelope's generated_at, the same way account-events does.
function coerceEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A finite but out-of-range epoch (|ms| > 8.64e15, the JS Date limit) makes
  // toIso's new Date(n).toISOString() throw a RangeError, which would 500 this
  // endpoint on a single corrupt observed_at cell. Drop it to null, mirroring the
  // getTime() range guard chain-stake-flow.ts added in #3016.
  return Number.isFinite(new Date(n).getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Average WeightsSet events per distinct validator — the subnet's update intensity. A subnet
// with no setters has no defined intensity (null) rather than a divide-by-zero.
function setsPerSetter(sets: number, setters: number): number | null {
  if (setters <= 0) return null;
  return round(sets / setters);
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (deterministic, no
// interpolation). Only called from intensityDistribution, which short-circuits an empty set to
// null before reaching here.
function percentile(ascending: number[], p: number): number {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Conventional median of a NON-EMPTY ascending numeric array: the middle value for an odd count,
// the mean of the two middle values for an even count (so an even count returns the average of the
// two middles, not the lower-middle a nearest-rank p50 gives). The averaging form needs no odd/even
// branch — for an odd count the two indices coincide and it returns that middle value unchanged.
// Matches median() in chain-yield.ts / subnet-yield.ts so a `median` field is the same statistic
// across the API. Reached only after intensityDistribution's empty short-circuit.
function median(ascending: number[]): number {
  const mid = (ascending.length - 1) / 2;
  return round((ascending[Math.floor(mid)] + ascending[Math.ceil(mid)]) / 2);
}

export interface IntensityDistribution {
  count: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

// Spread of the per-subnet update intensity (WeightsSet events per validator) across every subnet
// that set weights in the window: count, mean, and min / p25 / median / p75 / p90 / max. Null when no subnet set
// weights.
function intensityDistribution(values: number[]): IntensityDistribution | null {
  /* v8 ignore next -- defensive: only called with one value per subnet, and the builder returns
     the empty block (distribution null) before this runs when there are no subnets */
  if (values.length === 0) return null;
  const ascending = [...values].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: round(sum / ascending.length),
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: median(ascending),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[ascending.length - 1],
  };
}

export interface ChainWeightsNetwork {
  distinct_setters: number;
  weight_sets: number;
  sets_per_setter: number | null;
}

const EMPTY_NETWORK: ChainWeightsNetwork = {
  distinct_setters: 0,
  weight_sets: 0,
  sets_per_setter: null,
};

export interface ChainWeightsSubnet {
  netuid: number;
  distinct_setters: number;
  weight_sets: number;
  sets_per_setter: number;
}

export interface ChainWeightsResult {
  schema_version: 1;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainWeightsNetwork;
  intensity_distribution: IntensityDistribution | null;
  subnets: ChainWeightsSubnet[];
}

// Shape the network-wide weight-setting scorecard from the per-subnet account_events aggregate.
// `subnetRows` carries one row per netuid (COUNT(*) weight_sets, distinct setter count).
// WeightsSet ingestion can omit hotkey, so the SQL loader falls back to netuid/uid identities
// rather than dropping real activity. `networkDistinct` carries the best available network-wide
// distinct setter count plus the newest observed_at. `limit` caps the leaderboard;
// subnet_count and the distribution span every subnet with observed weight-setting activity
// (subnets with no WeightsSet events in the window are absent). Null-safe: no rows yields the
// empty block.
export function buildChainWeights(
  subnetRows: Array<Record<string, unknown>> | null | undefined,
  {
    window,
    limit = CHAIN_WEIGHTS_LIMIT_DEFAULT,
    networkDistinct,
  }: {
    window?: string | null;
    limit?: number;
    networkDistinct?: { distinct_setters?: unknown; newest_observed?: unknown };
  } = {},
): ChainWeightsResult {
  const list = Array.isArray(subnetRows) ? subnetRows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_WEIGHTS_LIMIT_MAX))
    : CHAIN_WEIGHTS_LIMIT_DEFAULT;
  const observedAt = toIso(networkDistinct?.newest_observed);

  const empty: ChainWeightsResult = {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    subnet_count: 0,
    network: { ...EMPTY_NETWORK },
    intensity_distribution: null,
    subnets: [],
  };
  if (list.length === 0) return empty;

  // Merge by netuid so a malformed direct caller passing duplicate rows for a subnet sums rather
  // than double-counting (the SQL loader GROUPs BY netuid, so production rows are unique per
  // subnet; this keeps the pure builder correct outside that path).
  const perNetuid = new Map<number, { setters: number; sets: number }>();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const setters = toCount(row?.distinct_setters);
    if (setters === 0) continue; // no validators set weights: not a consensus surface
    const bucket = perNetuid.get(netuid) ?? { setters: 0, sets: 0 };
    bucket.setters += setters;
    bucket.sets += toCount(row?.weight_sets);
    perNetuid.set(netuid, bucket);
  }
  if (perNetuid.size === 0) return empty;

  const subnets: ChainWeightsSubnet[] = [];
  let totalSets = 0;
  for (const [netuid, bucket] of perNetuid) {
    subnets.push({
      netuid,
      distinct_setters: bucket.setters,
      weight_sets: bucket.sets,
      // setsPerSetter only returns null when setters <= 0, and every bucket here has setters > 0
      // (the `setters === 0` guard above skips it before it's ever created).
      sets_per_setter: setsPerSetter(bucket.sets, bucket.setters) as number,
    });
    totalSets += bucket.sets;
  }
  // Most actively-maintained subnets first (by total WeightsSet events), tie-broken by netuid.
  subnets.sort((a, b) => b.weight_sets - a.weight_sets || a.netuid - b.netuid);

  const networkSetters = toCount(networkDistinct?.distinct_setters);
  const network: ChainWeightsNetwork = {
    distinct_setters: networkSetters,
    weight_sets: totalSets,
    sets_per_setter: setsPerSetter(totalSets, networkSetters),
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet update intensity over EVERY subnet (not just the returned page),
    // so the spread is network-wide even when `limit` truncates the leaderboard.
    intensity_distribution: intensityDistribution(
      subnets.map((subnet) => subnet.sets_per_setter),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// #4772 D1 retirement: loadChainWeights (the D1 loader that read the account_events
// WeightsSet stream) was removed here -- that D1 write path is retired and the
// `account_events` table is dropped in production, so a live D1 query would always
// miss. Serving now goes tryPostgresTier -> buildChainWeights([...], { networkDistinct:
// null }), never D1. See src/graphql.mjs's chain_weights and src/mcp-server.mjs's
// get_chain_weights tool for the call sites.
