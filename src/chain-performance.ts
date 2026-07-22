// Network-wide performance / reward-distribution metrics: pure statistics over
// EVERY subnet's per-UID PERFORMANCE columns (incentive, dividends, trust,
// consensus, validator_trust) from the live `neurons` D1 tier. The network analog
// of a per-subnet reward scorecard and the reward-flow companion to
// chain-concentration.mjs — concentration measures who holds the STAKE/EMISSION
// across the network; this measures how concentrated the actual REWARDS are and
// how the 0..1 trust/consensus scores are spread across all neurons at once.
// Every function is pure + exported for unit tests; the Worker does the D1 read +
// envelope. Null-safe: an empty snapshot yields a schema-stable `null` block.

import { computeConcentration } from "./concentration.ts";

// The neurons-tier columns the network performance handler reads — like the
// per-subnet read but with `netuid`, so the artifact can report how many subnets
// the current snapshot spans (mirrors CHAIN_CONCENTRATION_READ_COLUMNS).
export const CHAIN_PERFORMANCE_READ_COLUMNS =
  "incentive, dividends, trust, consensus, validator_trust, " +
  "active, validator_permit, netuid, captured_at";

// The 0..1 score columns reported as a percentile spread (a bounded score has no
// "share of a total" to be unequal over, so a distribution summary is the lens).
const SCORE_PERCENTILES = [10, 25, 50, 75, 90];

// Round a score/mean to 6 dp so JSON never carries a long floating-point tail.
// Callers only ever pass finite values (finiteValues drops non-finite cells and
// scoreDistribution guards count > 0), so no null-guard is needed here.
function round(value: number): number {
  const factor = 1e6;
  return Math.round(value * factor) / factor;
}

interface CaptureStamp {
  ms: number;
  value: string;
}

function epochMsStamp(ms: number): CaptureStamp | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

function captureStamp(value: unknown): CaptureStamp | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      return epochMsStamp(Number(value));
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, value };
    return null;
  }
  if (typeof value === "number") {
    return epochMsStamp(value);
  }
  return null;
}

// Coerce a raw column array to the finite values present. A score of exactly 0 is
// a real observation (a neuron with zero trust IS part of the spread), so only
// null/NaN/blank cells are dropped — the `count` reflects the neurons that carry
// a score.
function finiteValues(values: unknown[]): number[] {
  const out: number[] = [];
  for (const raw of values) {
    // trim() catches whitespace-only cells too, not just the exact empty string
    // (Number(" ") === 0, which would count an absent score as a real 0).
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

export interface ScoreDistribution {
  count: number;
  mean: number;
  min: number;
  max: number;
  [key: `p${number}`]: number;
}

// Distribution summary for one 0..1 score column, or `null` when no neuron carries
// a finite value (cold store / empty network / all-null column). count/mean plus
// the SCORE_PERCENTILES spread and the min/max, all rounded to a stable precision.
export function scoreDistribution(values: unknown[]): ScoreDistribution | null {
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

// Shape EVERY subnet's neurons-tier rows into the network performance artifact —
// two lenses over the whole-network snapshot:
//   • reward CONCENTRATION → `incentive`, `dividends` (Gini/HHI/Nakamoto/top-share
//     of the actual reward flow across ALL neurons — how few capture most rewards
//     network-wide, the genuinely new measurement a per-subnet view can't give)
//   • score DISTRIBUTION   → `trust`, `consensus`, `validator_trust` (the p10..p90
//     spread of the 0..1 performance scores across the whole network)
// plus `subnet_count` (subnets the snapshot spans) and neuron/validator/active
// counts. Null-safe on junk/sparse rows — an empty array yields a schema-stable
// zero (every metric block null).
export interface ChainPerformanceResult {
  schema_version: 1;
  subnet_count: number;
  neuron_count: number;
  validator_count: number;
  active_count: number;
  captured_at: string | null;
  incentive: unknown;
  dividends: unknown;
  trust: ScoreDistribution | null;
  consensus: ScoreDistribution | null;
  validator_trust: ScoreDistribution | null;
}

export function buildChainPerformance(
  rows: Array<Record<string, unknown>> | null | undefined,
): ChainPerformanceResult {
  const list = Array.isArray(rows) ? rows : [];
  let capturedAt: CaptureStamp | null = null;
  let validatorCount = 0;
  let activeCount = 0;
  const netuids = new Set<number>();
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
    if (Number(row?.active) === 1) activeCount += 1;
    const rawNetuid = row?.netuid;
    if (rawNetuid != null) {
      // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
      if (typeof rawNetuid === "string" && rawNetuid.trim() === "") continue;
      const netuid = Number(rawNetuid);
      // Guard the coercion: a non-numeric cell must not count as subnet 0.
      if (Number.isInteger(netuid) && netuid >= 0) netuids.add(netuid);
    }
  }
  const validatorRows = list.filter(
    (row) => Number(row?.validator_permit) === 1,
  );
  return {
    schema_version: 1,
    subnet_count: netuids.size,
    neuron_count: list.length,
    validator_count: validatorCount,
    active_count: activeCount,
    captured_at: capturedAt?.value ?? null,
    // Reward-flow concentration (who actually earns) across the whole network.
    incentive: computeConcentration(list.map((row) => row?.incentive)),
    dividends: computeConcentration(validatorRows.map((row) => row?.dividends)),
    // 0..1 score spread across the whole network.
    trust: scoreDistribution(list.map((row) => row?.trust)),
    consensus: scoreDistribution(list.map((row) => row?.consensus)),
    validator_trust: scoreDistribution(
      validatorRows.map((row) => row?.validator_trust),
    ),
  };
}

// Shared D1 loader (mirrors handleChainPerformance + loadChainConcentration): read
// EVERY subnet's neurons in one pass, no netuid filter, and shape them into the
// network performance artifact. Exported for the MCP tool.
export async function loadChainPerformance(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
): Promise<ChainPerformanceResult> {
  const rows = await d1(
    `SELECT ${CHAIN_PERFORMANCE_READ_COLUMNS} FROM neurons`,
    [],
  );
  return buildChainPerformance(rows);
}
