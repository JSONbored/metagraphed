/** Label/value pair used by BarMini and Donut aria synthesis. */
export interface ChartAriaDatum {
  label: string;
  value: number;
}

/** Join segment labels for `role="img"` aria-labels (matches MiniStack in stat-with-spark). */
export function chartSegmentsAriaLabel(segments: ChartAriaDatum[]): string {
  return segments.map((s) => `${s.label} ${s.value}`).join(", ");
}

export function synthesizeBarMiniAriaLabel(data: ChartAriaDatum[]): string {
  if (data.length === 0) return "Bar chart with no data";
  return chartSegmentsAriaLabel(data);
}

export function synthesizeDonutAriaLabel(segments: ChartAriaDatum[]): string {
  if (segments.length === 0) return "Donut chart with no data";
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total <= 0) return "Donut chart with no data";
  return chartSegmentsAriaLabel(segments);
}

/**
 * Accessible name for one mark in an interactive chart (#11606): the domain
 * label and, when the mark carries one, its total -- `"AUG 22 · 7.4T total"`.
 * Every `useEntityMark` call should pass a label; this is the default one.
 */
export function markAriaLabel(
  domain: string,
  total?: string | number | null,
): string {
  if (total === undefined || total === null || total === "") return domain;
  return `${domain} · ${total} total`;
}

/**
 * The one-sentence reading of a `LineWithWindow` (#11608) -- its group name
 * and what a screen reader hears before the table:
 * `"Tokens: 254T, +89% over JUN 28, 2026 → AUG 22, 2026"`.
 */
export function momentumAriaLabel(
  unit: string,
  endValue: string | null,
  deltaLabel: string,
  rangeLabel: string,
): string {
  const noun = unit.charAt(0).toUpperCase() + unit.slice(1);
  if (endValue === null) return `${noun}: no data in the window`;
  const range = rangeLabel ? ` over ${rangeLabel}` : "";
  return `${noun}: ${endValue}, ${deltaLabel}${range}`;
}
