// Per-subnet emission yield: each UID's emission-per-stake return rate over the current
// metagraph snapshot, ranked high-to-low, with a distribution summary (the subnet-wide
// aggregate yield, mean, and p25/median/p75/p90 percentiles), a validator/miner split,
// and a per-UID above/below-median classification. Pure shaping (buildSubnetYield) + a
// thin D1 loader (loadSubnetYield) over the neurons tier; the Worker adds the REST
// envelope. Snapshot-based (no time window) — the answer is "right now, which UIDs earn
// the most emission per unit of stake, and how is that return distributed across the set".
// Null-safe: a cold/empty subnet yields a zeroed, empty-neuron card (never throws).

// 1 TAO = 1e9 rao; round every tao + ratio output to that precision to shed IEEE-754
// noise below the rao floor while keeping small yields (emission/stake) meaningful.
const SCALE = 1e9;
function round9(value) {
  const n = toNumber(value);
  return Math.round(n * SCALE) / SCALE;
}

// Coerce a D1 numeric cell (number, numeric string, or null) to a finite number.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A non-negative integer uid, or null for a malformed/absent cell (Number(null) === 0,
// so guard null explicitly rather than coercing it to uid 0).
function normalizedUid(value) {
  if (value == null) return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

// Epoch-ms -> ISO string, or null when not finite (the envelope's generated_at is
// string|null). All rows of one subnet snapshot share captured_at, so the first row
// stamps the response.
function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Emission-per-stake return rate; null when stake is 0 (return is undefined with no
// stake to earn on), so zero-stake UIDs are excluded from the distribution.
function computeYieldValue(emission, stake) {
  if (!(stake > 0)) return null;
  return round9(emission / stake);
}

// Nearest-rank percentile of an ascending numeric array (deterministic, no interpolation
// ambiguity), used for the p25/p75/p90 spread. Null on an empty set.
function percentile(ascending, p) {
  if (ascending.length === 0) return null;
  const rank = Math.ceil((p / 100) * ascending.length) - 1;
  const index = Math.min(ascending.length - 1, Math.max(0, rank));
  return ascending[index];
}

// Conventional median of an ascending array: the middle value for an odd count, the
// average of the two middle values for an even count (so [0.2, 0.4] -> 0.3, not the
// lower-middle a nearest-rank p50 would give). Null on an empty set.
function median(ascending) {
  const n = ascending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? ascending[mid]
    : round9((ascending[mid - 1] + ascending[mid]) / 2);
}

// Shape a subnet's neuron rows into a yield distribution scorecard. `rows` is the
// neurons snapshot for one subnet (uid, hotkey, validator_permit, stake_tao,
// emission_tao, captured_at, block_number). Null-safe: no rows -> zeroed empty card.
export function buildSubnetYield(rows, netuid) {
  const list = Array.isArray(rows) ? rows : [];
  const neurons = [];
  let totalStake = 0;
  let totalEmission = 0;
  let validatorCount = 0;
  let capturedAt = null;
  let blockNumber = null;
  for (const row of list) {
    const uid = normalizedUid(row?.uid);
    if (uid == null) continue;
    if (capturedAt == null) {
      capturedAt = toIso(Number(row?.captured_at));
      const block = Number(row?.block_number);
      blockNumber = Number.isFinite(block) ? block : null;
    }
    const stake = toNumber(row?.stake_tao);
    const emission = toNumber(row?.emission_tao);
    // Match the sibling neuron formatter's SQLite 0/1 convention: only an integer 1
    // is a validator, so a numeric-string "0" cannot slip through as truthy.
    const isValidator = Number(row?.validator_permit) === 1;
    totalStake += stake;
    totalEmission += emission;
    if (isValidator) validatorCount += 1;
    neurons.push({
      uid,
      hotkey: row?.hotkey ?? null,
      role: isValidator ? "validator" : "miner",
      stake_tao: round9(stake),
      emission_tao: round9(emission),
      yield: computeYieldValue(emission, stake),
    });
  }

  // Distribution over the UIDs that actually have a defined yield (stake > 0).
  const definedYields = neurons
    .map((n) => n.yield)
    .filter((y) => y != null)
    .sort((a, b) => a - b);
  const medianYield = median(definedYields);
  const meanYield =
    definedYields.length > 0
      ? round9(
          definedYields.reduce((sum, y) => sum + y, 0) / definedYields.length,
        )
      : null;

  // Per-UID classification vs the subnet median (over- vs under-performing on return).
  for (const neuron of neurons) {
    neuron.vs_median =
      neuron.yield == null || medianYield == null
        ? null
        : neuron.yield > medianYield
          ? "above"
          : neuron.yield < medianYield
            ? "below"
            : "at";
  }

  // Highest yield first; zero-stake (null) UIDs sink to the bottom, tie-break by uid.
  neurons.sort((a, b) => {
    const ay = a.yield == null ? -Infinity : a.yield;
    const by = b.yield == null ? -Infinity : b.yield;
    return by - ay || a.uid - b.uid;
  });

  return {
    schema_version: 1,
    netuid,
    captured_at: capturedAt,
    block_number: blockNumber,
    neuron_count: neurons.length,
    validator_count: validatorCount,
    miner_count: neurons.length - validatorCount,
    total_stake_tao: round9(totalStake),
    total_emission_tao: round9(totalEmission),
    // The subnet-wide return: total emission per total stake (null with no stake).
    subnet_yield: totalStake > 0 ? round9(totalEmission / totalStake) : null,
    mean_yield: meanYield,
    median_yield: medianYield,
    p25_yield: percentile(definedYields, 25),
    p75_yield: percentile(definedYields, 75),
    p90_yield: percentile(definedYields, 90),
    neurons,
  };
}

// One subnet's yield distribution — reads the current neurons snapshot (the same tier
// the metagraph/validators routes serve) and shapes it. Cold/absent D1 -> empty card.
export async function loadSubnetYield(d1, netuid) {
  const rows = await d1(
    "SELECT uid, hotkey, validator_permit, stake_tao, emission_tao, " +
      "captured_at, block_number FROM neurons WHERE netuid = ? ORDER BY uid",
    [netuid],
  );
  return buildSubnetYield(rows, netuid);
}
