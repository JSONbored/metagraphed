// Network-wide cross-subnet capital flow: how much TAO entered (StakeAdded) vs left
// (StakeRemoved) each subnet over a recent window, summed from the first-party account_events
// stream, ranked into a leaderboard of where capital is flowing across the network, with a
// network rollup and a distribution of per-subnet net flow. The network companion to
// /api/v1/subnets/{netuid}/stake-flow, mirroring how /chain/concentration companions the
// per-subnet concentration route. Pure shaping (buildChainStakeFlow) + a thin D1 loader
// (loadChainStakeFlow); the Worker adds the REST envelope. Null-safe: a cold store or an
// empty window yields schema-stable zeros (never throws), matching the sibling live tiers.

const DAY_MS = 24 * 60 * 60 * 1000;

// The two account_events kinds that move stake: StakeAdded is capital entering a subnet,
// StakeRemoved is capital leaving. Both carry a positive amount_tao, so net = staked - unstaked.
export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

export const CHAIN_STAKE_FLOW_LIMIT_DEFAULT = 20;
export const CHAIN_STAKE_FLOW_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's
// analytics window set (7d/30d, default 7d). Kept next to the loader so the MCP
// tool's input schema and runtime validation cannot drift from the endpoint.
export const CHAIN_STAKE_FLOW_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_STAKE_FLOW_WINDOW = "7d";

// 1 TAO = 1e9 rao. Summing many REAL amount_tao values accumulates IEEE-754 noise below the
// rao floor; round every TAO output to rao precision (the same rounding the sibling scorecards
// apply). A non-finite sum can only arise from a malformed direct call — coerce it to 0.
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite number,
// defaulting to 0.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed direct row must be
// skipped, never counted as netuid 0.
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
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number.isFinite(new Date(n).getTime()) ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// A coarse direction label from net vs gross flow: |net| below 5% of gross reads as churn
// (capital cycling both ways) rather than a directional move; gross 0 (no flow) is balanced.
function classifyDirection(net, gross) {
  if (gross <= 0) return "balanced";
  if (Math.abs(net) / gross < 0.05) return "balanced";
  return net > 0 ? "inflow" : "outflow";
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (net flow can be negative).
function percentile(ascending, p) {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Spread of the per-subnet net flow across every subnet in the window: count, mean, and
// min / p25 / median / p75 / p90 / max (TAO). Null when no subnet moved stake — lets a caller
// read the flow as a distribution (how lopsided the network's capital movement is).
function netFlowDistribution(values) {
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

// Shape the network-wide cross-subnet capital-flow scorecard from the per-(netuid, event_kind)
// StakeAdded/StakeRemoved aggregate. `rows` carries at most two rows per netuid (one per kind)
// with total_tao (SUM amount_tao), event_count (COUNT), and last_observed (MAX observed_at).
// `limit` caps the leaderboard; the network rollup, subnet_count, and distribution cover every
// subnet that moved stake in the window (the aggregate's rows) — subnets with no StakeAdded/
// StakeRemoved events are absent from account_events and so are not represented, which the
// route/schema advertise as "active stake-flow subnets". Null-safe: no rows yields the empty block.
export function buildChainStakeFlow(
  rows,
  { window, limit = CHAIN_STAKE_FLOW_LIMIT_DEFAULT } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_STAKE_FLOW_LIMIT_MAX))
    : CHAIN_STAKE_FLOW_LIMIT_DEFAULT;

  const perNetuid = new Map();
  let newestObserved = null;
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    // Only a StakeAdded/StakeRemoved row is a stake movement: skip any other kind BEFORE creating
    // a bucket so a non-stake row (only reachable via a malformed direct call — the loader's SQL
    // already filters to these two kinds) never materializes an inactive all-zero subnet, keeping
    // the pure builder aligned with the "active stake-flow subnets" contract.
    const kind = row?.event_kind;
    if (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND) continue;
    const bucket = perNetuid.get(netuid) ?? {
      staked: 0,
      unstaked: 0,
      stakeEvents: 0,
      unstakeEvents: 0,
    };
    if (kind === STAKE_ADDED_KIND) {
      bucket.staked += toNumber(row?.total_tao);
      bucket.stakeEvents += toNumber(row?.event_count);
    } else {
      bucket.unstaked += toNumber(row?.total_tao);
      bucket.unstakeEvents += toNumber(row?.event_count);
    }
    perNetuid.set(netuid, bucket);
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (newestObserved == null || observed > newestObserved)
    ) {
      newestObserved = observed;
    }
  }

  const subnets = [];
  let totalStaked = 0;
  let totalUnstaked = 0;
  let totalStakeEvents = 0;
  let totalUnstakeEvents = 0;
  let gaining = 0;
  let losing = 0;
  let flat = 0;
  for (const [netuid, bucket] of perNetuid) {
    const net = bucket.staked - bucket.unstaked;
    const gross = bucket.staked + bucket.unstaked;
    const direction = classifyDirection(net, gross);
    subnets.push({
      netuid,
      total_staked_tao: roundTao(bucket.staked),
      total_unstaked_tao: roundTao(bucket.unstaked),
      net_flow_tao: roundTao(net),
      gross_flow_tao: roundTao(gross),
      stake_events: bucket.stakeEvents,
      unstake_events: bucket.unstakeEvents,
      direction,
    });
    totalStaked += bucket.staked;
    totalUnstaked += bucket.unstaked;
    totalStakeEvents += bucket.stakeEvents;
    totalUnstakeEvents += bucket.unstakeEvents;
    // Count from the SAME direction label the subnet reports, so a subnet whose net is within
    // the churn threshold is counted flat (not gaining/losing) consistently with its label.
    if (direction === "inflow") gaining += 1;
    else if (direction === "outflow") losing += 1;
    else flat += 1;
  }
  // Biggest net inflow first (where capital is flowing in), tie-broken by netuid.
  subnets.sort(
    (a, b) => b.net_flow_tao - a.net_flow_tao || a.netuid - b.netuid,
  );

  const network = {
    total_staked_tao: roundTao(totalStaked),
    total_unstaked_tao: roundTao(totalUnstaked),
    net_flow_tao: roundTao(totalStaked - totalUnstaked),
    gross_flow_tao: roundTao(totalStaked + totalUnstaked),
    stake_events: totalStakeEvents,
    unstake_events: totalUnstakeEvents,
    gaining,
    losing,
    flat,
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(newestObserved),
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet net flow over EVERY subnet (not just the returned page).
    net_flow_distribution: netFlowDistribution(
      subnets.map((subnet) => subnet.net_flow_tao),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// Network-wide cross-subnet capital flow, computed live: sum StakeAdded/StakeRemoved amount_tao
// from account_events over the window (observed_at >= now - windowDays, epoch ms), grouped by
// (netuid, event_kind), shaped with buildChainStakeFlow. The query is bounded by the window via
// idx_account_events_observed (observed_at) — the same bounded network-wide account_events scan
// the sibling chain-transfers route runs — with the two stake kinds a residual filter. The
// handler resolves windowLabel/windowDays from analyticsWindow (7d/30d). Cold/absent store or an
// empty window -> schema-stable zeros.
export async function loadChainStakeFlow(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT netuid, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, " +
      "COUNT(*) AS event_count, MAX(observed_at) AS last_observed " +
      "FROM account_events " +
      "WHERE event_kind IN (?, ?) AND observed_at >= ? " +
      "GROUP BY netuid, event_kind",
    [STAKE_ADDED_KIND, STAKE_REMOVED_KIND, cutoff],
  );
  return buildChainStakeFlow(rows, { window: windowLabel, limit });
}
