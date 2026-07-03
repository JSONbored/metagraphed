// Network-wide native-TAO transfer-pair analytics: over a recent window, which
// sender -> receiver corridors dominate Balances.Transfer flow. This is the pair
// companion to /chain/transfers (top individual senders/receivers) and
// /accounts/{ss58}/counterparties (one account's local relationships).
// Null-safe: a cold store or empty window yields a zeroed card.

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSFER_KIND = "Transfer";

export const CHAIN_TRANSFER_PAIR_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW = "7d";
export const CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT = 25;
export const CHAIN_TRANSFER_PAIR_LIMIT_MAX = 100;
export const CHAIN_TRANSFER_PAIR_SORTS = ["volume", "count"];

const RAO_PER_TAO = 1e9;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toCount(value) {
  return Math.max(0, Math.trunc(toNumber(value)));
}

function toBlockNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function roundTao(value) {
  const n = toNumber(value);
  return Math.round(n * RAO_PER_TAO) / RAO_PER_TAO;
}

function toNonNegativeTao(value) {
  return Math.max(0, roundTao(value));
}

function toIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function normalizeSort(sort) {
  return CHAIN_TRANSFER_PAIR_SORTS.includes(sort) ? sort : "volume";
}

function shapePairs(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const from = typeof row?.from === "string" ? row.from : row?.from_address;
      const to = typeof row?.to === "string" ? row.to : row?.to_address;
      return { row, from, to };
    })
    .filter(
      ({ from, to }) =>
        typeof from === "string" &&
        from.length > 0 &&
        typeof to === "string" &&
        to.length > 0 &&
        from !== to,
    )
    .map(({ row, from, to }) => ({
      from,
      to,
      volume_tao: toNonNegativeTao(row.volume_tao),
      transfer_count: toCount(row.transfer_count),
      last_block: toBlockNumber(row.last_block),
      last_observed_at: toIso(row.last_observed_at),
    }));
}

export function buildChainTransferPairs({
  window,
  sort = "volume",
  observedAt = null,
  totals = null,
  pairs = [],
} = {}) {
  const topPairs = shapePairs(pairs);
  const totalVolume = toNonNegativeTao(totals?.total_volume_tao);
  const hasFullWindowTopPairVolume = Object.prototype.hasOwnProperty.call(
    totals ?? {},
    "top_pair_volume_tao",
  );
  const returnedTopPairVolume = topPairs.reduce(
    (max, pair) => Math.max(max, pair.volume_tao),
    0,
  );
  const topPairVolume = hasFullWindowTopPairVolume
    ? toNonNegativeTao(totals.top_pair_volume_tao)
    : returnedTopPairVolume;
  const topPairShare =
    totalVolume > 0
      ? Math.round((topPairVolume / totalVolume) * 10000) / 10000
      : null;

  return {
    schema_version: 1,
    window: window ?? null,
    sort: normalizeSort(sort),
    observed_at: observedAt,
    total_volume_tao: totalVolume,
    transfer_count: toCount(totals?.transfer_count),
    unique_pairs: toCount(totals?.unique_pairs),
    pair_count: topPairs.length,
    top_pair_share: topPairShare,
    pairs: topPairs,
  };
}

const PAIR_FILTER =
  "event_kind = ? AND observed_at >= ? AND hotkey IS NOT NULL AND coldkey IS NOT NULL " +
  "AND hotkey <> '' AND coldkey <> '' AND hotkey <> coldkey " +
  "AND amount_tao IS NOT NULL AND amount_tao >= 0";

export async function loadChainTransferPairs(
  d1,
  {
    windowLabel = DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
    windowDays,
    observedAt = null,
    limit = CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
    sort = "volume",
  } = {},
) {
  const effectiveWindowLabel = Object.prototype.hasOwnProperty.call(
    CHAIN_TRANSFER_PAIR_WINDOWS,
    windowLabel,
  )
    ? windowLabel
    : DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW;
  const rawDays =
    windowDays ?? CHAIN_TRANSFER_PAIR_WINDOWS[effectiveWindowLabel];
  const days = Math.max(1, toCount(rawDays));
  const cutoff = Date.now() - days * DAY_MS;
  const sortBy = normalizeSort(sort);
  const boundedLimit = Math.min(
    CHAIN_TRANSFER_PAIR_LIMIT_MAX,
    Math.max(1, toCount(limit)),
  );

  const totalsRows = await d1(
    "WITH pair_totals AS (" +
      "SELECT hotkey, coldkey, SUM(amount_tao) AS volume_tao, COUNT(*) AS transfer_count " +
      `FROM account_events WHERE ${PAIR_FILTER} GROUP BY hotkey, coldkey` +
      ") " +
      "SELECT COALESCE(SUM(transfer_count), 0) AS transfer_count, " +
      "COALESCE(SUM(volume_tao), 0) AS total_volume_tao, " +
      "COUNT(*) AS unique_pairs, " +
      "COALESCE(MAX(volume_tao), 0) AS top_pair_volume_tao FROM pair_totals",
    [TRANSFER_KIND, cutoff],
  );

  const orderBy =
    sortBy === "count"
      ? "transfer_count DESC, volume_tao DESC, hotkey ASC, coldkey ASC"
      : "volume_tao DESC, transfer_count DESC, hotkey ASC, coldkey ASC";
  const pairRows = await d1(
    "SELECT hotkey AS from_address, coldkey AS to_address, SUM(amount_tao) AS volume_tao, " +
      "COUNT(*) AS transfer_count, MAX(block_number) AS last_block, " +
      `MAX(observed_at) AS last_observed_at FROM account_events WHERE ${PAIR_FILTER} ` +
      `GROUP BY hotkey, coldkey ORDER BY ${orderBy} LIMIT ?`,
    [TRANSFER_KIND, cutoff, boundedLimit],
  );

  return buildChainTransferPairs({
    window: effectiveWindowLabel,
    sort: sortBy,
    observedAt,
    totals: Array.isArray(totalsRows) ? totalsRows[0] : null,
    pairs: pairRows,
  });
}
