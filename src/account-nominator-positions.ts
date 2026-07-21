// Nominator-side (coldkey) position reconstruction (#5233): "what does this
// coldkey actually hold, across every hotkey/subnet it delegates to" — the
// coldkey-scoped counterpart to buildAccountPortfolio's hotkey-scoped view
// (src/account-portfolio.mjs), which only ever showed near-zero for a pure
// delegator (its stake lives on someone ELSE's hotkey row, not its own).
//
// Sourced from nominator_positions (migration 0044, populated by the same
// SubtensorModule::Alpha scan as validator_nominator_counts, #2549) joined
// against the live neurons stake_tao for each referenced (hotkey, netuid) --
// see that migration's header comment for why this table stores a
// dimensionless share_fraction rather than a snapshotted TAO figure. Pure +
// exported for tests; the Worker does the Postgres reads and calls
// buildAccountPositions with both result sets.
//
// Known scope limitation (documented in the fetch script + migration too):
// root (netuid 0) stake is NOT covered -- SubtensorModule::Alpha carries no
// root data at all (root is TAO-denominated 1:1, no alpha pool, #2550), so a
// coldkey that only holds root-delegated stake shows zero positions here,
// not because it holds nothing but because this source can't see it yet.

export const NOMINATOR_POSITION_INSERT_COLUMNS = [
  "coldkey",
  "hotkey",
  "netuid",
  "share_fraction",
  "captured_at",
];

// A finite, non-negative TAO cell, or null when absent/blank/non-numeric.
// Blank Postgres cells coerce via Number("") -> 0; skip those rather than
// joining a phantom zero-stake hotkey (mirrors buildGlobalValidators/
// numberOrZero's sibling null-safety elsewhere in this codebase).
function nullableTao(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableFraction(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 1 TAO = 1e9 rao; round tao outputs to that precision (matches the sibling
// account-tier modules' own round9/roundTao helpers).
const RAO_PER_TAO = 1e9;
function roundTao(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

function round6(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

function toIso(ms: number): string | null {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export interface AccountNominatorPosition {
  hotkey: string;
  netuid: number;
  share_fraction: number | null;
  stake_tao: number;
}

export interface AccountPositionsResult {
  schema_version: 1;
  ss58: string;
  captured_at: string | null;
  position_count: number;
  total_stake_tao: number;
  positions: AccountNominatorPosition[];
}

// hotkeyNetuidStake: a Map keyed by "hotkey|netuid" -> stake_tao, built by
// the caller (loadNeuronStakeByHotkey below) from a live neurons read. A
// position whose hotkey+netuid isn't in the map (the hotkey deregistered,
// or the daily neurons snapshot hasn't caught up to a brand-new stake
// event) is excluded rather than reported with a fabricated 0 stake_tao --
// same null-never-fabricated convention as nominator_count/apy_estimate.
export function buildAccountPositions(
  positionRows: Array<Record<string, unknown>> | null | undefined,
  hotkeyNetuidStake: Map<string, number> | null | undefined,
  ss58: string,
): AccountPositionsResult {
  const rows = Array.isArray(positionRows) ? positionRows : [];
  const stakeByKey =
    hotkeyNetuidStake instanceof Map ? hotkeyNetuidStake : new Map();
  const positions: AccountNominatorPosition[] = [];
  let totalStakeTao = 0;
  let latestCapturedAt: number | null = null;

  for (const row of rows) {
    const hotkey = typeof row?.hotkey === "string" ? row.hotkey : null;
    const netuid = nonNegativeInt(row?.netuid);
    const fraction = nullableFraction(row?.share_fraction);
    if (!hotkey || netuid == null || fraction == null) continue;

    const hotkeyStake = stakeByKey.get(`${hotkey}|${netuid}`);
    if (hotkeyStake == null) continue;

    const stakeTao = roundTao(fraction * hotkeyStake);
    if (stakeTao == null) continue;
    totalStakeTao += stakeTao;

    const capturedAt = nonNegativeInt(row?.captured_at);
    if (
      capturedAt != null &&
      (latestCapturedAt == null || capturedAt > latestCapturedAt)
    ) {
      latestCapturedAt = capturedAt;
    }

    positions.push({
      hotkey,
      netuid,
      share_fraction: round6(fraction),
      stake_tao: stakeTao,
    });
  }

  // Biggest position first; tie-break by hotkey then netuid for a stable order.
  positions.sort(
    (a, b) =>
      b.stake_tao - a.stake_tao ||
      a.hotkey.localeCompare(b.hotkey) ||
      a.netuid - b.netuid,
  );

  return {
    schema_version: 1,
    ss58,
    captured_at: latestCapturedAt != null ? toIso(latestCapturedAt) : null,
    position_count: positions.length,
    total_stake_tao: roundTao(totalStakeTao) ?? 0,
    positions,
  };
}

// Distinct, order-stable, non-empty hotkeys referenced by a coldkey's
// position rows -- the input to loadNeuronStakeByHotkey's IN-list query.
export function distinctHotkeys(
  positionRows: Array<Record<string, unknown>> | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const row of Array.isArray(positionRows) ? positionRows : []) {
    if (typeof row?.hotkey === "string" && row.hotkey.length > 0) {
      seen.add(row.hotkey);
    }
  }
  return [...seen];
}

// Postgres neurons rows (hotkey, netuid, stake_tao) -> a "hotkey|netuid" ->
// stake_tao Map, for buildAccountPositions' join above.
export function stakeByHotkeyNetuid(
  neuronRows: Array<Record<string, unknown>> | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of Array.isArray(neuronRows) ? neuronRows : []) {
    const hotkey = typeof row?.hotkey === "string" ? row.hotkey : null;
    const netuid = nonNegativeInt(row?.netuid);
    const stake = nullableTao(row?.stake_tao);
    if (!hotkey || netuid == null || stake == null) continue;
    map.set(`${hotkey}|${netuid}`, stake);
  }
  return map;
}
