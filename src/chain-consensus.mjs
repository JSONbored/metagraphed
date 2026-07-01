// Network-wide Yuma-consensus performance distribution: pure statistics over the
// per-neuron consensus signals (trust, consensus, incentive, dividends) from the
// live `neurons` D1 tier, aggregated across every subnet. Every function is pure
// and exported for unit tests; the Worker does the D1 read + envelope. Null-safe by
// design: an empty or all-zero distribution yields a schema-stable null block,
// matching the sibling neurons-tier routes (concentration, yield).

// The neurons-tier columns the consensus handler reads.
export const CHAIN_CONSENSUS_READ_COLUMNS =
  "trust, consensus, incentive, dividends, validator_permit, active, netuid, captured_at";

// The consensus signals summarized, in payload order.
const CONSENSUS_SIGNALS = ["trust", "consensus", "incentive", "dividends"];

// Round a 0..1 statistic to a stable 6-dp precision so JSON never carries a long
// floating-point tail. Callers pass finite numbers (computeDistribution only ever
// summarizes finite, positive values).
function round(value, dp = 6) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// Coerce one raw cell to a finite number, or null when it is not numeric.
function toNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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

// Nearest-rank percentile of a NON-EMPTY ascending array (deterministic, no
// interpolation ambiguity). computeDistribution short-circuits before calling this
// on an empty distribution, so no empty guard is needed.
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
    : (ascending[mid - 1] + ascending[mid]) / 2;
}

// Distribution summary of one signal over its participating (finite, > 0) values:
// count plus mean and the min/p25/median/p75/p90/max spread. A signal a neuron does
// not earn is 0 (validators earn dividends not incentive, and miners the reverse),
// so the positive filter yields the meaningful earning-participant distribution.
// Null when nobody participates (cold store or an all-zero column), keeping the
// artifact schema-stable.
export function computeDistribution(values) {
  const positives = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const n = toNumber(raw);
    if (n != null && n > 0) positives.push(n);
  }
  const count = positives.length;
  if (count === 0) return null;
  const ascending = positives.sort((a, b) => a - b);
  const sum = ascending.reduce((acc, v) => acc + v, 0);
  return {
    count,
    mean: round(sum / count),
    min: round(ascending[0]),
    p25: round(percentile(ascending, 25)),
    median: round(median(ascending)),
    p75: round(percentile(ascending, 75)),
    p90: round(percentile(ascending, 90)),
    max: round(ascending[count - 1]),
  };
}

// Shape the network's neuron rows into the consensus distribution artifact: the
// counts (subnets, neurons, active, validators, miners), the newest capture stamp,
// and a per-signal distribution summary for trust, consensus, incentive, and
// dividends. Null-safe: an empty array yields a schema-stable zero (every summary
// null), matching the sibling neurons-tier routes.
export function buildChainConsensus(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let capturedAt = null;
  const netuids = new Set();
  let activeCount = 0;
  let validatorCount = 0;
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const rawNetuid = row?.netuid;
    if (rawNetuid != null) {
      const netuid = Number(rawNetuid);
      // guard the coercion: a blank/non-numeric cell must not count as subnet 0.
      if (Number.isInteger(netuid) && netuid >= 0) netuids.add(netuid);
    }
    if (Number(row?.active) === 1) activeCount += 1;
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
  }
  const summary = {};
  for (const signal of CONSENSUS_SIGNALS) {
    summary[signal] = computeDistribution(list.map((row) => row?.[signal]));
  }
  return {
    schema_version: 1,
    subnet_count: netuids.size,
    neuron_count: list.length,
    active_count: activeCount,
    validator_count: validatorCount,
    miner_count: list.length - validatorCount,
    captured_at: capturedAt?.value ?? null,
    trust: summary.trust,
    consensus: summary.consensus,
    incentive: summary.incentive,
    dividends: summary.dividends,
  };
}

// Shared D1 loader (mirrors handleChainConsensus + loadSubnetConcentration): read
// every subnet's neurons in one pass, no netuid filter, and shape them.
export async function loadChainConsensus(d1) {
  const rows = await d1(
    `SELECT ${CHAIN_CONSENSUS_READ_COLUMNS} FROM neurons`,
    [],
  );
  return buildChainConsensus(rows);
}
