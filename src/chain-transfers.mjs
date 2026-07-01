// Network-wide native-TAO transfer analytics: over a recent window, how much TAO moved
// via Balances.Transfer across the whole chain, who moved the most out (top senders) and
// in (top receivers), and how concentrated that flow is among the top accounts. Pure
// shaping (buildChainTransfers) + a thin D1 loader (loadChainTransfers) over the
// account_events Transfer feed; the Worker adds the REST envelope. The network-level
// companion of the per-account /accounts/{ss58}/transfers + /counterparties routes.
// Windowed by wall-clock (account_events is a live stream). Null-safe: a cold store or an
// empty window yields zeroed totals + empty leaderboards (never throws).

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSFER_KIND = "Transfer";

// Supported windows (label -> days), the same set + default the sibling /chain/* analytics
// use (config.mjs ANALYTICS_WINDOWS / DEFAULT_ANALYTICS_WINDOW).
export const CHAIN_TRANSFER_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_TRANSFER_WINDOW = "7d";
export const CHAIN_TRANSFER_LIMIT_DEFAULT = 25;
export const CHAIN_TRANSFER_LIMIT_MAX = 100;

// 1 TAO = 1e9 rao; round every TAO output to that precision to shed IEEE-754 noise from
// summing many REAL amount_tao values (the same rounding the chain/fees market applies).
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  const n = toNumber(value);
  return Math.round(n * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite number.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A whole non-negative count (D1 COUNT is integer; truncate defensively for direct callers).
function toCount(value) {
  return Math.max(0, Math.trunc(toNumber(value)));
}

// Shape one side's leaderboard rows (address + summed volume + transfer count) into a
// ranked list. Drops rows with a missing address so a NULL sender/receiver cannot leak in.
function shapeParties(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => typeof row?.address === "string" && row.address.length > 0)
    .map((row) => ({
      address: row.address,
      volume_tao: roundTao(row?.volume_tao),
      transfer_count: toCount(row?.transfer_count),
    }));
}

// Shape the network transfer scorecard. `totals` is the single-row aggregate (count,
// volume, distinct senders/receivers); `senders`/`receivers` are the pre-ranked top-N
// GROUP BY results. top_sender_share is the fetched top senders' share of total volume —
// a concentration signal (near 1 = a few accounts dominate outflow, near 0 = diffuse).
// Null-safe: absent aggregates/rows collapse to a zeroed, empty-leaderboard card.
export function buildChainTransfers({
  window,
  observedAt = null,
  totals = null,
  senders = [],
  receivers = [],
} = {}) {
  const totalVolume = roundTao(totals?.total_volume_tao);
  const topSenders = shapeParties(senders);
  const topReceivers = shapeParties(receivers);
  const topSenderVolume = topSenders.reduce((sum, s) => sum + s.volume_tao, 0);
  const topSenderShare =
    totalVolume > 0
      ? Math.round((topSenderVolume / totalVolume) * 10000) / 10000
      : null;
  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    total_volume_tao: totalVolume,
    transfer_count: toCount(totals?.transfer_count),
    unique_senders: toCount(totals?.unique_senders),
    unique_receivers: toCount(totals?.unique_receivers),
    top_sender_share: topSenderShare,
    top_senders: topSenders,
    top_receivers: topReceivers,
  };
}

// Load the network transfer analytics: a totals aggregate plus the top senders (by hotkey)
// and top receivers (by coldkey) over the window, from the account_events Transfer feed
// (observed_at >= now - windowDays). observedAt (the refresh cron's last_run_at) stamps
// provenance. Cold/absent D1 -> zeroed card.
export async function loadChainTransfers(
  d1,
  {
    windowLabel = DEFAULT_CHAIN_TRANSFER_WINDOW,
    windowDays,
    observedAt = null,
    limit = CHAIN_TRANSFER_LIMIT_DEFAULT,
  } = {},
) {
  const days =
    windowDays ??
    CHAIN_TRANSFER_WINDOWS[windowLabel] ??
    CHAIN_TRANSFER_WINDOWS[DEFAULT_CHAIN_TRANSFER_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;

  const totalsRows = await d1(
    "SELECT COUNT(*) AS transfer_count, " +
      "COALESCE(SUM(amount_tao), 0) AS total_volume_tao, " +
      "COUNT(DISTINCT hotkey) AS unique_senders, " +
      "COUNT(DISTINCT coldkey) AS unique_receivers " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ?",
    [TRANSFER_KIND, cutoff],
  );
  const senders = await d1(
    "SELECT hotkey AS address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count FROM account_events " +
      "WHERE event_kind = ? AND observed_at >= ? AND hotkey IS NOT NULL " +
      "GROUP BY hotkey ORDER BY volume_tao DESC, hotkey ASC LIMIT ?",
    [TRANSFER_KIND, cutoff, limit],
  );
  const receivers = await d1(
    "SELECT coldkey AS address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count FROM account_events " +
      "WHERE event_kind = ? AND observed_at >= ? AND coldkey IS NOT NULL " +
      "GROUP BY coldkey ORDER BY volume_tao DESC, coldkey ASC LIMIT ?",
    [TRANSFER_KIND, cutoff, limit],
  );

  return buildChainTransfers({
    window: windowLabel,
    observedAt,
    totals: Array.isArray(totalsRows) ? totalsRows[0] : null,
    senders,
    receivers,
  });
}
