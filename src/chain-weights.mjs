// Network-wide validator weight-setting activity from the account_events WeightsSet stream: a
// per-subnet leaderboard + network rollup + intensity distribution over a window. The account_events
// kind-filtered sibling of chain-transfers / chain-stake-flow. Pure shaping + a thin D1 loader; the
// Worker adds the envelope. See the schema/contracts for the full response contract.

const DAY_MS = 24 * 60 * 60 * 1000;

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
function round(value, dp = 2) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed row must be skipped,
// never counted as netuid 0.
function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the
// envelope's generated_at, the same way account-events does.
function coerceEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Average WeightsSet events per distinct validator — the subnet's update intensity. A subnet
// with no setters has no defined intensity (null) rather than a divide-by-zero.
function setsPerSetter(sets, setters) {
  if (setters <= 0) return null;
  return round(sets / setters);
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (deterministic, no
// interpolation). Only called from intensityDistribution, which short-circuits an empty set to
// null before reaching here.
function percentile(ascending, p) {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Conventional median of a NON-EMPTY ascending numeric array: the middle value for an odd count,
// the mean of the two middle values for an even count (so an even count returns the average of the
// two middles, not the lower-middle a nearest-rank p50 gives). The averaging form needs no odd/even
// branch — for an odd count the two indices coincide and it returns that middle value unchanged.
// Matches median() in chain-yield.mjs / subnet-yield.mjs so a `median` field is the same statistic
// across the API. Reached only after intensityDistribution's empty short-circuit.
function median(ascending) {
  const mid = (ascending.length - 1) / 2;
  return round((ascending[Math.floor(mid)] + ascending[Math.ceil(mid)]) / 2);
}

// Spread of the per-subnet update intensity (WeightsSet events per validator) across every subnet
// that set weights in the window: count, mean, and min / p25 / median / p75 / p90 / max. Null when no subnet set
// weights.
function intensityDistribution(values) {
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

const EMPTY_NETWORK = {
  distinct_setters: 0,
  weight_sets: 0,
  sets_per_setter: null,
};

// Shape the network-wide weight-setting scorecard from the per-subnet account_events aggregate.
// `subnetRows` carries one row per netuid (COUNT(*) weight_sets, distinct setter count).
// WeightsSet ingestion can omit hotkey, so the SQL loader falls back to netuid/uid identities
// rather than dropping real activity. `networkDistinct` carries the best available network-wide
// distinct setter count plus the newest observed_at. `limit` caps the leaderboard;
// subnet_count and the distribution span every subnet with observed weight-setting activity
// (subnets with no WeightsSet events in the window are absent). Null-safe: no rows yields the
// empty block.
export function buildChainWeights(
  subnetRows,
  { window, limit = CHAIN_WEIGHTS_LIMIT_DEFAULT, networkDistinct } = {},
) {
  const list = Array.isArray(subnetRows) ? subnetRows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_WEIGHTS_LIMIT_MAX))
    : CHAIN_WEIGHTS_LIMIT_DEFAULT;
  const observedAt = toIso(networkDistinct?.newest_observed);

  const empty = {
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
  const perNetuid = new Map();
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

  const subnets = [];
  let totalSets = 0;
  for (const [netuid, bucket] of perNetuid) {
    subnets.push({
      netuid,
      distinct_setters: bucket.setters,
      weight_sets: bucket.sets,
      sets_per_setter: setsPerSetter(bucket.sets, bucket.setters),
    });
    totalSets += bucket.sets;
  }
  // Most actively-maintained subnets first (by total WeightsSet events), tie-broken by netuid.
  subnets.sort((a, b) => b.weight_sets - a.weight_sets || a.netuid - b.netuid);

  const networkSetters = toCount(networkDistinct?.distinct_setters);
  const network = {
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

// Network-wide weight-setting activity, computed live: read the account_events WeightsSet stream
// over the window (observed_at >= now - windowDays, epoch ms), first as a single network aggregate
// (best available distinct setters + newest observed_at, covered by
// idx_account_events(event_kind, observed_at) from migration 0032) and then grouped by netuid for
// the per-subnet leaderboard (served by
// idx_account_events(netuid, event_kind, block_number) from migration 0024), and shape with
// buildChainWeights. The
// newest-observed probe doubles as the cold-store guard: a null MAX(observed_at) skips the
// per-subnet read. The handler resolves windowLabel/windowDays from analyticsWindow (7d/30d).
// Cold/absent store -> the schema-stable empty block.
export async function loadChainWeights(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const setterIdentity =
    "CASE " +
    "WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey " +
    "WHEN uid IS NOT NULL AND netuid IS NOT NULL THEN 'uid:' || netuid || ':' || uid " +
    "ELSE NULL END";
  const networkRows = await d1(
    "SELECT COUNT(*) AS weight_sets, COUNT(DISTINCT " +
      setterIdentity +
      ") AS distinct_setters, MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ?",
    [WEIGHTS_EVENT_KIND, cutoff],
  );
  const networkDistinct = networkRows?.[0] ?? null;
  let subnetRows = [];
  if (networkDistinct?.newest_observed != null) {
    subnetRows = await d1(
      "SELECT netuid, COUNT(*) AS weight_sets, COUNT(DISTINCT " +
        setterIdentity +
        ") AS distinct_setters " +
        "FROM account_events WHERE event_kind = ? AND observed_at >= ? GROUP BY netuid",
      [WEIGHTS_EVENT_KIND, cutoff],
    );
  }
  return buildChainWeights(subnetRows, {
    window: windowLabel,
    limit,
    networkDistinct,
  });
}
