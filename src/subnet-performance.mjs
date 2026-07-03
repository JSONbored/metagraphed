// Subnet performance / reward-distribution metrics: pure statistics over a
// subnet's per-UID PERFORMANCE columns (incentive, dividends, trust, consensus,
// validator_trust) from the live `neurons` D1 tier. This is the reward-flow and
// trust companion to concentration.mjs — concentration measures who holds the
// STAKE/EMISSION; this measures how concentrated the actual REWARDS are and how
// the 0..1 trust/consensus scores are spread across the neurons. Every function
// is pure + exported for unit tests; the Worker does the D1 read + envelope.
// Null-safe by design: an empty / all-zero distribution yields a schema-stable
// `null` block (never throws), matching the concentration tier it mirrors.

import { computeConcentration } from "./concentration.mjs";

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
function round(value) {
  const factor = 1e6;
  return Math.round(value * factor) / factor;
}

// Guard 0/negative epoch ms (a blank/sentinel D1 cell) so a captured_at never
// stamps the 1970 epoch. Mirrors epochMsStamp in concentration.mjs / the
// account-events + snapshot fixes (#2776/#2777).
function epochMsStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

function captureStamp(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    // D1 can return an INTEGER captured_at as a numeric-epoch string; Date.parse
    // returns NaN for a bare epoch string, so coerce it like concentration.mjs.
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
function finiteValues(values) {
  const out = [];
  for (const raw of values) {
    // Guard null/undefined/blank BEFORE Number(): Number(null) / Number("") are 0,
    // which would count an absent score as a real 0 and pollute the distribution.
    if (raw == null || raw === "") continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Nearest-rank percentile over a non-empty ascending array (rank = ceil(p/100 · n),
// 1-based), matching the subnet-yield / health-percentile convention. Only called
// after scoreDistribution has established count > 0, so the array is never empty.
function percentile(ascending, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[rank - 1];
}

// Distribution summary for one 0..1 score column, or `null` when no neuron carries
// a finite value (cold store / empty subnet / all-null column). count/mean plus the
// SCORE_PERCENTILES spread and the min/max, all rounded to a stable precision.
export function scoreDistribution(values) {
  const finite = finiteValues(Array.isArray(values) ? values : []);
  const count = finite.length;
  if (count === 0) return null;
  const ascending = [...finite].sort((a, b) => a - b);
  const total = finite.reduce((sum, v) => sum + v, 0);
  const summary = {
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
export function buildSubnetPerformance(rows, netuid) {
  const list = Array.isArray(rows) ? rows : [];
  // The rows share one cron capture, but don't assume an order — take the newest.
  let capturedAt = null;
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
export async function loadSubnetPerformance(d1, netuid) {
  const rows = await d1(
    `SELECT ${PERFORMANCE_READ_COLUMNS} FROM neurons WHERE netuid = ?`,
    [netuid],
  );
  return buildSubnetPerformance(rows, netuid);
}
