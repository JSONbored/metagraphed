// Per-account stake-transfer footprint: which subnets one account (origin sender)
// transferred stake out of over a recent window, broken down per subnet and rolled
// up into a transfer scorecard. Pure shaping (buildAccountStakeTransfers) + a thin
// D1 loader (loadAccountStakeTransfers); the Worker adds the REST envelope.
// Null-safe: a cold store or an empty window yields schema-stable zeros.
//
// This is the account-level companion of /api/v1/chain/stake-transfers and
// /api/v1/subnets/{netuid}/stake-transfers. StakeTransferred relocates staked
// alpha from one account to another on the same hotkey (origin leg only), so this
// measures between-account ownership moves, not re-delegation churn or net capital
// flow. The sender is the origin account recorded on account_events.

const DAY_MS = 24 * 60 * 60 * 1000;

export const STAKE_TRANSFERRED_EVENT_KIND = "StakeTransferred";
export const ACCOUNT_STAKE_TRANSFERS_WINDOWS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_ACCOUNT_STAKE_TRANSFERS_WINDOW = "30d";

function roundConcentration(value) {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded >= 1 && value < 1 ? 0.9999 : rounded;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

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

export function buildAccountStakeTransfers(rows, address, { window } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const perSubnet = new Map();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const transfers = toCount(row?.transfers);
    if (transfers === 0) continue;
    const firstMs = coerceEpochMs(row?.first_observed);
    const lastMs = coerceEpochMs(row?.last_observed);
    const bucket = perSubnet.get(netuid) ?? {
      transfers: 0,
      firstMs: null,
      lastMs: null,
    };
    bucket.transfers += transfers;
    if (
      firstMs != null &&
      (bucket.firstMs == null || firstMs < bucket.firstMs)
    ) {
      bucket.firstMs = firstMs;
    }
    if (lastMs != null && (bucket.lastMs == null || lastMs > bucket.lastMs)) {
      bucket.lastMs = lastMs;
    }
    perSubnet.set(netuid, bucket);
  }

  let totalTransfers = 0;
  let squares = 0;
  const subnets = [];
  for (const [netuid, bucket] of perSubnet) {
    totalTransfers += bucket.transfers;
    squares += bucket.transfers * bucket.transfers;
    subnets.push({
      netuid,
      transfers: bucket.transfers,
      first_transferred_at:
        bucket.firstMs == null ? null : new Date(bucket.firstMs).toISOString(),
      last_transferred_at:
        bucket.lastMs == null ? null : new Date(bucket.lastMs).toISOString(),
    });
  }
  subnets.sort((a, b) => b.transfers - a.transfers || a.netuid - b.netuid);

  const concentration =
    totalTransfers > 0
      ? roundConcentration(squares / (totalTransfers * totalTransfers))
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_transfers: totalTransfers,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: subnets.length > 0 ? subnets[0].netuid : null,
    subnets,
  };
}

export async function loadAccountStakeTransfers(
  d1,
  address,
  { windowLabel = DEFAULT_ACCOUNT_STAKE_TRANSFERS_WINDOW } = {},
) {
  const days =
    ACCOUNT_STAKE_TRANSFERS_WINDOWS[windowLabel] ??
    ACCOUNT_STAKE_TRANSFERS_WINDOWS[DEFAULT_ACCOUNT_STAKE_TRANSFERS_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COUNT(*) AS transfers, MIN(observed_at) AS first_observed, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY idx_account_events_coldkey " +
      "WHERE coldkey = ? AND event_kind = ? AND observed_at >= ? GROUP BY netuid",
    [address, STAKE_TRANSFERRED_EVENT_KIND, cutoff],
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
    data: buildAccountStakeTransfers(rows, address, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
