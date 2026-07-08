// Network-wide account directory: wallets grouped by ss58 across every current
// neuron membership plus account_events activity aggregates (#4327). Pure +
// exported for tests; the Worker handlers run the D1 queries and call these builders.

export const GLOBAL_ACCOUNT_SORTS = [
  "event_count",
  "hotkey_count",
  "last_update_at",
  "stake_dominance",
  "subnet_count",
  "total_emission",
  "total_stake",
  "uid_count",
  "validator_count",
];
export const DEFAULT_GLOBAL_ACCOUNT_SORT = "total_stake";
export const GLOBAL_ACCOUNT_LIMIT_DEFAULT = 20;
export const GLOBAL_ACCOUNT_LIMIT_MAX = 100;
const GLOBAL_ACCOUNT_SUBNET_LIMIT = 10;
const RAO_PER_TAO = 1e9;

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeInt(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function roundTao(value) {
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

function toRaoBig(tao) {
  return BigInt(Math.round(numberOrZero(tao) * RAO_PER_TAO));
}

function raoBigToTao(rao) {
  return Number(rao) / RAO_PER_TAO;
}

function maxEpochMs(a, b) {
  const left = a == null ? null : Number(a);
  const right = b == null ? null : Number(b);
  if (left != null && Number.isFinite(left) && left > 0) {
    if (right != null && Number.isFinite(right) && right > 0) {
      return Math.max(left, right);
    }
    return left;
  }
  if (right != null && Number.isFinite(right) && right > 0) {
    return right;
  }
  return null;
}

function buildGlobalAccountEntry(entry) {
  const subnets = entry.subnets
    .sort(
      (a, b) =>
        b.stake_tao - a.stake_tao ||
        b.emission_tao - a.emission_tao ||
        a.netuid - b.netuid ||
        a.uid - b.uid,
    )
    .slice(0, GLOBAL_ACCOUNT_SUBNET_LIMIT);
  const lastUpdateAt = maxEpochMs(entry.lastSeenAt, entry.latestCapturedAt);
  return {
    ss58: entry.ss58,
    hotkey_count: entry.hotkeys.size,
    subnet_count: entry.netuids.size,
    uid_count: entry.uidCount,
    validator_count: entry.validatorCount,
    delegated_stake_tao: roundTao(raoBigToTao(entry.stakeTotalRao)),
    total_emission_tao: roundTao(raoBigToTao(entry.emissionTotalRao)),
    event_count: entry.eventCount,
    stake_dominance: null,
    last_seen_at: toIso(entry.lastSeenAt),
    latest_captured_at: toIso(entry.latestCapturedAt),
    last_update_at: toIso(lastUpdateAt),
    latest_block_number: entry.latestBlockNumber,
    subnets,
  };
}

function applyStakeDominance(accounts) {
  const networkStakeRao = accounts.reduce(
    (sum, entry) => sum + toRaoBig(entry.delegated_stake_tao),
    0n,
  );
  const networkStakeTotal = raoBigToTao(networkStakeRao);
  if (!(networkStakeTotal > 0) || !Number.isFinite(networkStakeTotal)) {
    return accounts.map((entry) => ({ ...entry, stake_dominance: null }));
  }
  return accounts.map((entry) => ({
    ...entry,
    stake_dominance: round(
      numberOrZero(entry.delegated_stake_tao) / networkStakeTotal,
    ),
  }));
}

const GLOBAL_ACCOUNT_SORT_FIELDS = {
  total_stake: "delegated_stake_tao",
  total_emission: "total_emission_tao",
};

function accountSortValue(row, key) {
  if (key === "last_update_at") {
    const value = row?.last_update_at;
    if (typeof value !== "string" || value.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  }
  const field = GLOBAL_ACCOUNT_SORT_FIELDS[key] ?? key;
  const value = row?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

function eventAggregateMap(eventRows) {
  const map = new Map();
  for (const row of Array.isArray(eventRows) ? eventRows : []) {
    const coldkey =
      typeof row?.coldkey === "string" && row.coldkey.length > 0
        ? row.coldkey
        : null;
    if (!coldkey) continue;
    map.set(coldkey, {
      eventCount: nonNegativeInt(row?.event_count) ?? 0,
      lastSeenAt: nullableNumber(row?.last_seen_at),
      lastBlock: nonNegativeInt(row?.last_block),
    });
  }
  return map;
}

function nullableNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ensureAccountEntry(accountsByColdkey, coldkey) {
  let entry = accountsByColdkey.get(coldkey);
  if (!entry) {
    entry = {
      ss58: coldkey,
      hotkeys: new Set(),
      netuids: new Set(),
      uidCount: 0,
      validatorCount: 0,
      stakeTotalRao: 0n,
      emissionTotalRao: 0n,
      eventCount: 0,
      lastSeenAt: null,
      latestCapturedAt: null,
      latestBlockNumber: null,
      subnets: [],
    };
    accountsByColdkey.set(coldkey, entry);
  }
  return entry;
}

export function buildGlobalAccounts(
  neuronRows,
  eventRows,
  {
    sort = DEFAULT_GLOBAL_ACCOUNT_SORT,
    limit = GLOBAL_ACCOUNT_LIMIT_DEFAULT,
  } = {},
) {
  const normalizedSort = GLOBAL_ACCOUNT_SORTS.includes(sort)
    ? sort
    : DEFAULT_GLOBAL_ACCOUNT_SORT;
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, GLOBAL_ACCOUNT_LIMIT_MAX))
    : GLOBAL_ACCOUNT_LIMIT_DEFAULT;
  const eventsByColdkey = eventAggregateMap(eventRows);
  const accountsByColdkey = new Map();
  let latestCapturedAt = null;
  let latestBlockNumber = null;

  for (const row of Array.isArray(neuronRows) ? neuronRows : []) {
    const coldkey =
      typeof row?.coldkey === "string" && row.coldkey.length > 0
        ? row.coldkey
        : null;
    const hotkey =
      typeof row?.hotkey === "string" && row.hotkey.length > 0
        ? row.hotkey
        : null;
    const netuid = nonNegativeInt(row?.netuid);
    const uid = nonNegativeInt(row?.uid);
    if (!coldkey || netuid == null || uid == null) continue;

    const stake = numberOrZero(row?.stake_tao);
    const emission = numberOrZero(row?.emission_tao);
    const capturedAt = nullableNumber(row?.captured_at);
    const blockNumber = nonNegativeInt(row?.block_number);
    const entry = ensureAccountEntry(accountsByColdkey, coldkey);
    if (hotkey) entry.hotkeys.add(hotkey);
    entry.netuids.add(netuid);
    entry.uidCount += 1;
    if (row?.validator_permit === 1 || row?.validator_permit === true) {
      entry.validatorCount += 1;
    }
    entry.stakeTotalRao += toRaoBig(stake);
    entry.emissionTotalRao += toRaoBig(emission);
    if (capturedAt != null) {
      if (
        entry.latestCapturedAt == null ||
        capturedAt > entry.latestCapturedAt ||
        (capturedAt === entry.latestCapturedAt &&
          blockNumber != null &&
          (entry.latestBlockNumber == null ||
            blockNumber > entry.latestBlockNumber))
      ) {
        entry.latestCapturedAt = capturedAt;
        entry.latestBlockNumber = blockNumber;
      }
      if (
        latestCapturedAt == null ||
        capturedAt > latestCapturedAt ||
        (capturedAt === latestCapturedAt &&
          blockNumber != null &&
          (latestBlockNumber == null || blockNumber > latestBlockNumber))
      ) {
        latestCapturedAt = capturedAt;
        latestBlockNumber = blockNumber;
      }
    }
    entry.subnets.push({
      netuid,
      uid,
      hotkey,
      stake_tao: roundTao(stake),
      emission_tao: roundTao(emission),
    });
  }

  for (const [coldkey, eventAgg] of eventsByColdkey) {
    const entry = ensureAccountEntry(accountsByColdkey, coldkey);
    entry.eventCount = eventAgg.eventCount;
    entry.lastSeenAt = eventAgg.lastSeenAt;
    if (
      eventAgg.lastBlock != null &&
      (entry.latestBlockNumber == null ||
        eventAgg.lastBlock > entry.latestBlockNumber)
    ) {
      entry.latestBlockNumber = eventAgg.lastBlock;
    }
  }

  const accounts = applyStakeDominance(
    [...accountsByColdkey.values()].map(buildGlobalAccountEntry),
  ).sort(
    (a, b) =>
      accountSortValue(b, normalizedSort) -
        accountSortValue(a, normalizedSort) || a.ss58.localeCompare(b.ss58),
  );

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: toIso(latestCapturedAt),
    block_number: latestBlockNumber,
    account_count: accounts.length,
    accounts: accounts.slice(0, normalizedLimit),
  };
}

export async function loadGlobalAccounts(
  d1,
  {
    sort = DEFAULT_GLOBAL_ACCOUNT_SORT,
    limit = GLOBAL_ACCOUNT_LIMIT_DEFAULT,
  } = {},
) {
  const neuronRows = await d1(
    "SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, " +
      "stake_tao, block_number, captured_at FROM neurons " +
      "WHERE coldkey IS NOT NULL AND coldkey != '' " +
      "ORDER BY coldkey ASC, stake_tao DESC, netuid ASC, uid ASC",
    [],
  );
  const eventRows = await d1(
    "SELECT coldkey, COUNT(*) AS event_count, MAX(observed_at) AS last_seen_at, " +
      "MAX(block_number) AS last_block FROM account_events " +
      "WHERE coldkey IS NOT NULL AND coldkey != '' GROUP BY coldkey",
    [],
  );
  return buildGlobalAccounts(neuronRows, eventRows, { sort, limit });
}
