/**
 * The derivations behind /validators (#11616).
 *
 * The page's unit is the OPERATOR, not the key: teams run several validator
 * hotkeys (1,021 keys across ~148 operators), and a flat per-key list repeats
 * the same brand at every rank its keys land on while splitting the stake a
 * delegator is actually choosing between.
 */
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type { OperatorValidator } from "@/lib/metagraphed/types";
import { formatAmount, formatPct } from "@/lib/metagraphed/format";

/**
 * Every validator in one request.
 *
 * `/api/v1/validators` has no server-side sort worth paging against and the
 * set is ~1,000 keys, so the page fetches it once and works over it locally.
 * It lives here rather than on the route module because the homepage's
 * Watched module requests the identical query -- same sort + limit is the
 * same cache key, and a second 2,000-row fetch is what the shared constant
 * prevents (#8256). A route module cannot own it: #11616 rewrote that file
 * from blank and the import broke.
 */
export const ALL_VALIDATORS_LIMIT = 2000;

export interface OperatorRow {
  /** Grouping key: the declared identity name, or the hotkey when unnamed. */
  key: string;
  name: string;
  /** Whether the name is self-declared or a truncated key standing in for one. */
  named: boolean;
  keys: OperatorValidator[];
  keyCount: number;
  primaryHotkey: string;
  coldkey: string | null;
  totalStakeTao: number;
  totalEmissionTao: number;
  nominators: number | null;
  /**
   * Total MEMBERSHIPS across the operator's hotkeys, not distinct subnets.
   *
   * It used to be `new Set(keys.flatMap(k => k.subnets.map(s => s.netuid))).size`
   * -- and it read 0 for all 604 operators, because /validators asks for
   * `subnets: false` (#11315) to keep a megabyte of per-subnet breakdown out of
   * the SSR dehydration, so the array those netuids came from is always empty.
   * A column of zeroes, sortable, on every load since that landed (#11695).
   *
   * `subnet_count` is a scalar the projection keeps, so summing it survives.
   * It counts memberships rather than distinct subnets -- two of an operator's
   * keys on one subnet count twice -- which is why the column says
   * "Memberships", the same word the detail page uses.
   */
  memberships: number;
  uidCount: number;
  /** Null when no key declares one; a single value when they agree. */
  takeMin: number | null;
  takeMax: number | null;
  /** Stake-weighted, so a large key's yield is not outvoted by a dust key. */
  apyEstimate: number | null;
  dominance: number | null;
}

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
 * keys sharing nothing but their anonymity are not the same team, and
 * merging them would invent an operator that does not exist.
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

    // Stake-weighted APY. A plain mean lets a 1 τ key with a wild estimate
    // move an operator's headline as much as its 900k τ key does.
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
      keys: sorted,
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
      dominance: sorted.reduce((acc, validator) => acc + (validator.stake_dominance ?? 0), 0),
    });
  }
  return rows.sort((a, b) => b.totalStakeTao - a.totalStakeTao);
}

/** A take that may be one value or a spread across an operator's keys. */
export function takeLabel(min: number | null, max: number | null): string {
  if (min === null || max === null) return "—";
  const fmt = (value: number) => `${formatPct(value, 1)}`;
  return Math.abs(max - min) < 0.0005 ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

export const fmtStake = (value: number | null | undefined): string => formatAmount(value, "τ");

/** The middle value, or null for an empty set — never 0, which is a reading. */
export function median(values: readonly (number | null | undefined)[]): number | null {
  const finite = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[middle - 1]! + finite[middle]!) / 2 : finite[middle]!;
}

export interface ConcentrationSegment {
  key: string;
  label: string;
  value: number;
  href?: string;
}

/**
 * Operator stake as shares of the stake the listed operators hold between
 * them. The denominator is stated wherever this renders: the validators
 * endpoint serves a ranked slice, not the whole network.
 */
export function concentration(
  rows: readonly OperatorRow[],
  top = 10,
): { segments: ConcentrationSegment[]; listedTotal: number } {
  const listedTotal = rows.reduce((acc, row) => acc + row.totalStakeTao, 0);
  const head = rows.slice(0, top).filter((row) => row.totalStakeTao > 0);
  const tail = rows.slice(top);
  const segments: ConcentrationSegment[] = head.map((row) => ({
    key: row.key,
    label: row.name,
    value: row.totalStakeTao,
    href: `/validators/${row.primaryHotkey}`,
  }));
  const rest = tail.reduce((acc, row) => acc + row.totalStakeTao, 0);
  if (rest > 0) {
    segments.push({ key: RESIDUAL_KEY, label: `${tail.length} more operators`, value: rest });
  }
  return { segments, listedTotal };
}

/** Narrows the operator table to the toolbar's filters. */
export function filterOperators(
  rows: readonly OperatorRow[],
  filters: { q?: string; minStake?: number; namedOnly?: boolean },
): OperatorRow[] {
  const query = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (filters.namedOnly && !row.named) return false;
    if (filters.minStake && row.totalStakeTao < filters.minStake) return false;
    if (query) {
      const haystack = [
        row.name,
        row.primaryHotkey,
        row.coldkey ?? "",
        ...row.keys.map((k) => k.hotkey),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
