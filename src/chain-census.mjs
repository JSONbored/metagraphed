// Network neuron census: the registration / population state across EVERY subnet's
// neurons from the live `neurons` D1 tier — how many neurons exist, how many are
// active, how many sit in the deregistration-immunity window, the validator/miner
// split, and the distribution of registration AGE (how many blocks each neuron has
// been registered). The population lens that complements the reward lens
// (chain-performance), the stake lens (chain-concentration), and the churn lens
// (chain-turnover). Every function is pure + exported for unit tests; the Worker
// does the D1 read + envelope. Null-safe: an empty snapshot yields a schema-stable
// zeroed card.

// The neurons-tier columns the census reads. block_number is the chain height at
// capture (shared by every row in a snapshot); registered_at_block is per-neuron.
export const CHAIN_CENSUS_READ_COLUMNS =
  "netuid, active, validator_permit, is_immunity_period, " +
  "registered_at_block, block_number, captured_at";

const AGE_PERCENTILES = [50, 90];

// Round a rate to 4 dp.
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

// Strict non-negative integer coercion: accept ONLY a real number or an all-digits
// string, so a blank/null/false cell is rejected rather than read as 0.
function toInt(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function captureStamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ms: value, value: new Date(value).toISOString() };
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const ms = Number(value);
    return { ms, value: new Date(ms).toISOString() };
  }
  return null;
}

// Nearest-rank percentile over a non-empty ascending array (rank = ceil(p/100 · n),
// 1-based). Only called after the caller establishes the array is non-empty.
function percentile(ascending, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[rank - 1];
}

// Distribution summary of the per-neuron registration ages (in blocks): count,
// mean, min, max, and the p50/p90 spread. Null when no neuron has a resolvable age
// (a cold store, or no row carries both a capture height and a registered_at_block).
export function ageDistribution(ages) {
  const finite = (Array.isArray(ages) ? ages : []).filter(
    (age) => Number.isFinite(age) && age >= 0,
  );
  const count = finite.length;
  if (count === 0) return null;
  const ascending = [...finite].sort((a, b) => a - b);
  const total = ascending.reduce((sum, age) => sum + age, 0);
  const summary = {
    count,
    mean_blocks: Math.round(total / count),
    min_blocks: ascending[0],
    max_blocks: ascending[count - 1],
  };
  for (const p of AGE_PERCENTILES) {
    summary[`p${p}_blocks`] = percentile(ascending, p);
  }
  return summary;
}

// Shape EVERY subnet's neurons-tier rows into the network census: neuron/subnet
// counts, the active / immunity / validator / miner split and their rates, the
// newest chain height + capture stamp, and the registration-age distribution
// (capture height − registered_at_block per neuron). Null-safe on junk/sparse rows.
export function buildChainCensus(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const netuids = new Set();
  let activeCount = 0;
  let immunityCount = 0;
  let validatorCount = 0;
  let latestBlock = null;
  let capturedAt = null;
  const registeredBlocks = [];
  for (const row of list) {
    const netuid = toInt(row?.netuid);
    if (netuid != null) netuids.add(netuid);
    if (Number(row?.active) === 1) activeCount += 1;
    if (Number(row?.is_immunity_period) === 1) immunityCount += 1;
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
    const block = toInt(row?.block_number);
    if (block != null && (latestBlock == null || block > latestBlock)) {
      latestBlock = block;
    }
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const registered = toInt(row?.registered_at_block);
    if (registered != null) registeredBlocks.push(registered);
  }
  const neuronCount = list.length;
  // Registration age = capture height − registered_at_block (only for neurons
  // registered at or before the capture height; a future/invalid block is dropped).
  const ages =
    latestBlock == null
      ? []
      : registeredBlocks
          .map((block) => latestBlock - block)
          .filter((age) => age >= 0);
  return {
    schema_version: 1,
    subnet_count: netuids.size,
    neuron_count: neuronCount,
    active_count: activeCount,
    inactive_count: neuronCount - activeCount,
    immunity_count: immunityCount,
    validator_count: validatorCount,
    miner_count: neuronCount - validatorCount,
    active_rate: neuronCount > 0 ? round4(activeCount / neuronCount) : null,
    immunity_rate: neuronCount > 0 ? round4(immunityCount / neuronCount) : null,
    latest_block: latestBlock,
    captured_at: capturedAt?.value ?? null,
    registration_age: ageDistribution(ages),
  };
}

// Shared D1 loader (REST + MCP parity): read EVERY subnet's neurons in one pass, no
// netuid filter, and shape them into the network census. Exported for the MCP tool.
export async function loadChainCensus(d1) {
  const rows = await d1(`SELECT ${CHAIN_CENSUS_READ_COLUMNS} FROM neurons`, []);
  return buildChainCensus(rows);
}
