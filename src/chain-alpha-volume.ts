// Network-wide rolling 24h buy/sell alpha-volume leaderboard: which subnets have the most
// market activity right now, ranked by total_volume_tao, with a network rollup (including a
// network-wide sentiment reading) and a distribution of per-subnet volume across the network.
// The network companion to /api/v1/subnets/{netuid}/volume, mirroring how /chain/stake-flow
// companions /subnets/{netuid}/stake-flow. Pure shaping (buildChainAlphaVolume); the Worker
// adds the REST envelope. Null-safe: a cold store or an empty window yields schema-stable
// zeros (never throws), matching the sibling live tiers.
//
// Reuses alpha-volume.mjs's buildAlphaVolume for each subnet's scorecard (buy/sell/total volume
// + sentiment) rather than re-deriving the same math — this module only groups rows by netuid,
// ranks the resulting scorecards, and rolls them up into a network-wide total + distribution.
//
// Fixed 24h window (no ?window= param), matching the per-subnet route's own framing (#4339's
// scope: a canonical market-depth figure, not a windowed analytics view).

import {
  buildAlphaVolume,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
  sentimentRatio,
  classifySentiment,
  type AlphaVolumeResult,
  type AlphaVolumeSentiment,
} from "./alpha-volume.ts";

export const CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT = 20;
export const CHAIN_ALPHA_VOLUME_LIMIT_MAX = 100;

// 1 TAO/alpha = 1e9 rao. Summing many already-rounded per-subnet totals can still accumulate
// IEEE-754 noise below the rao floor; round every network-rollup output to rao precision,
// mirroring alpha-volume.mjs's own roundUnit / chain-stake-flow.ts's roundTao.
const RAO_PER_UNIT = 1e9;
function roundUnit(value: number): number {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_UNIT) / RAO_PER_UNIT;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed direct row must be
// skipped, never counted as netuid 0. Mirrors chain-stake-flow.ts's normalizedNetuid.
function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the
// envelope's observed_at, mirroring chain-stake-flow.ts's coerceEpochMs.
function coerceEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number.isFinite(new Date(n).getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array. Mirrors
// chain-stake-flow.ts's percentile, applied here to total_volume_tao instead of net flow.
function percentile(ascending: number[], p: number): number {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Conventional median of a NON-EMPTY ascending numeric array: the middle value for an odd
// count, the mean of the two middle values for an even count. Mirrors chain-stake-flow.ts's
// median (itself matching subnet-yield.ts / chain-yield.ts), applied to total_volume_tao.
function median(ascending: number[]): number {
  const mid = (ascending.length - 1) / 2;
  return roundUnit(
    (ascending[Math.floor(mid)] + ascending[Math.ceil(mid)]) / 2,
  );
}

export interface VolumeDistribution {
  count: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

// Spread of per-subnet total_volume_tao across every subnet with volume in the window: count,
// mean, and min / p25 / median / p75 / p90 / max (TAO). Null when no subnet had volume — lets a
// caller read how concentrated (or spread out) the network's market activity is. Mirrors
// chain-stake-flow.ts's netFlowDistribution, applied to total_volume_tao instead of net flow.
function volumeDistribution(values: number[]): VolumeDistribution | null {
  if (values.length === 0) return null;
  const ascending = [...values].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: roundUnit(sum / ascending.length),
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: median(ascending),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[ascending.length - 1],
  };
}

// Shape the network-wide rolling 24h alpha-volume leaderboard from the per-(netuid, event_kind)
// StakeAdded/StakeRemoved aggregate. `rows` carries at most two rows per netuid (one per kind)
// with alpha_volume (SUM alpha_amount), tao_volume (SUM amount_tao), event_count (COUNT), and
// last_observed (MAX observed_at) — the exact shape buildAlphaVolume's own per-subnet rows carry.
// Each netuid's row-group is handed to buildAlphaVolume (netuid, no marketCapTao — this route has
// no per-subnet market-cap input in scope, so vol_mcap_ratio is null on every leaderboard entry,
// same as the D1/Postgres subnet-level route's own null-marketCapTao branch) to get that subnet's
// full volume scorecard, then those scorecards are ranked by total_volume_tao descending (tied
// broken by netuid ascending). `limit` caps the leaderboard; the network rollup, subnet_count, and
// distribution cover every subnet that had volume (the aggregate's rows) — subnets with no
// StakeAdded/StakeRemoved events are absent from account_events and so are not represented, the
// same "active" contract chain-stake-flow.ts advertises. Null-safe: no rows yields the empty
// block, never throws.
export interface ChainAlphaVolumeNetwork {
  buy_volume_alpha: number;
  sell_volume_alpha: number;
  total_volume_alpha: number;
  buy_volume_tao: number;
  sell_volume_tao: number;
  total_volume_tao: number;
  buy_count: number;
  sell_count: number;
  net_volume_alpha: number;
  sentiment_ratio: number | null;
  sentiment: AlphaVolumeSentiment;
}

export interface ChainAlphaVolumeResult {
  schema_version: 1;
  window: "24h";
  observed_at: string | null;
  subnet_count: number;
  network: ChainAlphaVolumeNetwork;
  volume_distribution: VolumeDistribution | null;
  subnets: AlphaVolumeResult[];
}

export function buildChainAlphaVolume(
  rows: Array<Record<string, unknown>> | null | undefined,
  { limit = CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT }: { limit?: number } = {},
): ChainAlphaVolumeResult {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_ALPHA_VOLUME_LIMIT_MAX))
    : CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT;

  const perNetuid = new Map<number, Array<Record<string, unknown>>>();
  let newestObserved: number | null = null;
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    // Only a StakeAdded/StakeRemoved row is volume: skip any other kind BEFORE creating a
    // bucket so a non-volume row (only reachable via a malformed direct call — the loader's SQL
    // already filters to these two kinds) never materializes an inactive all-zero subnet,
    // mirroring chain-stake-flow.ts's own guard.
    const kind = row?.event_kind;
    if (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND) continue;
    const bucket = perNetuid.get(netuid) ?? [];
    bucket.push(row);
    perNetuid.set(netuid, bucket);
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (newestObserved == null || observed > newestObserved)
    ) {
      newestObserved = observed;
    }
  }

  const subnets: AlphaVolumeResult[] = [];
  for (const [netuid, subnetRows] of perNetuid) {
    subnets.push(buildAlphaVolume(subnetRows, netuid));
  }
  // Biggest total volume first (where market activity is concentrated), tie-broken by netuid.
  subnets.sort(
    (a, b) => b.total_volume_tao - a.total_volume_tao || a.netuid - b.netuid,
  );

  let buyAlpha = 0;
  let sellAlpha = 0;
  let buyTao = 0;
  let sellTao = 0;
  let buyCount = 0;
  let sellCount = 0;
  for (const subnet of subnets) {
    buyAlpha += subnet.buy_volume_alpha;
    sellAlpha += subnet.sell_volume_alpha;
    buyTao += subnet.buy_volume_tao;
    sellTao += subnet.sell_volume_tao;
    buyCount += subnet.buy_count;
    sellCount += subnet.sell_count;
  }
  const netAlpha = buyAlpha - sellAlpha;
  const grossAlpha = buyAlpha + sellAlpha;
  const network: ChainAlphaVolumeNetwork = {
    buy_volume_alpha: roundUnit(buyAlpha),
    sell_volume_alpha: roundUnit(sellAlpha),
    total_volume_alpha: roundUnit(grossAlpha),
    buy_volume_tao: roundUnit(buyTao),
    sell_volume_tao: roundUnit(sellTao),
    total_volume_tao: roundUnit(buyTao + sellTao),
    buy_count: buyCount,
    sell_count: sellCount,
    net_volume_alpha: roundUnit(netAlpha),
    // Network-wide sentiment reading (#4339/8.2 at the network scope), derived from the SAME
    // net/gross alpha totals above via alpha-volume.mjs's own sentimentRatio/classifySentiment
    // rather than re-deriving the math a second time.
    sentiment_ratio: sentimentRatio(netAlpha, grossAlpha),
    sentiment: classifySentiment(netAlpha, grossAlpha),
  };

  return {
    schema_version: 1,
    window: "24h",
    observed_at: toIso(newestObserved),
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet total_volume_tao over EVERY subnet with volume (not just the
    // returned page).
    volume_distribution: volumeDistribution(
      subnets.map((subnet) => subnet.total_volume_tao),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// #4772 D1 retirement: loadChainAlphaVolume (the D1 loader that read the
// account_events StakeAdded/StakeRemoved stream) was removed here -- that D1 write
// path is retired and the `account_events` table is dropped in production, so a live
// D1 query would always miss. Serving now goes tryPostgresTier -> buildChainAlphaVolume([...]),
// never D1. See src/graphql.mjs's chain_alpha_volume and src/mcp-server.mjs's
// get_chain_alpha_volume tool for the call sites.
