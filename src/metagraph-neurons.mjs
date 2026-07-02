// Shape D1 `neurons` rows (migration 0007, populated by the refresh-metagraph
// cron from Taostats) into the per-UID metagraph API responses for #1304/#1305
// (epic #1302). Pure + exported for tests; the Worker handlers run the D1 query
// and call these builders.

// The columns the handlers SELECT for a neuron row.
export const NEURON_COLUMNS =
  "uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, " +
  "consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, " +
  "is_immunity_period, axon, block_number, captured_at";

// The full column set written to the neurons table (matches migration 0007 and
// the normalizeNeuron row shape). Used by the cron's parameterized bulk load
// (loadStagedNeurons) — values are always bound, never interpolated into SQL.
export const NEURON_INSERT_COLUMNS = [
  "netuid",
  "uid",
  "hotkey",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
  "block_number",
  "captured_at",
];

export const GLOBAL_VALIDATOR_SORTS = [
  "subnet_count",
  "uid_count",
  "avg_validator_trust",
  "max_validator_trust",
];
export const DEFAULT_GLOBAL_VALIDATOR_SORT = "subnet_count";
export const GLOBAL_VALIDATOR_LIMIT_DEFAULT = 20;
export const GLOBAL_VALIDATOR_LIMIT_MAX = 100;
const GLOBAL_VALIDATOR_SUBNET_LIMIT = 10;
const RAO_PER_TAO = 1e9;

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value) {
  // Guard null first: Number(null) === 0, so a null column (block_number is a
  // nullable INTEGER) would masquerade as the real chain height / netuid / uid 0
  // instead of "absent". A numeric string like "10" from D1 must still pass.
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function roundTao(value) {
  return Math.round(numberOrZero(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

function round(value, dp = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// Coerce a D1 0/1 INTEGER flag cell to a boolean. Numeric strings like "0"
// must not pass through Boolean(), which treats any non-empty string as true.
// Mirrors the local toD1Flag added to formatRegistration by #2487.
function toD1Flag(value) {
  return Number(value) === 1;
}

// coerce the flag columns back to real booleans for the API (toD1Flag
// handles the D1 INTEGER 0/1 cells; nonNegativeInt/nullableNumber coerce
// string-typed uid/registered_at_block into real integers, and roundTao
// rounds stake_tao / emission_tao to rao precision). The explicit null
// guards preserve the previous null-on-missing contract: Number(null) is
// 0 (not NaN), so nonNegativeInt(null) / nullableNumber(null) / roundTao(null)
// would otherwise serialize as 0 instead of null. roundTao itself falls
// back to numberOrZero(0) for null/non-finite, so the wrapping guards here
// are what keep "missing cell" cells flowing through as null. Mirrors the
// proven toBlockNumber / toTaoOrNull null-guards in account-events.mjs
// (#2487).
export function formatNeuron(row) {
  if (!row || typeof row !== "object") return null;
  return {
    uid: row.uid == null ? null : nonNegativeInt(row.uid),
    hotkey: row.hotkey ?? null,
    coldkey: row.coldkey ?? null,
    active: toD1Flag(row.active),
    validator_permit: toD1Flag(row.validator_permit),
    rank: row.rank ?? null,
    trust: row.trust ?? null,
    validator_trust: row.validator_trust ?? null,
    consensus: row.consensus ?? null,
    incentive: row.incentive ?? null,
    dividends: row.dividends ?? null,
    emission_tao: row.emission_tao == null ? null : roundTao(row.emission_tao),
    stake_tao: row.stake_tao == null ? null : roundTao(row.stake_tao),
    registered_at_block:
      row.registered_at_block == null
        ? null
        : nonNegativeInt(row.registered_at_block),
    is_immunity_period: toD1Flag(row.is_immunity_period),
    axon: row.axon ?? null,
  };
}

// All rows of one subnet's snapshot share the same captured_at/block_number.
function snapshotStamp(rows) {
  const first = rows[0] || {};
  return {
    captured_at: toIso(first.captured_at),
    // Coerce like buildGlobalValidators (#2611): block_number is a nullable D1
    // INTEGER that can come back as a numeric string, so a bare `?? null` would
    // leak "8454388" into the ["integer","null"] contract field. nonNegativeInt
    // maps null→null and numeric strings→real integers.
    block_number: nonNegativeInt(first.block_number),
  };
}

export function buildSubnetMetagraph(rows, netuid) {
  const { captured_at, block_number } = snapshotStamp(rows);
  // Drop any malformed row (formatNeuron → null) so the array only holds real
  // Neuron objects, mirroring the blocks/extrinsics feed builders; the count
  // tracks the array, so callers can rely on neuron_count === neurons.length.
  const neurons = rows.map(formatNeuron).filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    neuron_count: neurons.length,
    captured_at,
    block_number,
    neurons,
  };
}

export function buildSubnetValidators(rows, netuid) {
  const { captured_at, block_number } = snapshotStamp(rows);
  const validators = rows.map(formatNeuron).filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    validator_count: validators.length,
    captured_at,
    block_number,
    validators,
  };
}

export function buildNeuronDetail(row, netuid) {
  return {
    schema_version: 1,
    netuid,
    captured_at: toIso(row?.captured_at),
    // Same D1 numeric-string coercion as snapshotStamp / buildGlobalValidators
    // (#2611): keep the top-level block_number an integer or null, never a string.
    block_number: nonNegativeInt(row?.block_number),
    neuron: formatNeuron(row),
  };
}

function primaryColdkey(coldkeys) {
  const ranked = [...coldkeys.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

function buildGlobalValidatorEntry(entry) {
  const avgTrust =
    entry.validatorTrustCount > 0
      ? entry.validatorTrustTotal / entry.validatorTrustCount
      : null;
  const subnets = entry.subnets
    .sort(
      (a, b) =>
        b.stake_tao - a.stake_tao ||
        b.emission_tao - a.emission_tao ||
        a.netuid - b.netuid ||
        a.uid - b.uid,
    )
    .slice(0, GLOBAL_VALIDATOR_SUBNET_LIMIT);
  return {
    hotkey: entry.hotkey,
    coldkey: primaryColdkey(entry.coldkeys),
    coldkey_count: entry.coldkeys.size,
    subnet_count: entry.netuids.size,
    uid_count: entry.uidCount,
    avg_validator_trust: round(avgTrust),
    max_validator_trust: round(entry.maxValidatorTrust),
    latest_captured_at: toIso(entry.latestCapturedAt),
    latest_block_number: entry.latestBlockNumber,
    subnets,
  };
}

export function buildGlobalValidators(
  rows,
  {
    sort = DEFAULT_GLOBAL_VALIDATOR_SORT,
    limit = GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  } = {},
) {
  const normalizedSort = GLOBAL_VALIDATOR_SORTS.includes(sort)
    ? sort
    : DEFAULT_GLOBAL_VALIDATOR_SORT;
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(1, Math.min(flooredLimit, GLOBAL_VALIDATOR_LIMIT_MAX))
    : GLOBAL_VALIDATOR_LIMIT_DEFAULT;
  const validatorsByHotkey = new Map();
  let latestCapturedAt = null;
  let latestBlockNumber = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    const hotkey =
      typeof row?.hotkey === "string" && row.hotkey.length > 0
        ? row.hotkey
        : null;
    const netuid = nonNegativeInt(row?.netuid);
    const uid = nonNegativeInt(row?.uid);
    if (!hotkey || netuid == null || uid == null) continue;

    const stake = numberOrZero(row?.stake_tao);
    const emission = numberOrZero(row?.emission_tao);
    const trust = nullableNumber(row?.validator_trust);
    const capturedAt = nullableNumber(row?.captured_at);
    const blockNumber = nonNegativeInt(row?.block_number);
    let entry = validatorsByHotkey.get(hotkey);
    if (!entry) {
      entry = {
        hotkey,
        coldkeys: new Map(),
        netuids: new Set(),
        uidCount: 0,
        validatorTrustTotal: 0,
        validatorTrustCount: 0,
        maxValidatorTrust: null,
        latestCapturedAt: null,
        latestBlockNumber: null,
        subnets: [],
      };
      validatorsByHotkey.set(hotkey, entry);
    }
    if (typeof row?.coldkey === "string" && row.coldkey.length > 0) {
      entry.coldkeys.set(
        row.coldkey,
        (entry.coldkeys.get(row.coldkey) ?? 0) + 1,
      );
    }
    entry.netuids.add(netuid);
    entry.uidCount += 1;
    if (trust != null) {
      entry.validatorTrustTotal += trust;
      entry.validatorTrustCount += 1;
      entry.maxValidatorTrust =
        entry.maxValidatorTrust == null
          ? trust
          : Math.max(entry.maxValidatorTrust, trust);
    }
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
      stake_tao: roundTao(stake),
      emission_tao: roundTao(emission),
      validator_trust: round(trust),
    });
  }

  const validators = [...validatorsByHotkey.values()]
    .map(buildGlobalValidatorEntry)
    .sort(
      (a, b) =>
        validatorSortValue(b, normalizedSort) -
          validatorSortValue(a, normalizedSort) ||
        a.hotkey.localeCompare(b.hotkey),
    );

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: toIso(latestCapturedAt),
    block_number: latestBlockNumber,
    validator_count: validators.length,
    validators: validators.slice(0, normalizedLimit),
  };
}

function validatorSortValue(row, key) {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

// D1 read paths shared by the REST handlers and the MCP tools (one source of
// truth). `d1` is a (sql, params) => Promise<rows[]> runner; a cold/unbound DB
// returns [] → a schema-stable empty payload.
export async function loadSubnetMetagraph(
  d1,
  netuid,
  { validatorsOnly = false } = {},
) {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ?${
      validatorsOnly ? " AND validator_permit = 1" : ""
    } ORDER BY uid`,
    [netuid],
  );
  return buildSubnetMetagraph(rows, netuid);
}

export async function loadSubnetValidators(d1, netuid) {
  // Tie-break equal stake by the unique uid so the ranking is deterministic
  // across snapshot-replaced captures (without it, SQLite returns tied rows in
  // arbitrary physical order). Mirrors loadSubnetMetagraph's ORDER BY uid.
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY stake_tao DESC, uid ASC`,
    [netuid],
  );
  return buildSubnetValidators(rows, netuid);
}

export async function loadGlobalValidators(
  d1,
  {
    sort = DEFAULT_GLOBAL_VALIDATOR_SORT,
    limit = GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  } = {},
) {
  const rows = await d1(
    "SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, " +
      "stake_tao, block_number, captured_at FROM neurons " +
      "WHERE validator_permit = 1 AND hotkey IS NOT NULL " +
      "ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC",
    [],
  );
  return buildGlobalValidators(rows, { sort, limit });
}

export async function loadNeuron(d1, netuid, uid) {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
    [netuid, uid],
  );
  return buildNeuronDetail(rows[0] ?? null, netuid);
}
