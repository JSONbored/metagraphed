// Per-UID daily metagraph HISTORY (block-explorer Tier-1, epic #1345 / depth #1302).
//
// The rollup snapshots the live `neurons` table into the dated `neuron_daily`
// table once a day (its own cron); the read builders reuse the live formatters
// (metagraph-neurons.ts) so a historical row is byte-identical in shape to a live
// one. Pure + injectable for tests — the Worker handlers run the D1 query and call
// these.
import { NEURON_COLUMNS, formatNeuron } from "./metagraph-neurons.ts";

type Row = Record<string, unknown>;

// History windows. Deliberately NOT analyticsWindow (which only understands
// 7d/30d and clamps anything else to 400 days). `all` → no lower bound.
export const HISTORY_WINDOWS: Record<string, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
  all: null,
};
export const DEFAULT_HISTORY_WINDOW = "30d";
// Bounds any single time-series response (1y = 365 daily points < this cap).
export const MAX_HISTORY_POINTS = 400;

export function unsupportedWindowMessage(
  value: unknown,
  windows: Record<string, unknown>,
): string {
  return `"${value}" is not a supported window. Supported: ${Object.keys(windows).join(", ")}.`;
}

export function parseHistoryWindow(
  value: unknown,
):
  | { label: string; days: number | null }
  | { error: { parameter: string; message: string } } {
  const v = typeof value === "string" && value ? value : DEFAULT_HISTORY_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(HISTORY_WINDOWS, v)) {
    return {
      error: {
        parameter: "window",
        message: unsupportedWindowMessage(v, HISTORY_WINDOWS),
      },
    };
  }
  return { label: v, days: HISTORY_WINDOWS[v] };
}

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Coerce a non-negative integer cell, or null when missing, non-finite, or
// negative. D1 can return COUNT/SUM aggregates as numeric strings, so a bare
// `r.neuron_count ?? null` would leak the string into the subnet-history
// payload (breaking the ["integer","null"] contract). Mirrors toBlockNumber in
// blocks.mjs / account-events.mjs.
function toNonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// SELECT list for reading a neuron_daily row back as a live-shaped neuron
// (formatNeuron consumes NEURON_COLUMNS) plus the history-specific snapshot_date.
export const NEURON_DAILY_READ_COLUMNS = `snapshot_date, ${NEURON_COLUMNS}`;

// Per-UID time series: one point per snapshot_date (the handler queries newest
// first, bounded by MAX_HISTORY_POINTS), each a live-shaped neuron plus its date.
export function buildNeuronHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  uid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  // Drop any malformed (non-object) row so the array only holds real points and
  // the count tracks it (point_count === points.length) -- mirroring the
  // blocks/extrinsics/metagraph builders' .filter(Boolean) guard (#1793). Reading
  // formatNeuron(r) first also means a null/undefined element degrades gracefully
  // instead of throwing on `r.snapshot_date`.
  const points = (rows || [])
    .map((r): Row | null => {
      const neuron = formatNeuron(r);
      if (!neuron) return null;
      return {
        snapshot_date: r.snapshot_date,
        captured_at: toIso(r.captured_at),
        block_number: toNonNegativeInt(r.block_number),
        ...neuron,
      };
    })
    .filter((p): p is Row => p !== null);
  return {
    schema_version: 1,
    netuid,
    uid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}

interface EconomicsTrendAccumulator {
  subnet_count: number;
  stake_sum_rao: bigint;
  stake_seen: boolean;
  validator_sum: number;
  validator_seen: boolean;
  miner_sum: number;
  miner_seen: boolean;
  emission_sum: number;
  emission_seen: number;
  weighted_price_num: number;
  weighted_price_den: number;
  prices: number[];
}

// Network-wide economics time series (#1307): roll the per-subnet daily
// subnet_snapshots rows up to ONE point per UTC day across all subnets. Each input
// row is {snapshot_date, total_stake_tao, alpha_price_tao, validator_count,
// miner_count, emission_share}; the handler reads them raw (not a GROUP BY) so the
// stake-weighted mean + median alpha price can be computed here. Rows arrive newest
// first; the output preserves that order. Null-safe throughout — a metric is null
// for a day only when NO subnet reported it.
export function buildEconomicsTrends(
  rows: Row[] | null | undefined,
  { window, capped }: { window?: unknown; capped?: boolean } = {},
): Row {
  const byDay = new Map<unknown, EconomicsTrendAccumulator>(); // snapshot_date -> accumulator (insertion order = newest first)
  for (const r of rows || []) {
    const day = r.snapshot_date;
    if (day == null) continue;
    let acc = byDay.get(day);
    if (!acc) {
      acc = {
        subnet_count: 0,
        stake_sum_rao: 0n,
        stake_seen: false,
        validator_sum: 0,
        validator_seen: false,
        miner_sum: 0,
        miner_seen: false,
        emission_sum: 0,
        emission_seen: 0,
        weighted_price_num: 0, // Σ(price · stake)
        weighted_price_den: 0, // Σ(stake) over rows with a price
        prices: [], // for the unweighted median
      };
      byDay.set(day, acc);
    }
    acc.subnet_count += 1;
    const stake = toFiniteOrNull(r.total_stake_tao);
    const price = toFiniteOrNull(r.alpha_price_tao);
    const validators = toFiniteOrNull(r.validator_count);
    const miners = toFiniteOrNull(r.miner_count);
    const emission = toFiniteOrNull(r.emission_share);
    if (stake != null) {
      // Exact rao-integer BigInt accumulation, not float (#2924): this is a
      // network-wide sum across every reporting subnet for the day, already
      // well past 2^53-1's exact-double ceiling (~9,007,199 TAO at rao
      // precision) -- see raoToTaoString's own header comment below.
      acc.stake_sum_rao += BigInt(Math.round(stake * 1e9));
      acc.stake_seen = true;
    }
    if (validators != null) {
      acc.validator_sum += validators;
      acc.validator_seen = true;
    }
    if (miners != null) {
      acc.miner_sum += miners;
      acc.miner_seen = true;
    }
    if (emission != null) {
      acc.emission_sum += emission;
      acc.emission_seen += 1;
    }
    if (price != null) {
      acc.prices.push(price);
      // Stake-weight the price; a positive stake is required for a weighted mean.
      if (stake != null && stake > 0) {
        acc.weighted_price_num += price * stake;
        acc.weighted_price_den += stake;
      }
    }
  }
  // A row-capped read (the loader's LIMIT was hit) cuts the oldest snapshot_date
  // mid-day, so that day only holds the subnets that happened to fall inside the
  // cap — a spuriously small "network total". Drop that partial oldest day (the
  // last entry, since byDay is newest-first), matching buildConcentrationHistory.
  let entries = [...byDay.entries()];
  if (capped && entries.length > 1) entries = entries.slice(0, -1);
  const days = entries.map(([snapshot_date, acc]) => ({
    snapshot_date,
    subnet_count: acc.subnet_count,
    total_stake_tao: acc.stake_seen ? raoToTaoString(acc.stake_sum_rao) : null,
    alpha_price_tao_weighted:
      acc.weighted_price_den > 0
        ? roundPrice(acc.weighted_price_num / acc.weighted_price_den)
        : null,
    alpha_price_tao_median: median(acc.prices),
    validator_count: acc.validator_seen ? acc.validator_sum : null,
    miner_count: acc.miner_seen ? acc.miner_sum : null,
    mean_emission_share:
      acc.emission_seen > 0
        ? roundShare(acc.emission_sum / acc.emission_seen)
        : null,
  }));
  return {
    schema_version: 1,
    window: window ?? null,
    day_count: days.length,
    days,
  };
}

// Blank D1 cells coerce via Number("") -> 0; trim rejects "" / whitespace-only
// so a blank cell is excluded from the day's aggregate rather than read as a
// genuine 0. Mirrors toNonNegativeInt above.
function toFiniteOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundTao(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

const RAO_PER_TAO = 1_000_000_000n;

// Exact rao-precision decimal string, never a JS number (#2924): a network-
// wide daily total_stake_tao sum is already well past 2^53-1's exact-double
// ceiling (~9,007,199 TAO at rao precision) -- confirmed live 2026-07-14 at
// ~328M TAO, 36x over. A double can't hold this many significant digits at
// full rao precision, so both the BigInt accumulation above and this string
// formatting (instead of returning a float) are required to avoid silently
// corrupting the value. Mirrors the identical helper in
// scripts/lib/economics-artifacts.ts's buildEconomicsArtifact summary.
// No negative-sign handling: total_stake_tao is a non-negative on-chain
// quantity, so a negative sum is unreachable here -- would be untestable
// dead code.
function raoToTaoString(rao: bigint): string {
  const whole = rao / RAO_PER_TAO;
  const frac = rao % RAO_PER_TAO;
  return `${whole}.${frac.toString().padStart(9, "0")}`;
}
// Round a TAO sum, preserving null — so an unrounded D1 SUM(stake_tao)/SUM(
// emission_tao) never leaks accumulated float noise, while a null SUM (cold/
// sparse day) stays null rather than collapsing to 0.
function roundTaoOrNull(v: unknown): number | null {
  const n = toFiniteOrNull(v);
  return n == null ? null : roundTao(n);
}
function roundPrice(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
function roundShare(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return roundPrice(raw);
}

// Per-subnet metric-over-time: the daily count + a couple of cheap aggregates per
// snapshot_date (newest first), for a subnet-level history sparkline without
// shipping every UID. Rows come from a GROUP BY snapshot_date query.
export function buildSubnetHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  // Drop any malformed (non-object) row so the count tracks the emitted array
  // (point_count === points.length) and a null/undefined element never throws on
  // `r.snapshot_date` -- mirroring the sibling feed builders' guard (#1793).
  const points = (rows || [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      snapshot_date: r.snapshot_date,
      neuron_count: toNonNegativeInt(r.neuron_count),
      validator_count: toNonNegativeInt(r.validator_count),
      // Round the per-day SUM(stake_tao)/SUM(emission_tao) to stop accumulated
      // float noise from leaking, matching buildEconomicsTrends above.
      total_stake_tao: roundTaoOrNull(r.total_stake_tao),
      total_emission_tao: roundTaoOrNull(r.total_emission_tao),
    }));
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
