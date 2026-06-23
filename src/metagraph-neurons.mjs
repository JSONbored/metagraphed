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

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// One D1 row → a clean Neuron object. SQLite stores booleans as 0/1 INTEGER, so
// coerce the flag columns back to real booleans for the API.
export function formatNeuron(row) {
  if (!row || typeof row !== "object") return null;
  return {
    uid: row.uid ?? null,
    hotkey: row.hotkey ?? null,
    coldkey: row.coldkey ?? null,
    active: Boolean(row.active),
    validator_permit: Boolean(row.validator_permit),
    rank: row.rank ?? null,
    trust: row.trust ?? null,
    validator_trust: row.validator_trust ?? null,
    consensus: row.consensus ?? null,
    incentive: row.incentive ?? null,
    dividends: row.dividends ?? null,
    emission_tao: row.emission_tao ?? null,
    stake_tao: row.stake_tao ?? null,
    registered_at_block: row.registered_at_block ?? null,
    is_immunity_period: Boolean(row.is_immunity_period),
    axon: row.axon ?? null,
  };
}

// All rows of one subnet's snapshot share the same captured_at/block_number.
function snapshotStamp(rows) {
  const first = rows[0] || {};
  return {
    captured_at: toIso(first.captured_at),
    block_number: first.block_number ?? null,
  };
}

export function buildSubnetMetagraph(rows, netuid) {
  const { captured_at, block_number } = snapshotStamp(rows);
  return {
    schema_version: 1,
    netuid,
    neuron_count: rows.length,
    captured_at,
    block_number,
    neurons: rows.map(formatNeuron),
  };
}

export function buildSubnetValidators(rows, netuid) {
  const { captured_at, block_number } = snapshotStamp(rows);
  return {
    schema_version: 1,
    netuid,
    validator_count: rows.length,
    captured_at,
    block_number,
    validators: rows.map(formatNeuron),
  };
}

export function buildNeuronDetail(row, netuid) {
  return {
    schema_version: 1,
    netuid,
    captured_at: toIso(row?.captured_at),
    block_number: row?.block_number ?? null,
    neuron: formatNeuron(row),
  };
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
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY stake_tao DESC`,
    [netuid],
  );
  return buildSubnetValidators(rows, netuid);
}

export async function loadNeuron(d1, netuid, uid) {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
    [netuid, uid],
  );
  return buildNeuronDetail(rows[0] ?? null, netuid);
}
