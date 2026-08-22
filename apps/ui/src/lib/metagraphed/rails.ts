import type { RankedRailItem } from "@jsonbored/ui-kit";

/**
 * `{ label, value }` rows → `RankedRails` items keyed by label. The shape
 * every "distribution" in the app already produces; the key is the label
 * because that is what the rest of the page cross-highlights on (a subnet
 * "SN3", a pallet "SubtensorModule", a UID "#12").
 */
export function railItems(
  rows: ReadonlyArray<{ label: string; value: number; href?: string }>,
  keyOf: (row: { label: string; value: number }) => string = (r) => r.label,
): RankedRailItem[] {
  return rows
    .filter((r) => Number.isFinite(r.value))
    .map((r) => ({ key: keyOf(r), label: r.label, value: r.value, href: r.href }));
}
