import type { OperatorValidator } from "./types";

/**
 * The only per-hotkey fields the grouped directory reads after aggregation.
 *
 * Keeping the full OperatorValidator here put one copy of every aggregate,
 * identity and empty subnets array back into SSR dehydration even though an
 * expanded operator renders only its key, stake and take.
 */
export interface OperatorKey {
  hotkey: string;
  totalStakeTao: number;
  take: number | null;
}

export interface OperatorRow {
  /** Grouping key: the declared identity name, or the hotkey when unnamed. */
  key: string;
  name: string;
  /** Whether the name is self-declared or a truncated key standing in for one. */
  named: boolean;
  keys: OperatorKey[];
  keyCount: number;
  primaryHotkey: string;
  coldkey: string | null;
  totalStakeTao: number;
  totalEmissionTao: number;
  nominators: number | null;
  /** Total memberships across the operator's hotkeys, not distinct subnets. */
  memberships: number;
  uidCount: number;
  /** Null when no key declares one; a single value when they agree. */
  takeMin: number | null;
  takeMax: number | null;
  /** Stake-weighted, so a large key's yield is not outvoted by a dust key. */
  apyEstimate: number | null;
  dominance: number | null;
}

/**
 * Field-name-free representation stored in React Query's dehydrated cache.
 *
 * Seroval writes every object key into the HTML. Repeating fifteen descriptive
 * keys for hundreds of operators and three more for every child hotkey costs
 * more than the values themselves, so the SSR boundary uses a documented
 * tuple and the component expands it back into the readable model.
 */
export type SerializedOperatorKey = [hotkey: string, totalStakeTao: number, take: number | null];
export type SerializedOperatorRow = [
  identityName: string | null,
  multiKeyChildren: SerializedOperatorKey[],
  primaryHotkey: string,
  coldkey: string | null,
  totalStakeTao: number,
  totalEmissionTao: number,
  nominators: number | null,
  memberships: number,
  uidCount: number,
  singleKeyTake: number | null,
  apyEstimate: number | null,
];

const declaredName = (validator: OperatorValidator): string | null => {
  const identity = validator.coldkey_identity;
  const name = identity?.has_identity ? identity.name : null;
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

export const shortKey = (key: string): string =>
  key.length > 14 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;

/**
 * Validator keys aggregated into operators, largest first.
 *
 * A key with no declared identity is its own operator of one: two anonymous
 * keys sharing nothing but their anonymity are not the same team.
 */
export function operatorRows(validators: readonly OperatorValidator[]): OperatorRow[] {
  const groups = new Map<string, OperatorValidator[]>();
  for (const validator of validators) {
    const key = declaredName(validator) ?? validator.hotkey;
    const group = groups.get(key);
    if (group) group.push(validator);
    else groups.set(key, [validator]);
  }

  const rows: OperatorRow[] = [];
  for (const [key, keys] of groups) {
    const sorted = [...keys].sort((a, b) => b.total_stake_tao - a.total_stake_tao);
    const primary = sorted[0]!;
    const named = declaredName(primary) !== null;
    const takes = sorted
      .map((validator) => validator.take)
      .filter((take): take is number => typeof take === "number" && Number.isFinite(take));
    const nominatorCounts = sorted
      .map((validator) => validator.nominator_count)
      .filter((count): count is number => typeof count === "number");
    const totalStakeTao = sorted.reduce((acc, validator) => acc + validator.total_stake_tao, 0);

    let weighted = 0;
    let weight = 0;
    for (const validator of sorted) {
      if (typeof validator.apy_estimate !== "number" || !Number.isFinite(validator.apy_estimate)) {
        continue;
      }
      weighted += validator.apy_estimate * validator.total_stake_tao;
      weight += validator.total_stake_tao;
    }

    rows.push({
      key,
      name: named ? key : shortKey(primary.hotkey),
      named,
      keys: sorted.map((validator) => ({
        hotkey: validator.hotkey,
        totalStakeTao: validator.total_stake_tao,
        take: validator.take,
      })),
      keyCount: sorted.length,
      primaryHotkey: primary.hotkey,
      coldkey: primary.coldkey,
      totalStakeTao,
      totalEmissionTao: sorted.reduce((acc, validator) => acc + validator.total_emission_tao, 0),
      nominators: nominatorCounts.length > 0 ? nominatorCounts.reduce((a, b) => a + b, 0) : null,
      memberships: sorted.reduce((acc, validator) => acc + (validator.subnet_count ?? 0), 0),
      uidCount: sorted.reduce((acc, validator) => acc + validator.uid_count, 0),
      takeMin: takes.length > 0 ? Math.min(...takes) : null,
      takeMax: takes.length > 0 ? Math.max(...takes) : null,
      apyEstimate: weight > 0 ? weighted / weight : null,
      dominance: null,
    });
  }
  const ranked = rows.sort((a, b) => b.totalStakeTao - a.totalStakeTao);
  const listedStake = ranked.reduce((acc, row) => acc + row.totalStakeTao, 0);
  return ranked.map((row) => ({
    ...row,
    dominance: listedStake > 0 ? row.totalStakeTao / listedStake : null,
  }));
}

function compactDecimal(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function compactNullableDecimal(value: number | null, decimals: number): number | null {
  return value === null ? null : compactDecimal(value, decimals);
}

export function serializeOperatorRows(rows: readonly OperatorRow[]): SerializedOperatorRow[] {
  return rows.map((row) => [
    row.named ? row.key : null,
    row.keyCount > 1
      ? row.keys.map((key) => [
          key.hotkey,
          compactDecimal(key.totalStakeTao, 5),
          compactNullableDecimal(key.take, 6),
        ])
      : [],
    row.primaryHotkey,
    row.coldkey,
    compactDecimal(row.totalStakeTao, 5),
    compactDecimal(row.totalEmissionTao, 5),
    row.nominators,
    row.memberships,
    row.uidCount,
    row.keyCount === 1 ? compactNullableDecimal(row.takeMin, 6) : null,
    compactNullableDecimal(row.apyEstimate, 8),
  ]);
}

export function deserializeOperatorRows(rows: readonly SerializedOperatorRow[]): OperatorRow[] {
  const operators = rows.map((row) => {
    const identityName = row[0];
    const primaryHotkey = row[2];
    const keys =
      row[1].length > 0
        ? row[1].map((key) => ({
            hotkey: key[0],
            totalStakeTao: key[1],
            take: key[2],
          }))
        : [{ hotkey: primaryHotkey, totalStakeTao: row[4], take: row[9] }];
    const takes = keys
      .map((key) => key.take)
      .filter((take): take is number => typeof take === "number");
    return {
      key: identityName ?? primaryHotkey,
      name: identityName ?? shortKey(primaryHotkey),
      named: identityName !== null,
      keys,
      keyCount: keys.length,
      primaryHotkey,
      coldkey: row[3],
      totalStakeTao: row[4],
      totalEmissionTao: row[5],
      nominators: row[6],
      memberships: row[7],
      uidCount: row[8],
      takeMin: takes.length > 0 ? Math.min(...takes) : null,
      takeMax: takes.length > 0 ? Math.max(...takes) : null,
      apyEstimate: row[10],
      dominance: null,
    };
  });
  const listedStake = operators.reduce((acc, row) => acc + row.totalStakeTao, 0);
  return operators.map((row) => ({
    ...row,
    dominance: listedStake > 0 ? row.totalStakeTao / listedStake : null,
  }));
}
