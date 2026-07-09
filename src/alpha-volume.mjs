// Rolling 24h buy/sell alpha volume for one subnet (#4339/8.1): how much subnet
// alpha was bought (StakeAdded) vs sold (StakeRemoved) in the last 24 hours,
// summed from the first-party account_events stream. Pure shaping
// (buildAlphaVolume) + a thin D1 loader (loadSubnetAlphaVolume); the Worker adds
// the REST envelope. Null-safe: a cold store or an empty window yields
// schema-stable zeros (never throws), matching the sibling live tiers
// (stake-flow, turnover).
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
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A finite amount aggregate cell, or null when absent/blank/non-numeric.
function nullableAmount(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 1 TAO/alpha = 1e9 rao. Summing many REAL amount cells accumulates IEEE-754
// noise below the rao floor; round every output to rao precision, mirroring
// stake-flow.mjs's roundTao.
const RAO_PER_UNIT = 1e9;
function roundUnit(value) {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_UNIT) / RAO_PER_UNIT;
}

// Convert an epoch-ms timestamp to an ISO string, or null when not finite.
// Mirrors stake-flow.mjs's coerceEpochMs/toIso pair.
function coerceEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Shape a subnet's StakeAdded/StakeRemoved aggregate into a 24h volume
// scorecard. `rows` is the GROUP BY event_kind result: at most one row per kind
// carrying alpha_volume (SUM alpha_amount), tao_volume (SUM amount_tao), and
// event_count. Null-safe: no rows (cold store / empty window) yields zeroed
// totals, never throws. Volumes are unsigned (buy + sell), never netted —
// distinct from stake-flow's net_flow_tao.
export function buildAlphaVolume(rows, netuid) {
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
  return {
    schema_version: 1,
    netuid,
    window: "24h",
    buy_volume_alpha: roundUnit(buyAlpha),
    sell_volume_alpha: roundUnit(sellAlpha),
    total_volume_alpha: roundUnit(buyAlpha + sellAlpha),
    buy_volume_tao: roundUnit(buyTao),
    sell_volume_tao: roundUnit(sellTao),
    total_volume_tao: roundUnit(buyTao + sellTao),
    buy_count: buyCount,
    sell_count: sellCount,
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
export async function loadSubnetAlphaVolume(d1, netuid) {
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
  let latestObserved = null;
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
    data: buildAlphaVolume(rows, netuid),
    generatedAt: toIso(latestObserved),
  };
}
