// Subnet performance / reward-distribution metrics: pure statistics over a
// subnet's per-UID PERFORMANCE columns (incentive, dividends, trust, consensus,
// validator_trust) from the live `neurons` D1 tier. This is the reward-flow and
// trust companion to concentration.ts — concentration measures who holds the
// STAKE/EMISSION; this measures how concentrated the actual REWARDS are and how
// the 0..1 trust/consensus scores are spread across the neurons. Every function
// is pure + exported for unit tests; the Worker does the D1 read + envelope.
// Null-safe by design: an empty / all-zero distribution yields a schema-stable
// `null` block (never throws), matching the concentration tier it mirrors.

import { computeConcentration } from "./concentration.ts";

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

// The neurons-tier columns the performance handler reads — the D1 read contract
// for buildSubnetPerformance (mirrors CONCENTRATION_READ_COLUMNS). Kept next to
// its consumer so the Worker handler stays a thin SELECT.
export const PERFORMANCE_READ_COLUMNS =
  "incentive, dividends, trust, consensus, validator_trust, " +
  "active, validator_permit, captured_at";

// The 0..1 score columns reported as a percentile spread (not a concentration
// scorecard — a bounded score has no "share of a total" to be unequal over, so a
// distribution summary is the meaningful lens).
const SCORE_PERCENTILES = [10, 25, 50, 75, 90];

// Round a score/mean to 6 dp so JSON never carries a long floating-point tail.
// Callers only ever pass finite values (finiteValues drops non-finite cells and
// scoreDistribution guards count > 0), so no null-guard is needed here.
function round(value: number): number {
  const factor = 1e6;
  return Math.round(value * factor) / factor;
}

// Guard 0/negative epoch ms (a blank/sentinel D1 cell) so a captured_at never
// stamps the 1970 epoch. Mirrors epochMsStamp in concentration.ts / the
// account-events + snapshot fixes (#2776/#2777).
function epochMsStamp(ms: number): { ms: number; value: string } | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

function captureStamp(value: unknown): { ms: number; value: string } | null {
  if (value == null) return null;
  if (typeof value === "string") {
    // D1 can return an INTEGER captured_at as a numeric-epoch string; Date.parse
    // returns NaN for a bare epoch string, so coerce it like concentration.ts.
    if (/^\d+$/.test(value)) return epochMsStamp(Number(value));
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, value };
    return null;
  }
  if (typeof value === "number") return epochMsStamp(value);
  return null;
}

// Coerce a raw column array to the finite values present. Unlike the concentration
// `positiveValues`, a score of exactly 0 is a real observation (a neuron with zero
// trust IS part of the spread), so only null/NaN cells are dropped — the `count`
// reflects the neurons that actually carry a score.
function finiteValues(values: unknown[]): number[] {
  const out: number[] = [];
  for (const raw of values) {
    // Guard null/undefined/blank BEFORE Number(): Number(null) / Number(" ") are 0,
    // which would count an absent score as a real 0 and pollute the distribution.
    // trim() catches whitespace-only cells too, not just the exact empty string.
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Nearest-rank percentile over a non-empty ascending array (rank = ceil(p/100 · n),
// 1-based), matching the subnet-yield / health-percentile convention. Only called
// after scoreDistribution has established count > 0, so the array is never empty.
function percentile(ascending: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[rank - 1];
}

// Conventional median of a 0..1 score column: the middle value for an odd count,
// the average of the two middle values for an even count — NOT the nearest-rank
// p50, which returns the lower-middle for an even count (e.g. [0.2, 0.8] -> 0.2).
// Matches the median() subnet-yield.ts uses for median_yield (its test asserts it
// "averages the two middle values ... not lower-middle"), so a field named
// *_median reports the same statistic across both modules. Callers pass a raw
// column array (dayRows.map(...)); returns null when no neuron carries a finite value.
function scoreMedian(values: unknown[]): number | null {
  const ascending = finiteValues(values).sort((a, b) => a - b);
  const n = ascending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? round(ascending[mid])
    : round((ascending[mid - 1] + ascending[mid]) / 2);
}

export interface ScoreDistribution {
  count: number;
  mean: number;
  min: number;
  max: number;
  [percentileKey: `p${number}`]: number;
}

// Distribution summary for one 0..1 score column, or `null` when no neuron carries
// a finite value (cold store / empty subnet / all-null column). count/mean plus the
// SCORE_PERCENTILES spread and the min/max, all rounded to a stable precision.
export function scoreDistribution(
  values: unknown[] | null | undefined,
): ScoreDistribution | null {
  const finite = finiteValues(Array.isArray(values) ? values : []);
  const count = finite.length;
  if (count === 0) return null;
  const ascending = [...finite].sort((a, b) => a - b);
  const total = finite.reduce((sum, v) => sum + v, 0);
  const summary: ScoreDistribution = {
    count,
    mean: round(total / count),
    min: round(ascending[0]),
    max: round(ascending[count - 1]),
  };
  for (const p of SCORE_PERCENTILES) {
    summary[`p${p}`] = round(percentile(ascending, p));
  }
  return summary;
}

// Shape one subnet's neurons-tier rows into the performance artifact — two lenses
// over the same snapshot:
//   • reward CONCENTRATION → `incentive`, `dividends` (Gini/HHI/Nakamoto/top-share
//     of the actual reward flow — how few neurons capture most of the rewards)
//   • score DISTRIBUTION   → `trust`, `consensus`, `validator_trust` (the p10..p90
//     spread of the 0..1 performance scores across the subnet)
// plus neuron/validator/active counts. Null-safe on junk/sparse rows — an empty
// array yields a schema-stable zero (every metric block null).
export function buildSubnetPerformance(
  rows: Row[] | null | undefined,
  netuid: unknown,
): Row {
  const list = Array.isArray(rows) ? rows : [];
  // The rows share one cron capture, but don't assume an order — take the newest.
  let capturedAt: { ms: number; value: string } | null = null;
  let validatorCount = 0;
  let activeCount = 0;
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
    if (Number(row?.active) === 1) activeCount += 1;
  }
  // Validator dividends only make sense over permitted validators; miner incentive
  // over the whole set. Slice each reward lens to the population that earns it.
  const validatorRows = list.filter(
    (row) => Number(row?.validator_permit) === 1,
  );
  return {
    schema_version: 1,
    netuid,
    neuron_count: list.length,
    validator_count: validatorCount,
    active_count: activeCount,
    captured_at: capturedAt?.value ?? null,
    // Reward-flow concentration (who actually earns): incentive across all neurons
    // (miner emission share), dividends across the permitted validators.
    incentive: computeConcentration(list.map((row) => row?.incentive)),
    dividends: computeConcentration(validatorRows.map((row) => row?.dividends)),
    // 0..1 score spread across the subnet.
    trust: scoreDistribution(list.map((row) => row?.trust)),
    consensus: scoreDistribution(list.map((row) => row?.consensus)),
    validator_trust: scoreDistribution(
      validatorRows.map((row) => row?.validator_trust),
    ),
  };
}

// Shared D1 loader (mirrors handleSubnetPerformance) — read one subnet's neurons
// and shape them into the performance artifact. Exported for the MCP tool.
export async function loadSubnetPerformance(
  d1: D1Runner,
  netuid: unknown,
): Promise<Row> {
  const rows = await d1(
    `SELECT ${PERFORMANCE_READ_COLUMNS} FROM neurons WHERE netuid = ?`,
    [netuid],
  );
  return buildSubnetPerformance(rows, netuid);
}

// ---- Performance HISTORY (reward flow & trust over time) -------------------
// Per-day performance from the dated neuron_daily rollup, so a subnet's
// reward-flow trend (are rewards consolidating? is trust drifting?) is chartable.
// The reward-flow twin of concentration.ts's concentration/history: each day
// needs its full per-UID distribution (Gini of the reward flow + the score
// spread can't be a cheap SQL GROUP BY), so the read is the raw per-UID rows
// bounded by a row cap that then drops a truncated oldest day.
export const PERFORMANCE_HISTORY_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_PERFORMANCE_HISTORY_WINDOW = "30d";
// Safety valve on the raw per-UID read (≈256 UIDs × 90d ≈ 23k; leaves head room
// and the builder drops a truncated oldest day so every point is complete).
export const PERFORMANCE_HISTORY_ROW_CAP = 50_000;

// Parse ?window for the history route — a deliberately smaller set than the
// structural history (no 1y/all) so the raw read stays bounded. Returns
// {label, days} or {error:{parameter,message}} (the analyticsQueryError shape).
export function parseSubnetPerformanceHistoryWindow(
  value: unknown,
):
  | { label: string; days: number }
  | { error: { parameter: string; message: string } } {
  const v =
    typeof value === "string" && value
      ? value
      : DEFAULT_PERFORMANCE_HISTORY_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(PERFORMANCE_HISTORY_WINDOWS, v)) {
    return {
      error: {
        parameter: "window",
        message: `window must be one of: ${Object.keys(PERFORMANCE_HISTORY_WINDOWS).join(", ")}`,
      },
    };
  }
  return { label: v, days: PERFORMANCE_HISTORY_WINDOWS[v] };
}

// Project one day's per-UID rows to a flat, chartable performance point. Flat
// (not nested) fields keep a time series trivial to plot: the reward-flow Gini /
// Nakamoto / top-10% share for incentive (all neurons) and dividends (validators),
// plus the mean/median of the 0..1 trust, consensus, and validator_trust scores.
// Null-safe — a cold/empty day yields null metrics, never throws.
function performanceHistoryPoint(date: string, dayRows: Row[]): Row {
  const validatorRows = dayRows.filter(
    (row) => Number(row?.validator_permit) === 1,
  );
  let validatorCount = 0;
  let activeCount = 0;
  for (const row of dayRows) {
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
    if (Number(row?.active) === 1) activeCount += 1;
  }
  const incentive = computeConcentration(dayRows.map((row) => row?.incentive));
  const dividends = computeConcentration(
    validatorRows.map((row) => row?.dividends),
  );
  // Extract each score column once (rows are grouped by a valid snapshot_date, so
  // every dayRows/validatorRows entry is a real object) and share it between the
  // mean (scoreDistribution) and the conventional median (scoreMedian).
  const trustScores = dayRows.map((row) => row.trust);
  const consensusScores = dayRows.map((row) => row.consensus);
  const validatorTrustScores = validatorRows.map((row) => row.validator_trust);
  const trust = scoreDistribution(trustScores);
  const consensus = scoreDistribution(consensusScores);
  const validatorTrust = scoreDistribution(validatorTrustScores);
  return {
    snapshot_date: date,
    neuron_count: dayRows.length,
    validator_count: validatorCount,
    active_count: activeCount,
    incentive_gini: incentive?.gini ?? null,
    incentive_nakamoto_coefficient: incentive?.nakamoto_coefficient ?? null,
    incentive_top_10pct_share: incentive?.top_10pct_share ?? null,
    dividends_gini: dividends?.gini ?? null,
    dividends_nakamoto_coefficient: dividends?.nakamoto_coefficient ?? null,
    dividends_top_10pct_share: dividends?.top_10pct_share ?? null,
    trust_mean: trust?.mean ?? null,
    trust_median: scoreMedian(trustScores),
    consensus_mean: consensus?.mean ?? null,
    consensus_median: scoreMedian(consensusScores),
    validator_trust_mean: validatorTrust?.mean ?? null,
    validator_trust_median: scoreMedian(validatorTrustScores),
  };
}

// Build the per-day performance time series (newest first) from neuron_daily rows
// already ordered snapshot_date DESC. `capped` (the read hit the row cap) drops the
// oldest day, which may be a partial distribution. Null-safe: a cold store yields
// point_count:0.
export function buildSubnetPerformanceHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { window, capped }: { window?: unknown; capped?: boolean } = {},
): Row {
  const list = Array.isArray(rows) ? rows : [];
  // Group by snapshot_date. Rows arrive newest-first + same-date contiguous, so
  // Map insertion order is the newest-first date order we want.
  const byDate = new Map<string, Row[]>();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(row);
  }
  let dates = [...byDate.keys()];
  if (capped && dates.length > 1) dates = dates.slice(0, -1);
  const points = dates.map((date) =>
    performanceHistoryPoint(date, byDate.get(date) as Row[]),
  );
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
