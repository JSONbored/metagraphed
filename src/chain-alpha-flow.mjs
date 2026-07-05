// Network-wide cross-subnet ALPHA flow: how much subnet alpha was minted (StakeAdded — TAO staked in
// buys alpha) vs burned (StakeRemoved — alpha sold back for TAO) on each subnet over a recent window,
// summed from the first-party account_events stream, ranked into a leaderboard of where alpha supply
// is expanding or contracting, with a network rollup and a distribution of per-subnet net alpha flow.
// The ALPHA-denominated companion to the TAO-denominated /api/v1/chain/stake-flow: that route sums the
// amount_tao capital leg, this sums the alpha_amount token leg of the SAME StakeAdded/StakeRemoved
// swaps (#1856). Because a subnet's alpha price floats, alpha volume is NOT derivable from the TAO
// flow — a subnet can take large TAO inflow yet mint little alpha (high price) or vice versa, so net
// alpha flow is independent information about each subnet's token supply dynamics. Pure shaping
// (buildChainAlphaFlow) + a thin D1 loader (loadChainAlphaFlow); the Worker adds the REST envelope.
// Null-safe: a cold store or an empty window yields schema-stable zeros (never throws).

const DAY_MS = 24 * 60 * 60 * 1000;

// The two account_events kinds that swap TAO for subnet alpha: StakeAdded mints alpha (alpha in),
// StakeRemoved burns alpha (alpha out). Both carry a non-negative alpha_amount, so net = in - out.
export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

export const CHAIN_ALPHA_FLOW_LIMIT_DEFAULT = 20;
export const CHAIN_ALPHA_FLOW_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's analytics window set
// (7d/30d, default 7d). Kept next to the loader so runtime validation cannot drift from the endpoint.
export const CHAIN_ALPHA_FLOW_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_ALPHA_FLOW_WINDOW = "7d";

// 1 alpha = 1e9 rao (alpha shares the 9-decimal rao base of TAO). Summing many REAL alpha_amount
// values accumulates IEEE-754 noise below the rao floor; round every alpha output to rao precision
// (the same rounding the sibling stake-flow scorecard applies to TAO).
const RAO_PER_ALPHA = 1e9;
function roundAlpha(value) {
  /* v8 ignore next -- defensive: callers only pass finite nullableAlpha-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_ALPHA) / RAO_PER_ALPHA;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite number, default 0.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A finite, non-negative alpha aggregate cell, or null when absent/blank/non-numeric/negative so a
// malformed row is skipped rather than counted (alpha_amount is always >= 0, so a negative SUM is
// malformed and would violate the schema's total_alpha_in / total_alpha_out >= 0).
function nullableAlpha(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed direct row must be skipped.
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

// A coarse direction label from net vs gross alpha flow: |net| below 5% of gross reads as churn
// (alpha cycling both ways) rather than a directional move; gross 0 (no flow) is balanced.
function classifyDirection(net, gross) {
  if (gross <= 0) return "balanced";
  if (Math.abs(net) / gross < 0.05) return "balanced";
  return net > 0 ? "expanding" : "contracting";
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (net alpha flow can be negative).
function percentile(ascending, p) {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Conventional median of a NON-EMPTY ascending numeric array (net alpha flow can be negative): the
// middle value for an odd count, the mean of the two middle values for an even count. Matches
// median() in chain-stake-flow / chain-yield so a `median` field is the same statistic across the API.
// Reached only after netFlowDistribution's empty short-circuit.
function median(ascending) {
  const mid = (ascending.length - 1) / 2;
  return roundAlpha(
    (ascending[Math.floor(mid)] + ascending[Math.ceil(mid)]) / 2,
  );
}

// Spread of the per-subnet net alpha flow across every subnet in the window: count, mean, and
// min / p25 / median / p75 / p90 / max (alpha). Null when no subnet moved alpha — lets a caller read
// the flow as a distribution (how lopsided the network's alpha supply movement is).
function netFlowDistribution(values) {
  if (values.length === 0) return null;
  const ascending = [...values].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: roundAlpha(sum / ascending.length),
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: median(ascending),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[ascending.length - 1],
  };
}

// Shape the network-wide cross-subnet alpha-flow scorecard from the per-(netuid, event_kind)
// StakeAdded/StakeRemoved aggregate. `rows` carries at most two rows per netuid (one per kind) with
// total_alpha (SUM alpha_amount), event_count (COUNT), and last_observed (MAX observed_at). `limit`
// caps the leaderboard; the network rollup, subnet_count, and distribution cover every subnet that
// moved alpha in the window (subnets with no StakeAdded/StakeRemoved events are absent, which the
// route/schema advertise as "active alpha-flow subnets"). Null-safe: no rows yields the empty block.
export function buildChainAlphaFlow(
  rows,
  { window, limit = CHAIN_ALPHA_FLOW_LIMIT_DEFAULT } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_ALPHA_FLOW_LIMIT_MAX))
    : CHAIN_ALPHA_FLOW_LIMIT_DEFAULT;

  const perNetuid = new Map();
  let newestObserved = null;
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    // Only a StakeAdded/StakeRemoved row is an alpha swap: skip any other kind BEFORE creating a
    // bucket so a non-swap row (only reachable via a malformed direct call — the loader's SQL already
    // filters to these two kinds) never materializes an inactive all-zero subnet.
    const kind = row?.event_kind;
    if (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND) continue;
    const alpha = nullableAlpha(row?.total_alpha);
    if (alpha == null) continue;
    const bucket = perNetuid.get(netuid) ?? {
      alphaIn: 0,
      alphaOut: 0,
      inEvents: 0,
      outEvents: 0,
    };
    if (kind === STAKE_ADDED_KIND) {
      bucket.alphaIn += alpha;
      bucket.inEvents += toNumber(row?.event_count);
    } else {
      bucket.alphaOut += alpha;
      bucket.outEvents += toNumber(row?.event_count);
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
  let totalIn = 0;
  let totalOut = 0;
  let totalInEvents = 0;
  let totalOutEvents = 0;
  let expanding = 0;
  let contracting = 0;
  let flat = 0;
  for (const [netuid, bucket] of perNetuid) {
    const net = bucket.alphaIn - bucket.alphaOut;
    const gross = bucket.alphaIn + bucket.alphaOut;
    const direction = classifyDirection(net, gross);
    subnets.push({
      netuid,
      total_alpha_in: roundAlpha(bucket.alphaIn),
      total_alpha_out: roundAlpha(bucket.alphaOut),
      net_alpha_flow: roundAlpha(net),
      gross_alpha_flow: roundAlpha(gross),
      stake_events: bucket.inEvents,
      unstake_events: bucket.outEvents,
      direction,
    });
    totalIn += bucket.alphaIn;
    totalOut += bucket.alphaOut;
    totalInEvents += bucket.inEvents;
    totalOutEvents += bucket.outEvents;
    // Count from the SAME direction label the subnet reports, so a subnet whose net is within the
    // churn threshold is counted flat (not expanding/contracting) consistently with its label.
    if (direction === "expanding") expanding += 1;
    else if (direction === "contracting") contracting += 1;
    else flat += 1;
  }
  // Biggest net alpha expansion first (where alpha supply is growing), tie-broken by netuid.
  subnets.sort(
    (a, b) => b.net_alpha_flow - a.net_alpha_flow || a.netuid - b.netuid,
  );

  const network = {
    total_alpha_in: roundAlpha(totalIn),
    total_alpha_out: roundAlpha(totalOut),
    net_alpha_flow: roundAlpha(totalIn - totalOut),
    gross_alpha_flow: roundAlpha(totalIn + totalOut),
    stake_events: totalInEvents,
    unstake_events: totalOutEvents,
    expanding,
    contracting,
    flat,
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(newestObserved),
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet net alpha flow over EVERY subnet (not just the returned page).
    net_flow_distribution: netFlowDistribution(
      subnets.map((subnet) => subnet.net_alpha_flow),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// Network-wide cross-subnet alpha flow, computed live: sum StakeAdded/StakeRemoved alpha_amount from
// account_events over the window (observed_at >= now - windowDays, epoch ms), grouped by (netuid,
// event_kind), shaped with buildChainAlphaFlow. The handler resolves windowLabel/windowDays from
// analyticsWindow (7d/30d); a defensive windowDays default keeps a direct caller from producing a NaN
// cutoff. Cold/absent store or an empty window -> schema-stable zeros.
export async function loadChainAlphaFlow(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const days = Number.isFinite(windowDays)
    ? windowDays
    : CHAIN_ALPHA_FLOW_WINDOWS[DEFAULT_CHAIN_ALPHA_FLOW_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, event_kind, COALESCE(SUM(alpha_amount), 0) AS total_alpha, " +
      "COUNT(*) AS event_count, MAX(observed_at) AS last_observed " +
      "FROM account_events " +
      "WHERE event_kind IN (?, ?) AND observed_at >= ? " +
      "GROUP BY netuid, event_kind",
    [STAKE_ADDED_KIND, STAKE_REMOVED_KIND, cutoff],
  );
  return buildChainAlphaFlow(rows, { window: windowLabel, limit });
}
