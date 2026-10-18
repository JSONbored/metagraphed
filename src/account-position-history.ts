import { numberOrZero, round9 } from "./lib/rao.ts";
import { nonNegativeIntOrNull } from "./read-store.ts";
// Periodic hotkey/subnet neuron observations (epic #4329/6.1).
//
// account_position_daily is keyed by (account, netuid, snapshot_date), where
// account is a hotkey, matching account-portfolio.ts. It records membership,
// operational scores and emission observations from neuron snapshots. It is
// not a coldkey's nominator ledger or a reconstruction of wallet balances.
//
// The legacy stake_tao column contains runtime voting weight, not independent
// native-alpha or TAO principal (#12014). Preserve historical numeric values
// and ratios for compatibility without interpreting them as asset holdings,
// allocation or investment returns. Missing rows do not prove an empty wallet
// or complete Root coverage. The public contract describes this boundary in
// schemas-src/routes/account-positions.ts.
//
// Read/format helpers only. The old D1 rollup/prune path was retired in #4908;
// this module does not create observations or establish current freshness.

// ---- Read path (block-explorer Tier-1, epic #4329/6.2) --------------------
// GET /api/v1/accounts/{ss58}/subnets/{netuid}/history returns one recorded
// point per snapshot_date for that hotkey/subnet. Legacy quantity fields differ
// from the portfolio's withheld compatibility fields; neither certifies asset
// holdings. netuid scopes the series, while uid/coldkey may vary across rows.

function nullableScore(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Legacy emission/voting-weight ratio, not an investment return. Preserve the
// historical calculation; a zero denominator leaves the ratio unavailable.
function computeYieldValue(emission: number, stake: number): number | null {
  if (!(stake > 0)) return null;
  return round9(emission / stake);
}

// One day's recorded neuron membership with legacy numeric compatibility keys.
// Exported so historical field coercion can be checked independently.
export interface AccountPositionEntry {
  uid: number | null;
  coldkey: unknown;
  role: "validator" | "miner";
  active: boolean;
  stake_tao: number;
  emission_tao: number;
  rank: number | null;
  trust: number | null;
  incentive: number | null;
  dividends: number | null;
  yield: number | null;
}

export function formatAccountPosition(
  row: Record<string, unknown> | null | undefined,
): AccountPositionEntry | null {
  if (!row || typeof row !== "object") return null;
  const stake = numberOrZero(row.stake_tao);
  const emission = numberOrZero(row.emission_tao);
  const isValidator = Number(row.validator_permit) === 1;
  return {
    uid: nonNegativeIntOrNull(row.uid),
    coldkey: row.coldkey ?? null,
    role: isValidator ? "validator" : "miner",
    active: Number(row.active) === 1,
    stake_tao: round9(stake),
    emission_tao: round9(emission),
    rank: nullableScore(row.rank),
    trust: nullableScore(row.trust),
    incentive: nullableScore(row.incentive),
    dividends: nullableScore(row.dividends),
    yield: computeYieldValue(emission, stake),
  };
}

// Per-account, per-subnet time series: one point per snapshot_date (the
// handler queries newest first, bounded by MAX_HISTORY_POINTS from
// neuron-history.ts — the shared history-window vocabulary every other
// history route already reuses). Mirrors buildNeuronHistory's shape
// (src/neuron-history.ts), the response-builder template this issue names.
export interface AccountPositionHistoryPoint extends AccountPositionEntry {
  snapshot_date: unknown;
  captured_at: string | null;
}

export interface AccountPositionHistoryResult {
  schema_version: 1;
  ss58: string;
  netuid: number;
  window: string | null;
  point_count: number;
  points: AccountPositionHistoryPoint[];
}

export function buildAccountPositionHistory(
  rows: Array<Record<string, unknown>> | null | undefined,
  ss58: string,
  netuid: number,
  { window }: { window?: string | null } = {},
): AccountPositionHistoryResult {
  const points: AccountPositionHistoryPoint[] = (rows || [])
    .map((r) => {
      const position = formatAccountPosition(r);
      if (!position) return null;
      return {
        snapshot_date: r.snapshot_date,
        captured_at: toIso(r.captured_at),
        ...position,
      };
    })
    .filter((point): point is AccountPositionHistoryPoint => point !== null);
  return {
    schema_version: 1,
    ss58,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
