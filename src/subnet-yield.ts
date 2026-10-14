// Per-subnet emission yield: each UID's emission-per-stake return rate over the current
// metagraph snapshot, ranked high-to-low, with a distribution summary (the subnet-wide
// aggregate yield, mean, and p25/median/p75/p90 percentiles), a validator/miner split,
// and a per-UID above/below-median classification. Pure shaping (buildSubnetYield) + a
// thin store loader (loadSubnetYield) over the neurons tier; the Worker adds the REST
// envelope. Snapshot-based (no time window) — the answer is "right now, which UIDs earn
// the most emission per unit of stake, and how is that return distributed across the set".
// Null-safe: a cold/empty subnet yields a zeroed, empty-neuron card (never throws).

import {
  nonNegativeCellOrNull,
  raoBigToTao,
  round9OrZero,
  toRaoBig,
} from "./lib/rao.ts";

type Row = Record<string, unknown>;
type SqlRunner = (sql: string, params: unknown[]) => Promise<Row[]>;

// A non-negative integer uid, or null for a malformed/absent cell (Number(null) === 0,
// so guard null explicitly rather than coercing it to uid 0).
function normalizedUid(value: unknown): number | null {
  if (value == null) return null;
  // Blank cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
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

interface YieldNeuron {
  uid: number;
  hotkey: unknown;
  role: "validator" | "miner";
  stake_tao: null;
  voting_weight: number | null;
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
  const neurons: YieldNeuron[] = [];
  let capturedAt: string | null = null;
  let blockNumber: number | null = null;
  let totalEmissionRao = 0n;
  for (const row of Array.isArray(rows) ? rows : []) {
    const uid = normalizedUid(row?.uid);
    if (uid == null) continue;
    if (capturedAt == null) {
      capturedAt = toIso(row?.captured_at);
      const rawBlock = row?.block_number;
      const block =
        rawBlock == null || rawBlock === "" ? NaN : Number(rawBlock);
      blockNumber = Number.isSafeInteger(block) && block >= 0 ? block : null;
    }
    const emission = nonNegativeCellOrNull(row?.emission_tao);
    if (emission != null) totalEmissionRao += toRaoBig(emission);
    neurons.push({
      uid,
      hotkey: row?.hotkey ?? null,
      role: Number(row?.validator_permit) === 1 ? "validator" : "miner",
      stake_tao: null,
      voting_weight: nonNegativeCellOrNull(row?.stake_tao),
      emission_tao: emission == null ? null : round9OrZero(emission),
      yield: null,
      vs_median: null,
    });
  }
  neurons.sort((a, b) => a.uid - b.uid);
  const validators = neurons.filter((row) => row.role === "validator").length;
  return {
    schema_version: 2,
    netuid,
    captured_at: capturedAt,
    block_number: blockNumber,
    neuron_count: neurons.length,
    validator_count: validators,
    miner_count: neurons.length - validators,
    total_stake_alpha: null,
    total_emission_alpha: round9OrZero(raoBigToTao(totalEmissionRao)),
    subnet_yield: null,
    mean_yield: null,
    median_yield: null,
    p25_yield: null,
    p75_yield: null,
    p90_yield: null,
    neurons,
    degraded: { reason: "holdings_unqualified" },
  };
}

// One subnet's yield distribution — reads the current neurons snapshot (the same tier
// the metagraph/validators routes serve) and shapes it. A cold or absent store -> empty card.
export async function loadSubnetYield(
  runner: SqlRunner,
  netuid: number,
): Promise<Row> {
  const rows = await runner(
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
  return {
    snapshot_date: date,
    neuron_count: dayRows.length,
    validator_count: dayRows.filter(
      (row) => Number(row?.validator_permit) === 1,
    ).length,
    yield_count: 0,
    subnet_yield: null,
    mean_yield: null,
    median_yield: null,
    p25_yield: null,
    p75_yield: null,
    p90_yield: null,
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
    schema_version: 2,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
    degraded: { reason: "holdings_unqualified" },
  };
}
