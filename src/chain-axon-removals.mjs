// Live network-wide axon-removal activity from the account_events AxonInfoRemoved stream: a
// per-subnet leaderboard plus a network rollup and intensity distribution. Pure shaping
// (buildChainAxonRemovals) + a thin D1 loader (loadChainAxonRemovals); the field semantics live in
// schemas/components/05-subnets.schema.json (ChainAxonRemovalsArtifact). The teardown-side companion
// to the axon-announcement /chain/serving: AxonInfoRemoved is emitted when a neuron's announced axon
// endpoint is removed on a subnet (which subnets churn their serving infrastructure), read from the
// same account_events [netuid, hotkey] tuple AxonServed uses — the network-wide companion to the
// per-subnet /api/v1/subnets/{netuid}/axon-removals.

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron's announced axon endpoint is removed on a subnet.
export const AXON_REMOVAL_EVENT_KIND = "AxonInfoRemoved";

export const CHAIN_AXON_REMOVALS_LIMIT_DEFAULT = 20;
export const CHAIN_AXON_REMOVALS_LIMIT_MAX = 100;

// Round a removals-per-remover ratio to a stable precision (2dp). Always finite and
// non-negative here (events / distinct hotkeys, with the divisor guarded below).
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

// Average AxonInfoRemoved events per distinct hotkey — the subnet's re-teardown intensity (1.0
// means each remover removed once; higher means hotkeys removed an axon repeatedly after
// re-announcing). A subnet with no removers has no defined intensity (null), not a divide-by-zero.
function removalsPerRemover(removals, removers) {
  if (removers <= 0) return null;
  return round(removals / removers);
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

// Spread of the per-subnet re-teardown intensity across every subnet with removal activity:
// count, mean, and min / p25 / median / p75 / p90 / max. Null when no subnet saw a removal.
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
  distinct_removers: 0,
  removals: 0,
  removals_per_remover: null,
};

// Shape the network-wide axon-removal scorecard from the per-subnet account_events aggregate.
// `subnetRows` carries one row per netuid (COUNT(*) removals, COUNT(DISTINCT hotkey)
// distinct_removers). `networkDistinct` carries the true network-wide distinct hotkey count (a
// hotkey removing an axon on several subnets counts once, so this is NOT the sum of the per-subnet
// distinct_removers) plus the newest observed_at. `limit` caps the leaderboard; subnet_count and
// the distribution span every subnet with observed removal activity (subnets with no
// AxonInfoRemoved events in the window are absent). Null-safe: no rows yields the empty block.
export function buildChainAxonRemovals(
  subnetRows,
  { window, limit = CHAIN_AXON_REMOVALS_LIMIT_DEFAULT, networkDistinct } = {},
) {
  const list = Array.isArray(subnetRows) ? subnetRows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(1, Math.min(flooredLimit, CHAIN_AXON_REMOVALS_LIMIT_MAX))
    : CHAIN_AXON_REMOVALS_LIMIT_DEFAULT;
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
    const removers = toCount(row?.distinct_removers);
    if (removers === 0) continue; // no removers: not a teardown surface
    const bucket = perNetuid.get(netuid) ?? { removers: 0, removals: 0 };
    bucket.removers += removers;
    bucket.removals += toCount(row?.removals);
    perNetuid.set(netuid, bucket);
  }
  if (perNetuid.size === 0) return empty;

  const subnets = [];
  let totalRemovals = 0;
  for (const [netuid, bucket] of perNetuid) {
    subnets.push({
      netuid,
      distinct_removers: bucket.removers,
      removals: bucket.removals,
      removals_per_remover: removalsPerRemover(
        bucket.removals,
        bucket.removers,
      ),
    });
    totalRemovals += bucket.removals;
  }
  // Most active removal subnets first (by total AxonInfoRemoved events), tie-broken by netuid.
  subnets.sort((a, b) => b.removals - a.removals || a.netuid - b.netuid);

  const networkRemovers = toCount(networkDistinct?.distinct_removers);
  const network = {
    distinct_removers: networkRemovers,
    removals: totalRemovals,
    removals_per_remover: removalsPerRemover(totalRemovals, networkRemovers),
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet re-teardown intensity over EVERY subnet (not just the returned
    // page), so the spread is network-wide even when `limit` truncates the leaderboard.
    intensity_distribution: intensityDistribution(
      subnets.map((subnet) => subnet.removals_per_remover),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// Network-wide axon-removal activity, computed live: read the account_events AxonInfoRemoved stream
// over the window (observed_at >= now - windowDays, epoch ms), first as a single network aggregate
// (true distinct removers + newest observed_at, bounded by idx_account_events_observed) and then
// grouped by netuid for the per-subnet leaderboard, and shape with buildChainAxonRemovals. The
// newest-observed probe doubles as the cold-store guard: a null MAX(observed_at) skips the
// per-subnet read. An AxonInfoRemoved event always carries the removing hotkey, so
// COUNT(DISTINCT hotkey) is exact. The handler resolves windowLabel/windowDays from analyticsWindow
// (7d/30d). Cold/absent store -> the schema-stable empty block.
export async function loadChainAxonRemovals(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const networkRows = await d1(
    "SELECT COUNT(DISTINCT hotkey) AS distinct_removers, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ?",
    [AXON_REMOVAL_EVENT_KIND, cutoff],
  );
  const networkDistinct = networkRows?.[0] ?? null;
  let subnetRows = [];
  if (networkDistinct?.newest_observed != null) {
    subnetRows = await d1(
      "SELECT netuid, COUNT(*) AS removals, COUNT(DISTINCT hotkey) AS distinct_removers " +
        "FROM account_events WHERE event_kind = ? AND observed_at >= ? GROUP BY netuid " +
        "ORDER BY removals DESC, netuid ASC",
      [AXON_REMOVAL_EVENT_KIND, cutoff],
    );
  }
  return buildChainAxonRemovals(subnetRows, {
    window: windowLabel,
    limit,
    networkDistinct,
  });
}
