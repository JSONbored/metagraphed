// Network-wide stake-transfer VOLUME: how much TAO value moved between coldkeys (transfer_stake) out
// of each subnet over a recent window, summed from the account_events StakeTransferred stream, ranked
// into a leaderboard of where transfer value is concentrated, with a network rollup and a distribution
// of per-subnet volume. The value companion to the COUNT-based /api/v1/chain/stake-transfers: that
// route answers "how MANY transfers and how many distinct senders per subnet", this answers "how much
// TAO VALUE was transferred" — the two are orthogonal (many tiny transfers vs a few large ones). Pure
// shaping (buildChainStakeTransferVolume) + a thin D1 loader (loadChainStakeTransferVolume); the Worker
// adds the REST envelope. Ranked and summed by the ORIGIN (netuid, coldkey); only the origin leg has an
// amount column, so this is inherently an origin-side view (scripts/fetch-events.py `_stake_transferred`,
// #2556). Null-safe: a cold store or an empty window yields schema-stable zeros (never throws).

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a coldkey transfers stake to another coldkey (transfer_stake);
// its amount_tao is the TAO value moved on the origin leg.
export const STAKE_TRANSFERRED_EVENT_KIND = "StakeTransferred";

export const CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_DEFAULT = 20;
export const CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's analytics window set
// (7d/30d, default 7d). Kept next to the loader so runtime validation cannot drift from the endpoint.
export const CHAIN_STAKE_TRANSFER_VOLUME_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_STAKE_TRANSFER_VOLUME_WINDOW = "7d";

// 1 TAO = 1e9 rao. Summing many REAL amount_tao values accumulates IEEE-754 noise below the rao
// floor; round every TAO output to rao precision (the same rounding the sibling stake-flow scorecard
// applies). A non-finite sum can only arise from a malformed direct call — coerce it to 0.
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  /* v8 ignore next -- defensive: callers only pass finite nullableTao-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A finite TAO aggregate cell (number, numeric string, or null), or null when absent/blank/non-numeric
// so a subnet with no summable volume is skipped rather than counted as 0-value activity.
function nullableTao(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed row must be skipped.
function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the envelope's
// generated_at. Guards the JS Date range so a finite but out-of-range epoch cannot throw a RangeError.
function coerceEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number.isFinite(new Date(n).getTime()) ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Average TAO per transfer — the subnet's mean transfer size (total volume / transfer count). A subnet
// with no transfers has no defined average (null) rather than a divide-by-zero.
function avgTransferTao(volume, transfers) {
  /* v8 ignore next -- defensive: the builder skips zero-transfer rows and short-circuits an empty
     network to the EMPTY_NETWORK block, so transfers is always > 0 by the time this is called */
  if (transfers <= 0) return null;
  return roundTao(volume / transfers);
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (deterministic, no interpolation).
// Only called from volumeDistribution, which short-circuits an empty set to null before reaching here.
function percentile(ascending, p) {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Spread of per-subnet transfer volume across every subnet with transfer activity: count, mean, and
// min / p25 / median / p75 / p90 / max (TAO). Null when no subnet saw a transfer — lets a caller read
// how concentrated the network's transfer value is across subnets.
function volumeDistribution(values) {
  /* v8 ignore next -- defensive: only called with one value per subnet, and the builder returns the
     empty block (distribution null) before this runs when there are no subnets */
  if (values.length === 0) return null;
  const ascending = [...values].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: roundTao(sum / ascending.length),
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: percentile(ascending, 50),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[ascending.length - 1],
  };
}

const EMPTY_NETWORK = {
  total_volume_tao: 0,
  transfers: 0,
  avg_transfer_tao: null,
};

// Shape the network-wide stake-transfer-volume scorecard from the per-subnet account_events aggregate.
// `rows` carries one row per origin netuid (COALESCE(SUM(amount_tao)) volume_tao, COUNT(*) transfers,
// MAX(observed_at) last_observed). Volume and count are additive, so the network rollup is the JS sum of
// the per-subnet rows (no separate network query needed, unlike the distinct-sender count route). `limit`
// caps the leaderboard; subnet_count and the distribution span every subnet with observed transfer
// activity (subnets with no StakeTransferred events in the window are absent). Null-safe: no rows yields
// the empty block.
export function buildChainStakeTransferVolume(
  rows,
  { window, limit = CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_DEFAULT } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(1, Math.min(flooredLimit, CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_MAX))
    : CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_DEFAULT;

  const perNetuid = new Map();
  let newestObserved = null;
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const volume = nullableTao(row?.volume_tao);
    if (volume == null) continue; // no summable volume: skip
    const transfers = toCount(row?.transfers);
    if (transfers === 0) continue; // no transfers: not a transfer surface
    const bucket = perNetuid.get(netuid) ?? { volume: 0, transfers: 0 };
    bucket.volume += volume;
    bucket.transfers += transfers;
    perNetuid.set(netuid, bucket);
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (newestObserved == null || observed > newestObserved)
    ) {
      newestObserved = observed;
    }
  }

  const empty = {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(newestObserved),
    subnet_count: 0,
    network: { ...EMPTY_NETWORK },
    volume_distribution: null,
    subnets: [],
  };
  if (perNetuid.size === 0) return empty;

  const subnets = [];
  let totalVolume = 0;
  let totalTransfers = 0;
  for (const [netuid, bucket] of perNetuid) {
    subnets.push({
      netuid,
      volume_tao: roundTao(bucket.volume),
      transfers: bucket.transfers,
      avg_transfer_tao: avgTransferTao(bucket.volume, bucket.transfers),
    });
    totalVolume += bucket.volume;
    totalTransfers += bucket.transfers;
  }
  // Biggest transfer volume first, tie-broken by netuid for a stable order.
  subnets.sort((a, b) => b.volume_tao - a.volume_tao || a.netuid - b.netuid);

  const network = {
    total_volume_tao: roundTao(totalVolume),
    transfers: totalTransfers,
    avg_transfer_tao: avgTransferTao(totalVolume, totalTransfers),
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(newestObserved),
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet volume over EVERY subnet (not just the returned page), so the spread
    // is network-wide even when `limit` truncates the leaderboard.
    volume_distribution: volumeDistribution(
      subnets.map((subnet) => subnet.volume_tao),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// Network-wide stake-transfer volume, computed live: sum StakeTransferred amount_tao from
// account_events over the window, filtered by event_kind and the observed_at >= now - windowDays
// predicate (epoch ms), grouped per origin netuid, and shape with buildChainStakeTransferVolume. The
// handler resolves windowLabel/windowDays from analyticsWindow (7d/30d). Cold/absent store or an empty
// window -> the schema-stable empty block.
export async function loadChainStakeTransferVolume(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COALESCE(SUM(amount_tao), 0) AS volume_tao, " +
      "COUNT(*) AS transfers, MAX(observed_at) AS last_observed " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ? " +
      "GROUP BY netuid ORDER BY volume_tao DESC, netuid ASC",
    [STAKE_TRANSFERRED_EVENT_KIND, cutoff],
  );
  return buildChainStakeTransferVolume(rows, { window: windowLabel, limit });
}
