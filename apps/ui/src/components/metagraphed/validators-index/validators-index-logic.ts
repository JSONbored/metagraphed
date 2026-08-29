/**
 * The derivations behind /validators (#11616).
 *
 * The page's unit is the OPERATOR, not the key: teams run several validator
 * hotkeys (1,021 keys across ~148 operators), and a flat per-key list repeats
 * the same brand at every rank its keys land on while splitting the stake a
 * delegator is actually choosing between.
 */
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import { formatAmount, formatPct } from "@/lib/metagraphed/format";
import type { OperatorRow } from "@/lib/metagraphed/validator-operators";
export { operatorRows, shortKey } from "@/lib/metagraphed/validator-operators";
export type { OperatorRow } from "@/lib/metagraphed/validator-operators";

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
