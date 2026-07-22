// Network-wide emission yield: the emission-per-stake RETURN RATE over EVERY
// subnet's neurons from the live `neurons` D1 tier, summarized as a distribution
// (no per-UID list — the network analog of the per-subnet yield scorecard in
// subnet-yield.mjs). The return-rate companion to chain-performance.ts: that
// measures how CONCENTRATED the rewards are and how the 0..1 trust scores spread,
// while this measures how efficiently stake earns emission across the whole
// network and how that return is distributed across all neurons at once. Every
// function is pure + exported for unit tests; the Worker does the D1 read +
// envelope. Null-safe: an empty snapshot yields a schema-stable zeroed card.

// The neurons-tier columns the network yield handler reads. `netuid` lets the
// artifact report how many subnets the snapshot spans (mirrors
// CHAIN_PERFORMANCE_READ_COLUMNS); no per-UID list is served, so only the economic
// columns are read.
export const CHAIN_YIELD_READ_COLUMNS =
  "validator_permit, stake_tao, emission_tao, netuid, captured_at";

// The return-rate spread reported alongside the conventional median.
const YIELD_PERCENTILES = [10, 25, 75, 90];

// 1 TAO = 1e9 rao; round tao + yield outputs to that precision to shed IEEE-754
// noise below the rao floor while keeping small emission/stake ratios meaningful.
const SCALE = 1e9;
function round9(value) {
  return Math.round(Number(value) * SCALE) / SCALE;
}

// A finite TAO cell, or null when absent/blank/non-numeric. Blank D1 cells coerce via
// Number("") → 0; skip those rows rather than fabricating zero-stake neurons or
// zero-yield readings (mirrors subnet-yield.mjs / metagraph-neurons.mjs).
function nullableTao(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Sum in rao-integer BigInt space, not float space -- summing potentially
// thousands of network-wide stake_tao/emission_tao floats with plain `+=`
// compounds rounding error across the accumulation even when each individual
// value is itself exact (metagraphed#2922, mirrors the toRao pattern already
// proven in src/account-balance.mjs for #2070). Convert back to TAO only
// once, at the very end. Callers pass finite nullableTao() results into toRaoBig.
function toRaoBig(tao) {
  return BigInt(Math.round(tao * 1e9));
}
function raoBigToTao(rao) {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

// Coerce a D1 netuid cell to a non-negative integer, or null. Accept ONLY a real
// number or an all-digits string: a bare Number() would turn "", null, or false
// into a valid subnet 0 (Number("") === Number(null) === Number(false) === 0), so
// those non-numeric forms are rejected outright rather than mis-counted as subnet 0.
function subnetNetuid(value) {
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
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return { ms: value, value: date.toISOString() };
    }
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const ms = Number(value);
      const date = new Date(ms);
      if (Number.isFinite(ms) && Number.isFinite(date.getTime())) {
        return { ms, value: date.toISOString() };
      }
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, value };
  }
  return null;
}

// Emission-per-stake return rate; null when stake is 0 (the return is undefined
// with no stake to earn on) or emission is unknown, so zero-stake / blank-emission
// neurons are excluded from the spread.
function computeYieldValue(emission, stake) {
  if (!(stake > 0)) return null;
  if (emission == null) return null;
  return round9(emission / stake);
}

// Nearest-rank percentile over a non-empty ascending array (rank = ceil(p/100 · n),
// 1-based), matching the subnet-yield / chain-performance convention. Only called
// after yieldDistribution has established count > 0, so it is never empty.
function percentile(ascending, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[rank - 1];
}

// Conventional median of an ascending array: the middle value for an odd count,
// the average of the two middle values for an even count (so [0.2, 0.4] -> 0.3,
// not the lower-middle a nearest-rank p50 would give). Only called after count > 0.
function median(ascending) {
  const mid = Math.floor(ascending.length / 2);
  return ascending.length % 2 === 1
    ? ascending[mid]
    : round9((ascending[mid - 1] + ascending[mid]) / 2);
}

// Distribution summary of the per-neuron return rates: count/mean/median/min/max
// plus the p10..p90 spread. Null when no neuron carries a defined yield (cold
// store / empty network / every neuron zero-stake).
export function yieldDistribution(yields) {
  const defined = (Array.isArray(yields) ? yields : [])
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  const count = defined.length;
  if (count === 0) return null;
  const total = defined.reduce((sum, value) => sum + value, 0);
  const summary = {
    count,
    mean: round9(total / count),
    median: median(defined),
    min: round9(defined[0]),
    max: round9(defined[count - 1]),
  };
  for (const p of YIELD_PERCENTILES) {
    summary[`p${p}`] = round9(percentile(defined, p));
  }
  return summary;
}

// Shape EVERY subnet's neurons-tier rows into the network yield artifact: the
// aggregate network return (total emission / total stake), the same split by
// validator vs miner role, and the distribution of the per-neuron return rate
// across the whole network, plus `subnet_count` (subnets the snapshot spans) and
// neuron/validator/miner counts. Null-safe on junk/sparse rows — an empty array
// yields a schema-stable zeroed card (aggregate yields null, distribution null).
export function buildChainYield(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let capturedAt = null;
  let validatorCount = 0;
  let neuronCount = 0;
  let totalStakeRao = 0n;
  let totalEmissionRao = 0n;
  let yieldStakeRao = 0n;
  let yieldEmissionRao = 0n;
  let yieldValidatorStakeRao = 0n;
  let yieldValidatorEmissionRao = 0n;
  let yieldMinerStakeRao = 0n;
  let yieldMinerEmissionRao = 0n;
  const netuids = new Set();
  const yields = [];
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const stake = nullableTao(row?.stake_tao);
    if (stake == null) continue;
    const netuid = subnetNetuid(row?.netuid);
    if (netuid != null) netuids.add(netuid);
    neuronCount += 1;
    const emission = nullableTao(row?.emission_tao);
    // Match the neuron formatter's SQLite 0/1 convention: only an integer 1 is a
    // validator, so a numeric-string "0" cannot slip through as truthy.
    const isValidator = Number(row?.validator_permit) === 1;
    totalStakeRao += toRaoBig(stake);
    if (emission != null) {
      totalEmissionRao += toRaoBig(emission);
      if (stake > 0) {
        yieldStakeRao += toRaoBig(stake);
        yieldEmissionRao += toRaoBig(emission);
        if (isValidator) {
          yieldValidatorStakeRao += toRaoBig(stake);
          yieldValidatorEmissionRao += toRaoBig(emission);
        } else {
          yieldMinerStakeRao += toRaoBig(stake);
          yieldMinerEmissionRao += toRaoBig(emission);
        }
      }
    }
    if (isValidator) validatorCount += 1;
    const value = computeYieldValue(emission, stake);
    if (value != null) yields.push(value);
  }
  const totalStake = raoBigToTao(totalStakeRao);
  const totalEmission = raoBigToTao(totalEmissionRao);
  const yieldStake = raoBigToTao(yieldStakeRao);
  const yieldEmission = raoBigToTao(yieldEmissionRao);
  const yieldValidatorStake = raoBigToTao(yieldValidatorStakeRao);
  const yieldValidatorEmission = raoBigToTao(yieldValidatorEmissionRao);
  const yieldMinerStake = raoBigToTao(yieldMinerStakeRao);
  const yieldMinerEmission = raoBigToTao(yieldMinerEmissionRao);
  return {
    schema_version: 1,
    subnet_count: netuids.size,
    neuron_count: neuronCount,
    validator_count: validatorCount,
    miner_count: neuronCount - validatorCount,
    captured_at: capturedAt?.value ?? null,
    total_stake_tao: round9(totalStake),
    total_emission_tao: round9(totalEmission),
    // Network aggregate return over neurons with known stake + emission only.
    network_yield: yieldStake > 0 ? round9(yieldEmission / yieldStake) : null,
    // The same aggregate return split by role.
    validator_yield:
      yieldValidatorStake > 0
        ? round9(yieldValidatorEmission / yieldValidatorStake)
        : null,
    miner_yield:
      yieldMinerStake > 0 ? round9(yieldMinerEmission / yieldMinerStake) : null,
    // Distribution of the per-neuron return rate across the whole network.
    distribution: yieldDistribution(yields),
  };
}

// Shared D1 loader (mirrors handleChainYield + loadChainPerformance): read EVERY
// subnet's neurons in one pass, no netuid filter, and shape them into the network
// yield artifact. Exported for the MCP tool.
export async function loadChainYield(d1) {
  const rows = await d1(`SELECT ${CHAIN_YIELD_READ_COLUMNS} FROM neurons`, []);
  return buildChainYield(rows);
}
