/** Display helpers and identity filters for the validator operator directory. */
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

/** Narrows the operator table to the toolbar's filters. */
export function filterOperators(
  rows: readonly OperatorRow[],
  filters: { q?: string; namedOnly?: boolean },
): OperatorRow[] {
  const query = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (filters.namedOnly && !row.named) return false;
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
