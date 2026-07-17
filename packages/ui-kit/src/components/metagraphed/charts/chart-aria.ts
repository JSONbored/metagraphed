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
 * Fallback accessible names for the line-series primitives' empty states
 * (#6375). BarMini/Donut synthesize a label from their data; Sparkline and
 * CandlestickMini have no data to describe when empty, so their fallback is a
 * constant.
 *
 * The phrasing keeps both existing conventions: "<chart> with no data" matches
 * synthesizeBarMiniAriaLabel/synthesizeDonutAriaLabel above, and the chart noun
 * matches each component's own `ariaLabel ?? "..."` fallback for its keyboard
 * hint (sparkline.tsx, candlestick-mini.tsx).
 */
export const SPARKLINE_EMPTY_ARIA_LABEL = "Sparkline chart with no data";
export const CANDLESTICK_MINI_EMPTY_ARIA_LABEL =
  "Candlestick chart with no data";
