// Per-account daily position HISTORY (block-explorer Tier-1, epic #4329/6.1).
//
// The refresh-metagraph cron lands the LATEST per-UID snapshot in Postgres's
// `neurons` (overwrite-on-conflict — no history is kept). The rollup that
// copies that snapshot into the append-only `account_position_daily` table,
// keyed by (account, netuid, snapshot_date) instead of neuron_daily's
// (netuid, uid, snapshot_date), now runs entirely on the Postgres side
// (workers/data-api.mjs's handleNeuronsSync, #4839) — in the SAME write
// transaction as the neurons/neuron_daily sync, not from a separate cron.
// account = hotkey ss58, matching loadAccountPortfolio's own "WHERE hotkey = ?"
// framing (src/account-portfolio.mjs).
//
// This module previously also owned D1's OWN rollup/prune
// (rollupAccountPositionDaily/pruneAccountPositionDaily, called from
// workers/api.mjs's NEURON_HISTORY_ROLLUP_CRON) as a parallel write path.
// That D1 side is retired here: #4908 (#4772, D1 chain-data write-path
// retirement) dropped D1's `neurons` table entirely, so a `FROM neurons`
// D1 rollup query can no longer even run — confirmed live via `wrangler d1
// execute` returning "no such table: neurons", and D1's own
// account_position_daily table frozen at 2026-07-11 (the day #4908 merged)
// ever since. #4839 already gave this table a fully independent, live-
// verified Postgres write + read path, so nothing depends on the D1 side.
// This module is now READ-PATH ONLY: the shaping/formatting helpers the
// Postgres-backed handleAccountPositionHistory route
// (workers/request-handlers/entities.mjs) and workers/data-api.mjs's own
// Postgres query both share.
//
// Known scope limitation: "position"/stake_tao here is a HOTKEY's own
// registered-neuron stake (for a validator hotkey, the FULL pool delegated to
// it by every nominator — migrations/0007_neurons.sql's stake_tao comment),
// not a coldkey's aggregate nominator/delegated stake across OTHER people's
// validators. A wallet that only delegates (never registers its own hotkey)
// will show near-zero history here despite genuinely holding alpha — that
// delegated-stake concept only exists as an account_events log today (would
// need balance reconstruction, out of scope for this issue). Matches
// loadAccountPortfolio's existing, equally-unqualified "WHERE hotkey = ?"
// framing (src/account-portfolio.mjs) — not a new gap, but worth restating
// here since epic #4329 explicitly frames this as taostats.io's (coldkey-
// centric) "Alpha Holdings" feature.

// ---- Read path (block-explorer Tier-1, epic #4329/6.2) --------------------
// GET /api/v1/accounts/{ss58}/subnets/{netuid}/history — the per-position
// counterpart to /accounts/{ss58}/portfolio's live cross-subnet snapshot, one
// point per snapshot_date for a single (account, netuid) pair. Field shape
// mirrors buildAccountPortfolio's per-position object (src/account-portfolio.mjs)
// since account_position_daily's columns were deliberately sized to match
// ACCOUNT_PORTFOLIO_READ_COLUMNS (see the migration's header comment) — a point
// here and a `positions[]` entry there should read as the same "position",
// just at different times. netuid is NOT repeated per-point (it's the fixed
// scope of the whole query, like SubnetHistoryArtifact's points omitting the
// netuid every row shares) — only `uid` and `coldkey` can legitimately vary
// day-to-day for one (account, netuid) pair (a hotkey re-registering at a new
// UID slot, or a coldkey key-rotation), so those travel with each point.

// SELECT list for one (account, netuid) day of account_position_daily.
export const ACCOUNT_POSITION_DAILY_READ_COLUMNS =
  "snapshot_date, captured_at, uid, coldkey, active, validator_permit, " +
  "rank, trust, incentive, dividends, stake_tao, emission_tao";

// 1 TAO = 1e9 rao; round tao + yield outputs to that precision (matches
// account-portfolio.mjs's round9 — each module owns its own copy, this
// codebase's established convention for these small numeric coercions).
const SCALE = 1e9;
function round9(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableScore(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

function toInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Emission-per-stake return rate; null when stake is 0 (undefined return).
// Mirrors computeYieldValue in account-portfolio.mjs.
function computeYieldValue(emission: number, stake: number): number | null {
  if (!(stake > 0)) return null;
  return round9(emission / stake);
}

// One day's position, in the same field shape as buildAccountPortfolio's
// `positions[]` entries (minus netuid — see the read-path header comment).
// Exported (unlike account-portfolio.mjs's inline per-row mapping) so its
// field coercion can be unit-tested directly, matching formatRuntimeTransition
// (src/runtime-versions.mjs)'s precedent for a history route's row formatter.
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
  const stake = toNumber(row.stake_tao);
  const emission = toNumber(row.emission_tao);
  const isValidator = Number(row.validator_permit) === 1;
  return {
    uid: toInt(row.uid),
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
