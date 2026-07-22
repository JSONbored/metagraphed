// Per-subnet emission yield: each UID's emission-per-stake return rate over the current
// metagraph snapshot, ranked high-to-low, with a distribution summary (the subnet-wide
// aggregate yield, mean, and p25/median/p75/p90 percentiles), a validator/miner split,
// and a per-UID above/below-median classification. Pure shaping (buildSubnetYield) + a
// thin D1 loader (loadSubnetYield) over the neurons tier; the Worker adds the REST
// envelope. Snapshot-based (no time window) — the answer is "right now, which UIDs earn
// the most emission per unit of stake, and how is that return distributed across the set".
// Null-safe: a cold/empty subnet yields a zeroed, empty-neuron card (never throws).

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

// 1 TAO = 1e9 rao; round every tao + ratio output to that precision to shed IEEE-754
// noise below the rao floor while keeping small yields (emission/stake) meaningful.
const SCALE = 1e9;
function round9(value: unknown): number {
  const n = toNumber(value);
  return Math.round(n * SCALE) / SCALE;
}

// Coerce a D1 numeric cell (number, numeric string, or null) to a finite number.
function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A finite TAO cell, or null when absent/blank/non-numeric. Blank D1 cells coerce via
// Number("") → 0; skip those rows rather than fabricating zero-stake neurons or
// zero-yield readings (mirrors nullableNumber in metagraph-neurons.ts).
function nullableTao(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Sum a subnet's per-UID stake_tao/emission_tao in rao-integer BigInt space, not
// float space -- a subnet's neuron set is often hundreds to thousands of rows, and
// plain `+=` float accumulation compounds rounding error across the sum even when
// each individual value is itself exact (metagraphed#2922, the per-subnet analog of
// the network-wide chain-yield fix in #2933; mirrors the toRao pattern proven in
// src/account-balance.mjs for #2070). Convert back to TAO only once, at the end.
// Callers always pass an already-finite toNumber() result, so no isFinite guard here.
function toRaoBig(tao: number): bigint {
  return BigInt(Math.round(tao * 1e9));
}
function raoBigToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

// A non-negative integer uid, or null for a malformed/absent cell (Number(null) === 0,
// so guard null explicitly rather than coercing it to uid 0).
function normalizedUid(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

// Epoch-ms -> ISO string, or null when not finite (the envelope's generated_at is
// string|null). All rows of one subnet snapshot share captured_at, so the first row
// stamps the response.
function coerceEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Emission-per-stake return rate; null when stake is 0 (return is undefined with no
// stake to earn on) or emission is unknown, so zero-stake / blank-emission UIDs are
// excluded from the distribution.
function computeYieldValue(
  emission: number | null,
  stake: number | null,
): number | null {
  if (!(stake != null && stake > 0)) return null;
  if (emission == null) return null;
  return round9(emission / stake);
}

// Nearest-rank percentile of an ascending numeric array (deterministic, no interpolation
// ambiguity), used for the p25/p75/p90 spread. Null on an empty set.
function percentile(ascending: number[], p: number): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.ceil((p / 100) * ascending.length) - 1;
  const index = Math.min(ascending.length - 1, Math.max(0, rank));
  return ascending[index];
}

// Conventional median of an ascending array: the middle value for an odd count, the
// average of the two middle values for an even count (so [0.2, 0.4] -> 0.3, not the
// lower-middle a nearest-rank p50 would give). Null on an empty set.
function median(ascending: number[]): number | null {
  const n = ascending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? ascending[mid]
    : round9((ascending[mid - 1] + ascending[mid]) / 2);
}

interface YieldNeuron {
  uid: number;
  hotkey: unknown;
  role: "validator" | "miner";
  stake_tao: number;
  emission_tao: number | null;
  yield: number | null;
  vs_median?: "above" | "below" | "at" | null;
}

// Shape a subnet's neuron rows into a yield distribution scorecard. `rows` is the
// neurons snapshot for one subnet (uid, hotkey, validator_permit, stake_tao,
// emission_tao, captured_at, block_number). Null-safe: no rows -> zeroed empty card.
export function buildSubnetYield(
  rows: Row[] | null | undefined,
  netuid: unknown,
): Row {
  const list = Array.isArray(rows) ? rows : [];
  const neurons: YieldNeuron[] = [];
  let totalStakeRao = 0n;
  let totalEmissionRao = 0n;
  let yieldStakeRao = 0n;
  let yieldEmissionRao = 0n;
  let validatorCount = 0;
  let capturedAt: string | null = null;
  let blockNumber: number | null = null;
  for (const row of list) {
    const uid = normalizedUid(row?.uid);
    if (uid == null) continue;
    if (capturedAt == null) {
      capturedAt = toIso(row?.captured_at);
      // block_number is a nullable INTEGER; guard null before Number() since
      // Number(null) === 0 would fabricate the genesis height 0 for a row whose
      // block is absent (the contract models it as ["integer","null"]). A
      // numeric string like "8454388" from D1 must still pass.
      const rawBlock = row?.block_number;
      if (
        rawBlock == null ||
        (typeof rawBlock === "string" && rawBlock.trim() === "")
      ) {
        blockNumber = null;
      } else {
        const block = Number(rawBlock);
        blockNumber = Number.isFinite(block) ? block : null;
      }
    }
    const stake = nullableTao(row?.stake_tao);
    if (stake == null) continue;
    const emission = nullableTao(row?.emission_tao);
    // Match the sibling neuron formatter's SQLite 0/1 convention: only an integer 1
    // is a validator, so a numeric-string "0" cannot slip through as truthy.
    const isValidator = Number(row?.validator_permit) === 1;
    totalStakeRao += toRaoBig(stake);
    if (emission != null) {
      totalEmissionRao += toRaoBig(emission);
      yieldStakeRao += toRaoBig(stake);
      yieldEmissionRao += toRaoBig(emission);
    }
    if (isValidator) validatorCount += 1;
    neurons.push({
      uid,
      hotkey: row?.hotkey ?? null,
      role: isValidator ? "validator" : "miner",
      stake_tao: round9(stake),
      emission_tao: emission != null ? round9(emission) : null,
      yield: computeYieldValue(emission, stake),
    });
  }

  // Convert the exact rao-space accumulators back to TAO once, at the end.
  const totalStake = raoBigToTao(totalStakeRao);
  const totalEmission = raoBigToTao(totalEmissionRao);
  const yieldStake = raoBigToTao(yieldStakeRao);
  const yieldEmission = raoBigToTao(yieldEmissionRao);

  // Distribution over the UIDs that actually have a defined yield (stake > 0).
  const definedYields = neurons
    .map((n) => n.yield)
    .filter((y): y is number => y != null)
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
    // Subnet-wide return over UIDs with known stake + emission only — blank-emission
    // rows stay in the neuron list but must not dilute the aggregate as if emission were 0.
    subnet_yield: yieldStake > 0 ? round9(yieldEmission / yieldStake) : null,
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
export async function loadSubnetYield(
  d1: D1Runner,
  netuid: number,
): Promise<Row> {
  const rows = await d1(
    "SELECT uid, hotkey, validator_permit, stake_tao, emission_tao, " +
      "captured_at, block_number FROM neurons WHERE netuid = ? ORDER BY uid",
    [netuid],
  );
  return buildSubnetYield(rows, netuid);
}

// ---- Yield HISTORY (return-rate distribution over time) --------------------
// Per-day emission-yield distribution from the dated neuron_daily rollup, so a
// subnet's return trend (is the yield spread widening? is the median falling?)
// is chartable. The time-series companion to the /yield snapshot and the
// reward-return twin of concentration/history. Each day needs its full per-UID
// distribution (the median / percentile spread can't be a cheap SQL GROUP BY,
// and is NOT reconstructable from the stake+emission totals in /history), so the
// read is the raw per-UID rows bounded by a row cap that then drops a truncated
// oldest day.
export const YIELD_HISTORY_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_YIELD_HISTORY_WINDOW = "30d";
// Safety valve on the raw per-UID read (≈256 UIDs × 90d ≈ 23k; leaves head room
// and the builder drops a truncated oldest day so every point is complete).
export const YIELD_HISTORY_ROW_CAP = 50_000;

// Parse ?window for the history route — a deliberately smaller set than the
// structural history (no 1y/all) so the raw read stays bounded. Returns
// {label, days} or {error:{parameter,message}} (the analyticsQueryError shape).
export function parseSubnetYieldHistoryWindow(
  value: unknown,
):
  | { label: string; days: number; error?: undefined }
  | { error: { parameter: string; message: string } } {
  const v =
    typeof value === "string" && value ? value : DEFAULT_YIELD_HISTORY_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(YIELD_HISTORY_WINDOWS, v)) {
    return {
      error: {
        parameter: "window",
        message: `window must be one of: ${Object.keys(YIELD_HISTORY_WINDOWS).join(", ")}`,
      },
    };
  }
  return { label: v, days: YIELD_HISTORY_WINDOWS[v] };
}

// Project one day's per-UID rows to a flat, chartable yield point. Flat (not
// nested) fields keep a time series trivial to plot: the subnet-wide return plus
// the mean / median / p25 / p75 / p90 of the per-UID emission-per-stake yields
// (over the UIDs with stake > 0). Null-safe — a cold/empty day yields null
// metrics, never throws. Uses the exact rao-space accumulation buildSubnetYield
// uses so a day's subnet_yield matches the snapshot route.
function yieldHistoryPoint(date: string, dayRows: Row[]): Row {
  let yieldStakeRao = 0n;
  let yieldEmissionRao = 0n;
  let validatorCount = 0;
  let neuronCount = 0;
  const definedYields: number[] = [];
  for (const row of dayRows) {
    const stake = nullableTao(row?.stake_tao);
    if (stake == null) continue;
    neuronCount += 1;
    const emission = nullableTao(row?.emission_tao);
    if (emission != null) {
      yieldStakeRao += toRaoBig(stake);
      yieldEmissionRao += toRaoBig(emission);
    }
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
    const y = computeYieldValue(emission, stake);
    if (y != null) definedYields.push(y);
  }
  definedYields.sort((a, b) => a - b);
  const yieldStake = raoBigToTao(yieldStakeRao);
  const yieldEmission = raoBigToTao(yieldEmissionRao);
  const meanYield =
    definedYields.length > 0
      ? round9(
          definedYields.reduce((sum, y) => sum + y, 0) / definedYields.length,
        )
      : null;
  return {
    snapshot_date: date,
    neuron_count: neuronCount,
    validator_count: validatorCount,
    yield_count: definedYields.length,
    subnet_yield: yieldStake > 0 ? round9(yieldEmission / yieldStake) : null,
    mean_yield: meanYield,
    median_yield: median(definedYields),
    p25_yield: percentile(definedYields, 25),
    p75_yield: percentile(definedYields, 75),
    p90_yield: percentile(definedYields, 90),
  };
}

// Build the per-day yield time series (newest first) from neuron_daily rows
// already ordered snapshot_date DESC. `capped` (the read hit the row cap) drops
// the oldest day, which may be a partial distribution. Null-safe: a cold store
// yields point_count:0.
export function buildSubnetYieldHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { window, capped }: { window?: string; capped?: boolean } = {},
): Row {
  const list = Array.isArray(rows) ? rows : [];
  // Group by snapshot_date. Rows arrive newest-first + same-date contiguous, so
  // Map insertion order is the newest-first date order we want.
  const byDate = new Map<string, Row[]>();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)?.push(row);
  }
  let dates = [...byDate.keys()];
  if (capped && dates.length > 1) dates = dates.slice(0, -1);
  const points = dates.map((date) =>
    yieldHistoryPoint(date, byDate.get(date) ?? []),
  );
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
