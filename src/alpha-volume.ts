// Rolling 24h buy/sell alpha volume for one subnet (#4339/8.1), plus a
// buy/sell sentiment indicator derived from it (#4339/8.2 — net/gross alpha
// lean, no new capture or query): how much subnet alpha was bought
// (StakeAdded) vs sold (StakeRemoved) in the last 24 hours, summed from the
// first-party account_events stream. Pure shaping (buildAlphaVolume) + a thin
// D1 loader (loadSubnetAlphaVolume); the Worker adds the REST envelope.
// Null-safe: a cold store or an empty window yields schema-stable zeros
// (never throws), matching the sibling live tiers (stake-flow, turnover).
//
// Explicitly NOT OHLC (#2589's trader-feature fence) — a single rolling 24h
// volume figure, not a price/candlestick series. Fixed 24h window (unlike
// stake-flow's 7d/30d/90d set) matching the issue's own framing as a canonical
// market-depth figure, not a windowed analytics view.

const DAY_MS = 24 * 60 * 60 * 1000;

// The two account_events kinds that move stake — same pair stake-flow.mjs sums.
// StakeAdded is a buy (TAO spent, alpha received); StakeRemoved is a sell (alpha
// spent, TAO received). Both carry alpha_amount (migrations/0020) alongside
// amount_tao, so one query yields both units without a second read.
export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite
// number, defaulting to 0.
function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A finite amount aggregate cell, or null when absent/blank/non-numeric.
function nullableAmount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 1 TAO/alpha = 1e9 rao. Summing many REAL amount cells accumulates IEEE-754
// noise below the rao floor; round every output to rao precision, mirroring
// stake-flow.mjs's roundTao.
const RAO_PER_UNIT = 1e9;
function roundUnit(value: number): number {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_UNIT) / RAO_PER_UNIT;
}

// |net| / gross at or above this share reads as a directional lean rather than
// balanced two-way volume. Mirrors account-stake-flow.mjs's DIRECTIONAL_RATIO —
// same "how decisive is this ratio" cutoff, reused rather than re-derived.
const SENTIMENT_NEUTRAL_BAND = 0.2;

// net / gross alpha volume, bounded to [-1, 1] and rounded to 4dp; null when
// gross is 0 (no volume in the window, ratio undefined). Mirrors
// account-stake-flow.mjs's flowRatio, including its anti-overstatement clamp:
// a sub-perfect ratio (real counter-volume exists) must never round to an
// exact +/-1, which this card's own contract would misread as "no sell/buy
// volume at all" (#2997's clamp, extended to this sibling ratio). Exported so
// chain-alpha-volume.mjs can derive the SAME sentiment reading at the
// network-wide rollup level instead of re-deriving this math.
export function sentimentRatio(
  netAlpha: number,
  grossAlpha: number,
): number | null {
  if (grossAlpha <= 0) return null;
  const raw = netAlpha / grossAlpha;
  const rounded = Math.round(raw * 10000) / 10000;
  if (rounded >= 1 && raw < 1) return 0.9999;
  if (rounded <= -1 && raw > -1) return -0.9999;
  return rounded;
}

export type AlphaVolumeSentiment = "bullish" | "bearish" | "neutral";

// Buy/sell sentiment indicator (#4339/8.2): a coarse label from the same
// net/gross lean account-stake-flow.mjs classifies for one account's capital
// flow, relabeled for a subnet-wide volume reading — "bullish"/"bearish" past
// the neutral band, "neutral" both for balanced two-way volume AND a
// zero-volume window (no data is no signal either way). Exported for
// chain-alpha-volume.mjs's network-wide rollup (see sentimentRatio above).
export function classifySentiment(
  netAlpha: number,
  grossAlpha: number,
): AlphaVolumeSentiment {
  if (grossAlpha <= 0) return "neutral";
  const ratio = netAlpha / grossAlpha;
  if (ratio >= SENTIMENT_NEUTRAL_BAND) return "bullish";
  if (ratio <= -SENTIMENT_NEUTRAL_BAND) return "bearish";
  return "neutral";
}

// 24h volume / market-cap turnover ratio (#4339/8.3) — unsigned total_volume_tao
// (buy + sell, matching this artifact's other TAO totals) over
// alpha_market_cap_tao (the economics artifact's own alpha_price_tao *
// total_stake_tao proxy, scripts/lib/economics-artifacts.mjs). Both sides are
// TAO-denominated so the ratio is dimensionless. Null when the market cap
// input is unavailable/non-positive — this is an external, separately-loaded
// figure (not from account_events), so unlike sentiment_ratio it can be
// missing even when volume itself is zero. Unbounded (unlike sentiment_ratio):
// a high-turnover day can legitimately exceed 1.
function volMcapRatio(
  totalVolumeTao: number,
  marketCapTao: number | null | undefined,
): number | null {
  if (!Number.isFinite(marketCapTao) || (marketCapTao as number) <= 0) {
    return null;
  }
  /* v8 ignore next -- defensive: totalVolumeTao is always roundUnit's finite output */
  if (!Number.isFinite(totalVolumeTao)) return null;
  return Math.round((totalVolumeTao / (marketCapTao as number)) * 1e6) / 1e6;
}

// Convert an epoch-ms timestamp to an ISO string, or null when not finite.
// Same getTime()-range guard the other account_events scorecards use.
function coerceEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

export interface AlphaVolumeResult {
  schema_version: 1;
  netuid: number;
  window: "24h";
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
  vol_mcap_ratio: number | null;
}

// Shape a subnet's StakeAdded/StakeRemoved aggregate into a 24h volume
// scorecard. `rows` is the GROUP BY event_kind result: at most one row per kind
// carrying alpha_volume (SUM alpha_amount), tao_volume (SUM amount_tao), and
// event_count. Null-safe: no rows (cold store / empty window) yields zeroed
// totals, never throws. Volumes are unsigned (buy + sell), never netted —
// distinct from stake-flow's net_flow_tao.
export function buildAlphaVolume(
  rows: Array<Record<string, unknown>> | null | undefined,
  netuid: number,
  { marketCapTao }: { marketCapTao?: number | null } = {},
): AlphaVolumeResult {
  const list = Array.isArray(rows) ? rows : [];
  let buyAlpha = 0;
  let sellAlpha = 0;
  let buyTao = 0;
  let sellTao = 0;
  let buyCount = 0;
  let sellCount = 0;
  // Accumulate per kind so the shaper is robust to more than one row per kind,
  // not just the single-row-per-kind shape GROUP BY event_kind guarantees.
  //
  // A malformed alpha_volume/tao_volume cell zeroes that one sum but still
  // credits event_count — deliberately NOT stake-flow.mjs's buildStakeFlow,
  // which skips the whole row (including the count) on a malformed total_tao.
  // There, total_tao is the row's only signal, so a bad cell means "nothing
  // usable here." Here alpha_volume and tao_volume are two independent
  // columns on the same GROUP BY aggregate row; one of them failing to parse
  // doesn't mean the row (and its event_count) carries no information — the
  // count and the other unit's sum are still real. In production this branch
  // is unreachable anyway: both queries wrap every SUM in COALESCE(..., 0), so
  // D1 can never actually hand either shaper a null/blank amount cell.
  for (const row of list) {
    const kind = row?.event_kind;
    const alpha = nullableAmount(row?.alpha_volume) ?? 0;
    const tao = nullableAmount(row?.tao_volume) ?? 0;
    const count = toNumber(row?.event_count);
    if (kind === STAKE_ADDED_KIND) {
      buyAlpha += alpha;
      buyTao += tao;
      buyCount += count;
    } else if (kind === STAKE_REMOVED_KIND) {
      sellAlpha += alpha;
      sellTao += tao;
      sellCount += count;
    }
  }
  const netAlpha = buyAlpha - sellAlpha;
  const grossAlpha = buyAlpha + sellAlpha;
  const totalVolumeTao = roundUnit(buyTao + sellTao);
  return {
    schema_version: 1,
    netuid,
    window: "24h",
    buy_volume_alpha: roundUnit(buyAlpha),
    sell_volume_alpha: roundUnit(sellAlpha),
    total_volume_alpha: roundUnit(grossAlpha),
    buy_volume_tao: roundUnit(buyTao),
    sell_volume_tao: roundUnit(sellTao),
    total_volume_tao: totalVolumeTao,
    buy_count: buyCount,
    sell_count: sellCount,
    // Sentiment indicator (#4339/8.2), purely derived from the alpha totals
    // above — no new capture or query. See sentimentRatio/classifySentiment.
    net_volume_alpha: roundUnit(netAlpha),
    sentiment_ratio: sentimentRatio(netAlpha, grossAlpha),
    sentiment: classifySentiment(netAlpha, grossAlpha),
    // Vol/mcap ratio (#4339/8.3) — see volMcapRatio for the externally-loaded
    // marketCapTao input's null semantics.
    vol_mcap_ratio: volMcapRatio(totalVolumeTao, marketCapTao),
  };
}

// One subnet's rolling 24h buy/sell alpha volume — sums StakeAdded/StakeRemoved
// alpha_amount + amount_tao from account_events over the last 24h (observed_at
// >= now - 24h, epoch ms), grouped by kind, shaped with buildAlphaVolume. Rides
// the same (netuid, event_kind) prefix of idx_account_events_netuid_kind
// (migrations/0024) stake-flow.mjs seeks; observed_at is a residual filter.
// Returns { data, generatedAt } where generatedAt is the newest event's
// observed_at as an ISO string (string|null), matching stake-flow's contract.
// Cold/absent D1 -> zeroed totals + generatedAt null. The 3-day account_events
// retention (EVENT_RETENTION_MS, src/account-events.mjs) comfortably covers a
// 24h window.
export async function loadSubnetAlphaVolume(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  netuid: number,
  { marketCapTao }: { marketCapTao?: number | null } = {},
): Promise<{ data: AlphaVolumeResult; generatedAt: string | null }> {
  const cutoff = Date.now() - DAY_MS;
  const rows = await d1(
    "SELECT event_kind, COALESCE(SUM(alpha_amount), 0) AS alpha_volume, " +
      "COALESCE(SUM(amount_tao), 0) AS tao_volume, COUNT(*) AS event_count, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events " +
      "WHERE netuid = ? AND event_kind IN (?, ?) AND observed_at >= ? " +
      "GROUP BY event_kind",
    [netuid, STAKE_ADDED_KIND, STAKE_REMOVED_KIND, cutoff],
  );
  let latestObserved: number | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (latestObserved == null || observed > latestObserved)
    ) {
      latestObserved = observed;
    }
  }
  return {
    data: buildAlphaVolume(rows, netuid, { marketCapTao }),
    generatedAt: toIso(latestObserved),
  };
}
