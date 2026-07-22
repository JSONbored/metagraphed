// Live network-wide stake-transfer activity from the account_events StakeTransferred stream: a
// per-subnet leaderboard plus a network rollup and intensity distribution. Pure shaping
// (buildChainStakeTransfers); the Worker / data-api Postgres tier supplies the rows and adds the
// REST envelope. The field semantics live in schemas/components/05-subnets.schema.json
// (ChainStakeTransfersArtifact). The between-coldkeys companion to the within-account re-delegation
// churn of /chain/stake-moves: StakeTransferred (transfer_stake, #2556) moves staked alpha from one
// coldkey to ANOTHER coldkey on the same hotkey, so it relocates ownership rather than net capital
// or delegation. Ranked and counted by the ORIGIN (netuid, coldkey); the distinct sender is the
// origin coldkey initiating the transfer. Only the origin leg has columns (destination
// coldkey/netuid are dropped at ingest), so this is inherently an origin-side view — see
// scripts/fetch-events.py `_stake_transferred` (#2556).
//
// The D1 loader (loadChainStakeTransfers) was removed — account_events' D1 write path is retired
// and the table is dropped in production (#4772 / #4909), so serving goes tryPostgresTier →
// schema-stable empty stub, never D1.

// The account_events kind emitted when a coldkey transfers stake to another coldkey (transfer_stake).
export const STAKE_TRANSFERRED_EVENT_KIND = "StakeTransferred";

export const CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT = 20;
export const CHAIN_STAKE_TRANSFERS_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's analytics
// window set (7d/30d, default 7d). Kept next to the loader so runtime validation
// cannot drift from the endpoint.
export const CHAIN_STAKE_TRANSFERS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_STAKE_TRANSFERS_WINDOW = "7d";

// Round a transfers-per-sender ratio to a stable precision (2dp). Always finite and
// non-negative here (events / distinct coldkeys, with the divisor guarded below).
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
  // toIso's new Date(n).toISOString() throw a RangeError, which would 500 the whole
  // stake-transfers endpoint on a single corrupt observed_at cell. Drop it to null,
  // mirroring the getTime() range guard chain-stake-flow.ts added in #3016.
  return Number.isFinite(new Date(n).getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Average StakeTransferred events per distinct sender — the subnet's re-transfer intensity (1.0
// means each sender transferred once; higher means repeated transfers). A subnet with no senders has
// no defined intensity (null) rather than a divide-by-zero.
function transfersPerSender(transfers: number, senders: number): number | null {
  if (senders <= 0) return null;
  return round(transfers / senders);
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
// Matches median() in chain-yield.ts / subnet-yield.mjs and the chain-activity distribution family
// (#3200) so a `median` field is the same statistic across the API. Reached only after the empty
// short-circuit.
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

// Spread of the per-subnet transfer intensity across every subnet with transfer activity: count,
// mean, and min / p25 / median / p75 / p90 / max. Null when no subnet saw a transfer.
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

export interface ChainStakeTransfersNetwork {
  distinct_senders: number;
  transfers: number;
  transfers_per_sender: number | null;
}

const EMPTY_NETWORK: ChainStakeTransfersNetwork = {
  distinct_senders: 0,
  transfers: 0,
  transfers_per_sender: null,
};

export interface ChainStakeTransfersSubnet {
  netuid: number;
  distinct_senders: number;
  transfers: number;
  transfers_per_sender: number;
}

export interface ChainStakeTransfersResult {
  schema_version: 1;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainStakeTransfersNetwork;
  intensity_distribution: IntensityDistribution | null;
  subnets: ChainStakeTransfersSubnet[];
}

// Shape the network-wide stake-transfer scorecard from the per-subnet account_events aggregate.
// `subnetRows` carries one row per origin netuid (COUNT(*) transfers, COUNT(DISTINCT coldkey)
// distinct_senders). `networkDistinct` carries the true network-wide distinct coldkey count (a
// coldkey transferring stake out of several subnets counts once, so this is NOT the sum of the
// per-subnet distinct_senders) plus the newest observed_at. `limit` caps the leaderboard;
// subnet_count and the distribution span every subnet with observed transfer activity (subnets with
// no StakeTransferred events in the window are absent). Null-safe: no rows yields the empty block.
export function buildChainStakeTransfers(
  subnetRows: Array<Record<string, unknown>> | null | undefined,
  {
    window,
    limit = CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
    networkDistinct,
  }: {
    window?: string | null;
    limit?: number;
    networkDistinct?: { distinct_senders?: unknown; newest_observed?: unknown };
  } = {},
): ChainStakeTransfersResult {
  const list = Array.isArray(subnetRows) ? subnetRows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_STAKE_TRANSFERS_LIMIT_MAX))
    : CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT;
  const observedAt = toIso(networkDistinct?.newest_observed);

  const empty: ChainStakeTransfersResult = {
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
  const perNetuid = new Map<number, { senders: number; transfers: number }>();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const senders = toCount(row?.distinct_senders);
    if (senders === 0) continue; // no senders: not a transfer surface
    const bucket = perNetuid.get(netuid) ?? { senders: 0, transfers: 0 };
    bucket.senders += senders;
    bucket.transfers += toCount(row?.transfers);
    perNetuid.set(netuid, bucket);
  }
  if (perNetuid.size === 0) return empty;

  const subnets: ChainStakeTransfersSubnet[] = [];
  let totalTransfers = 0;
  for (const [netuid, bucket] of perNetuid) {
    subnets.push({
      netuid,
      distinct_senders: bucket.senders,
      transfers: bucket.transfers,
      // transfersPerSender only returns null when senders <= 0, and every bucket here has
      // senders > 0 (the `senders === 0` guard above skips it before it's ever created).
      transfers_per_sender: transfersPerSender(
        bucket.transfers,
        bucket.senders,
      ) as number,
    });
    totalTransfers += bucket.transfers;
  }
  // Most active sending subnets first (by total StakeTransferred events), tie-broken by netuid.
  subnets.sort((a, b) => b.transfers - a.transfers || a.netuid - b.netuid);

  const networkSenders = toCount(networkDistinct?.distinct_senders);
  const network: ChainStakeTransfersNetwork = {
    distinct_senders: networkSenders,
    transfers: totalTransfers,
    transfers_per_sender: transfersPerSender(totalTransfers, networkSenders),
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet transfer intensity over EVERY subnet (not just the returned page),
    // so the spread is network-wide even when `limit` truncates the leaderboard.
    intensity_distribution: intensityDistribution(
      subnets.map((subnet) => subnet.transfers_per_sender),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}
