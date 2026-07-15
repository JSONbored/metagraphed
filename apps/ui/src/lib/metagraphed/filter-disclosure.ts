/**
 * Label for the mobile "Filters" disclosure on the list routes (#5323).
 *
 * The blocks/extrinsics filter bars are placeholder-only inputs, so once they
 * collapse there is nothing on screen to say a filter is still narrowing the
 * list. The toggle carries that count instead.
 *
 * Kept pure so the counting/labelling is unit-tested apart from the DOM.
 */
export function activeFilterCount(values: readonly unknown[]): number {
  return values.filter((v) => typeof v === "string" && v.trim() !== "").length;
}

/** e.g. `Filters` when nothing is set, `Filters (2)` when two are. */
export function filterToggleLabel(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n > 0 ? `Filters (${n})` : "Filters";
}
