// Per-subnet native-TAO transfer analytics: over a recent window, how much TAO moved
// via Balances.Transfer among accounts currently registered on one subnet, who sent
// and received the most, and how concentrated outflow is among the top accounts.
// Pure shaping (buildSubnetTransferVolume) + a thin D1 loader (loadSubnetTransferVolume)
// over the account_events Transfer feed; the Worker adds the REST envelope.
//
// Balances.Transfer rows carry no netuid (scripts/fetch-events.py _transfer) — unlike
// StakeAdded/StakeRemoved — so attribution joins the current neurons snapshot: a transfer
// counts toward netuid N when the sender or recipient hotkey is registered on N.
// Windowed by wall-clock (account_events is a live stream). Null-safe: a cold store or
// an empty window yields zeroed totals + empty leaderboards (never throws).

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRANSFER_KIND = "Transfer";
const TRANSFER_KIND_OBSERVED_INDEX = "idx_account_events_kind_observed";
const TRANSFER_KIND_OBSERVED_HOTKEY_INDEX =
  "idx_account_events_kind_observed_hotkey";
const TRANSFER_KIND_OBSERVED_COLDKEY_INDEX =
  "idx_account_events_kind_observed_coldkey";

// Supported windows (label -> days), the same set the stake-flow route exposes so
// per-subnet capital-movement analytics stay consistent. Unsupported labels are
// normalized here for direct/internal callers; the Worker handler rejects them with 400.
export const SUBNET_TRANSFER_VOLUME_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW = "30d";
export const SUBNET_TRANSFER_LIMIT_DEFAULT = 20;
export const SUBNET_TRANSFER_LIMIT_MAX = 100;

// Transfers attributed to a subnet when either party is a current hotkey on that netuid.
const TRANSFER_MEMBERSHIP_CLAUSE =
  "(hotkey IN (SELECT hotkey FROM neurons WHERE netuid = ? AND hotkey IS NOT NULL) " +
  "OR coldkey IN (SELECT hotkey FROM neurons WHERE netuid = ? AND hotkey IS NOT NULL))";

// Leaderboards and distinct sender/receiver counts only include registered subnet hotkeys
// (the neurons snapshot stores operator hotkeys). External counterparties in an attributed
// transfer — e.g. a subnet account paying an off-subnet address — must not appear as
// top_receivers just because the transfer matched the membership filter.
const NEURON_HOTKEYS_SUBQUERY =
  "SELECT hotkey FROM neurons WHERE netuid = ? AND hotkey IS NOT NULL";

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

function observedAtIsoFromTotals(totals) {
  const raw = totals?.last_observed;
  if (raw == null || raw === "") return null;
  const ms = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function resolveWindowLabel(windowLabel) {
  return Object.hasOwn(SUBNET_TRANSFER_VOLUME_WINDOWS, windowLabel)
    ? windowLabel
    : DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW;
}

function resolveLimit(limit) {
  const parsed = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return SUBNET_TRANSFER_LIMIT_DEFAULT;
  return Math.max(1, Math.min(Math.trunc(parsed), SUBNET_TRANSFER_LIMIT_MAX));
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
      ? Math.min(1, Math.round((topSenderVolume / totalVolume) * 10000) / 10000)
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
// (outgoing, by registered hotkey) and top receivers (incoming, by registered hotkey)
// over the window, from the account_events Transfer feed attributed via the neurons
// snapshot. Returns { data, generatedAt } where generatedAt is the newest event's
// observed_at as an ISO string (string|null per the envelope contract). Cold/absent D1
// -> zeroed card.
export async function loadSubnetTransferVolume(
  d1,
  netuid,
  {
    windowLabel = DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW,
    limit = SUBNET_TRANSFER_LIMIT_DEFAULT,
    nowMs = Date.now(),
  } = {},
) {
  const canonicalWindow = resolveWindowLabel(windowLabel);
  const days = SUBNET_TRANSFER_VOLUME_WINDOWS[canonicalWindow];
  const cutoff = nowMs - days * DAY_MS;
  const cap = resolveLimit(limit);

  const totalsRows = await d1(
    "SELECT COUNT(*) AS transfer_count, " +
      "COALESCE(SUM(amount_tao), 0) AS total_volume_tao, " +
      "COUNT(DISTINCT CASE WHEN hotkey IN (" +
      NEURON_HOTKEYS_SUBQUERY +
      ") THEN hotkey END) AS unique_senders, " +
      "COUNT(DISTINCT CASE WHEN coldkey IN (" +
      NEURON_HOTKEYS_SUBQUERY +
      ") THEN coldkey END) AS unique_receivers, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY " +
      TRANSFER_KIND_OBSERVED_INDEX +
      " " +
      "WHERE event_kind = ? AND observed_at >= ? AND " +
      TRANSFER_MEMBERSHIP_CLAUSE,
    [netuid, netuid, TRANSFER_KIND, cutoff, netuid, netuid],
  );
  const senders = await d1(
    "SELECT hotkey AS address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count FROM account_events INDEXED BY " +
      TRANSFER_KIND_OBSERVED_HOTKEY_INDEX +
      " " +
      "WHERE event_kind = ? AND observed_at >= ? AND hotkey IN (" +
      NEURON_HOTKEYS_SUBQUERY +
      ") GROUP BY hotkey ORDER BY volume_tao DESC, hotkey ASC LIMIT ?",
    [TRANSFER_KIND, cutoff, netuid, cap],
  );
  const receivers = await d1(
    "SELECT coldkey AS address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count FROM account_events INDEXED BY " +
      TRANSFER_KIND_OBSERVED_COLDKEY_INDEX +
      " " +
      "WHERE event_kind = ? AND observed_at >= ? AND coldkey IN (" +
      NEURON_HOTKEYS_SUBQUERY +
      ") GROUP BY coldkey ORDER BY volume_tao DESC, coldkey ASC LIMIT ?",
    [TRANSFER_KIND, cutoff, netuid, cap],
  );

  const totals = Array.isArray(totalsRows) ? totalsRows[0] : null;
  return {
    data: buildSubnetTransferVolume({
      netuid,
      window: canonicalWindow,
      totals,
      senders,
      receivers,
    }),
    generatedAt: observedAtIsoFromTotals(totals),
  };
}
