// Network-wide emission yield (return on stake): pure statistics over the per-neuron
// emission/stake return rate from the live `neurons` D1 tier, aggregated across every
// subnet. Three lenses (all neurons, validators-only, miners-only) each get a full
// distribution summary, alongside stake-weighted aggregate yields, stake/emission
// totals, and a top-yielders leaderboard. Every function is pure and exported for
// unit tests; the Worker does the D1 read + envelope. Null-safe by design: a cold or
// all-zero-stake store yields a schema-stable null block, matching the sibling
// neurons-tier routes (concentration, consensus).

export const CHAIN_YIELD_READ_COLUMNS =
  "hotkey, validator_permit, stake_tao, emission_tao, netuid, captured_at";
export const CHAIN_YIELD_LIMIT_DEFAULT = 25;
export const CHAIN_YIELD_LIMIT_MAX = 100;

// Round a return rate / statistic to 9 decimals (yields are small ratios) so JSON
// never carries a long floating-point tail. Callers pass finite numbers.
function round(value) {
  return Math.round(value * 1e9) / 1e9;
}

// Coerce one raw cell to a finite number, or 0 when it is not numeric (a non-finite
// stake/emission cell must contribute 0 to a total, not poison it).
function toNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function captureStamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ms: value, value: new Date(value).toISOString() };
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, value };
  }
  return null;
}

// Emission-per-stake return rate; null when stake is 0 (return is undefined with no
// stake to earn on), so zero-stake neurons are excluded from the distribution.
function computeYieldValue(emission, stake) {
  if (!(stake > 0)) return null;
  return round(emission / stake);
}

// Nearest-rank percentile of a NON-EMPTY ascending array (computeDistribution
// short-circuits before calling this on an empty set).
function percentile(ascending, p) {
  const rank = Math.ceil((p / 100) * ascending.length) - 1;
  return ascending[Math.min(ascending.length - 1, Math.max(0, rank))];
}

// Conventional median of a NON-EMPTY ascending array: the middle value for an odd
// count, the average of the two middle values for an even count.
function median(ascending) {
  const n = ascending.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? ascending[mid]
    : round((ascending[mid - 1] + ascending[mid]) / 2);
}

// Distribution summary of one lens's per-neuron yields (already null-filtered):
// count, mean, and the min/p25/median/p75/p90/max spread. Null when the lens has no
// contributing neuron (no stake-bearing member), keeping the artifact schema-stable.
export function computeYieldDistribution(yields) {
  const values = (Array.isArray(yields) ? yields : []).filter((y) => y != null);
  const count = values.length;
  if (count === 0) return null;
  const ascending = values.sort((a, b) => a - b);
  const sum = ascending.reduce((acc, y) => acc + y, 0);
  return {
    count,
    mean: round(sum / count),
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: median(ascending),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[count - 1],
  };
}

// Stake-weighted aggregate return: total emission per total stake for a lens. Null
// when the lens holds no stake (return undefined).
function aggregateYield(emission, stake) {
  return stake > 0 ? round(emission / stake) : null;
}

// Shape the network's neuron rows into the yield artifact: stake/emission totals,
// the network / validator / miner stake-weighted aggregate yields, a full
// distribution summary for each of the three lenses, and a top-yielders leaderboard
// (highest emission/stake first, capped to `limit`). Null-safe: an empty array
// yields a schema-stable zero (every distribution null), matching the sibling routes.
export function buildChainYield(
  rows,
  { limit = CHAIN_YIELD_LIMIT_DEFAULT } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Math.max(1, Math.min(CHAIN_YIELD_LIMIT_MAX, Math.trunc(limit)));
  let capturedAt = null;
  const netuids = new Set();
  let totalStake = 0;
  let totalEmission = 0;
  let validatorStake = 0;
  let validatorEmission = 0;
  let minerStake = 0;
  let minerEmission = 0;
  let validatorCount = 0;
  const allYields = [];
  const validatorYields = [];
  const minerYields = [];
  const leaders = [];
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const rawNetuid = row?.netuid;
    let netuid = null;
    if (rawNetuid != null) {
      const parsed = Number(rawNetuid);
      // guard the coercion: a blank/non-numeric cell must not count as subnet 0.
      if (Number.isInteger(parsed) && parsed >= 0) {
        netuid = parsed;
        netuids.add(parsed);
      }
    }
    const stake = toNumber(row?.stake_tao);
    const emission = toNumber(row?.emission_tao);
    const isValidator = Number(row?.validator_permit) === 1;
    totalStake += stake;
    totalEmission += emission;
    if (isValidator) {
      validatorStake += stake;
      validatorEmission += emission;
      validatorCount += 1;
    } else {
      minerStake += stake;
      minerEmission += emission;
    }
    const value = computeYieldValue(emission, stake);
    if (value != null) {
      allYields.push(value);
      (isValidator ? validatorYields : minerYields).push(value);
      leaders.push({
        hotkey: row?.hotkey ?? null,
        netuid,
        role: isValidator ? "validator" : "miner",
        stake_tao: round(stake),
        emission_tao: round(emission),
        yield: value,
      });
    }
  }
  // Highest yield first, tie-broken by stake (larger position first) for a stable order.
  leaders.sort((a, b) => b.yield - a.yield || b.stake_tao - a.stake_tao);
  return {
    schema_version: 1,
    subnet_count: netuids.size,
    neuron_count: list.length,
    validator_count: validatorCount,
    miner_count: list.length - validatorCount,
    captured_at: capturedAt?.value ?? null,
    total_stake_tao: round(totalStake),
    total_emission_tao: round(totalEmission),
    network_yield: aggregateYield(totalEmission, totalStake),
    validator_yield: aggregateYield(validatorEmission, validatorStake),
    miner_yield: aggregateYield(minerEmission, minerStake),
    yield: computeYieldDistribution(allYields),
    validator_yield_distribution: computeYieldDistribution(validatorYields),
    miner_yield_distribution: computeYieldDistribution(minerYields),
    top_yielders: leaders.slice(0, cap),
  };
}

// Shared D1 loader (mirrors handleChainYield): read every subnet's neurons in one
// pass, no netuid filter, and shape them.
export async function loadChainYield(d1, { limit } = {}) {
  const rows = await d1(`SELECT ${CHAIN_YIELD_READ_COLUMNS} FROM neurons`, []);
  return buildChainYield(rows, { limit });
}
