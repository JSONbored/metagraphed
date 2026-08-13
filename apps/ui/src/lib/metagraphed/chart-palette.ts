// The categorical chart palette, declared once (#10987 follow-up): the
// holdings history chart and the explorer's call-mix legend each carried the
// six-swatch list privately, and a seventh chart would have made a third.
export const CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;
