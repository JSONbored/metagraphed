// Per-subnet native-TAO transfer analytics: over a recent window, how much TAO moved
// via Balances.Transfer within one subnet, who sent and received the most, and how
// concentrated outflow is among the top accounts. Pure shaping (buildSubnetTransferVolume)
// + a thin D1 loader (loadSubnetTransferVolume) over the account_events Transfer feed
// filtered by netuid; the Worker adds the REST envelope. The per-subnet companion of
// the network-wide /chain/transfers route and the per-account /accounts/{ss58}/transfers
// + /counterparties routes. Windowed by wall-clock (account_events is a live stream).
// Null-safe: a cold store or an empty window yields zeroed totals + empty leaderboards
// (never throws), mirroring the sibling stake-flow route.

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRANSFER_KIND = "Transfer";

// Supported windows (label -> days), the same set the stake-flow route exposes so
// per-subnet capital-movement analytics stay consistent.
export const SUBNET_TRANSFER_VOLUME_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW = "30d";
export const SUBNET_TRANSFER_LIMIT_DEFAULT = 20;
export const SUBNET_TRANSFER_LIMIT_MAX = 100;

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

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

// Shape the per-subnet transfer scorecard. `totals` is the single-row aggregate (count,
// volume, distinct senders/receivers); `senders`/`receivers` are the pre-ranked top-N
// GROUP BY results. top_sender_share is the fetched top senders' share of total volume —
// a concentration signal (near 1 = a few accounts dominate outflow, near 0 = diffuse).
// Null-safe: absent aggregates/rows collapse to a zeroed, empty-leaderboard card.
export function buildSubnetTransferVolume({
  netuid,
  window,
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
    netuid,
    window: window ?? null,
    total_volume_tao: totalVolume,
    transfer_count: toCount(totals?.transfer_count),
    unique_senders: toCount(totals?.unique_senders),
    unique_receivers: toCount(totals?.unique_receivers),
    top_sender_share: topSenderShare,
    top_senders: topSenders,
    top_receivers: topReceivers,
  };
}

// One subnet's native-TAO transfer analytics: a totals aggregate plus the top senders
// (by hotkey) and top receivers (by coldkey) over the window, from the account_events
// Transfer feed (netuid + event_kind + observed_at >= now - windowDays). Returns
// { data, generatedAt } where generatedAt is the newest event's observed_at as an ISO
// string (string|null per the envelope contract). Cold/absent D1 -> zeroed card.
export async function loadSubnetTransferVolume(
  d1,
  netuid,
  {
    windowLabel = DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW,
    limit = SUBNET_TRANSFER_LIMIT_DEFAULT,
  } = {},
) {
  const days =
    SUBNET_TRANSFER_VOLUME_WINDOWS[windowLabel] ??
    SUBNET_TRANSFER_VOLUME_WINDOWS[DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const cap = Math.max(1, Math.min(limit, SUBNET_TRANSFER_LIMIT_MAX));

  const totalsRows = await d1(
    "SELECT COUNT(*) AS transfer_count, " +
      "COALESCE(SUM(amount_tao), 0) AS total_volume_tao, " +
      "COUNT(DISTINCT hotkey) AS unique_senders, " +
      "COUNT(DISTINCT coldkey) AS unique_receivers, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events " +
      "WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, TRANSFER_KIND, cutoff],
  );
  const senders = await d1(
    "SELECT hotkey AS address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count FROM account_events " +
      "WHERE netuid = ? AND event_kind = ? AND observed_at >= ? AND hotkey IS NOT NULL " +
      "GROUP BY hotkey ORDER BY volume_tao DESC, hotkey ASC LIMIT ?",
    [netuid, TRANSFER_KIND, cutoff, cap],
  );
  const receivers = await d1(
    "SELECT coldkey AS address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count FROM account_events " +
      "WHERE netuid = ? AND event_kind = ? AND observed_at >= ? AND coldkey IS NOT NULL " +
      "GROUP BY coldkey ORDER BY volume_tao DESC, coldkey ASC LIMIT ?",
    [netuid, TRANSFER_KIND, cutoff, cap],
  );

  const totals = Array.isArray(totalsRows) ? totalsRows[0] : null;
  const lastObserved = Number(totals?.last_observed);
  return {
    data: buildSubnetTransferVolume({
      netuid,
      window: windowLabel,
      totals,
      senders,
      receivers,
    }),
    generatedAt: Number.isFinite(lastObserved) ? toIso(lastObserved) : null,
  };
}
