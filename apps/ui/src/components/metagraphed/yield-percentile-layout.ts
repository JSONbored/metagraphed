/**
 * Responsive layout tokens for the Yield tab percentile summary strip (P25 /
 * Median / P75 / P90). The strip sits in a half-width column beside the
 * validator/miner split from the `md` breakpoint upward; viewport `sm`
 * breakpoints are therefore a poor fit — container queries key off the card's
 * actual width instead.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3934
 */

/** Minimum container width before switching from a 2×2 grid to a single 4-up row. */
export const YIELD_PERCENTILE_FOUR_COL_MIN_WIDTH = "28rem";

/** Outer card — enables `@min-[28rem]:` container queries on descendants. */
export const YIELD_PERCENTILE_STRIP_CONTAINER_CLASS =
  "@container rounded-xl border border-border bg-card p-4";

/**
 * Inner stat grid. Below {@link YIELD_PERCENTILE_FOUR_COL_MIN_WIDTH} the strip
 * stays 2×2 so long `fmtYield` strings (e.g. `0.00160%`) never collide; at
 * wider containers it matches the Concentration context strip's 4-up layout.
 */
export const YIELD_PERCENTILE_STRIP_GRID_CLASS = "grid grid-cols-2 gap-3 @min-[28rem]:grid-cols-4";

/** Label row — mirrors Concentration panel `Fact` labels. */
export const YIELD_PERCENTILE_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

/**
 * Value row — slightly smaller below the four-column threshold, then steps up
 * to the shared `Fact` display size used elsewhere on subnet profile cards.
 */
export const YIELD_PERCENTILE_VALUE_CLASS =
  "mt-1 min-w-0 truncate font-display text-sm font-semibold tabular-nums text-ink-strong leading-none @min-[20rem]:text-base @min-[28rem]:text-lg";

export type YieldPercentileKey = "p25" | "median" | "p75" | "p90";

export type YieldPercentileDatum = {
  key: YieldPercentileKey;
  label: string;
  value: string;
};

const PERCENTILE_LABELS: Record<YieldPercentileKey, string> = {
  p25: "p25",
  median: "Median",
  p75: "p75",
  p90: "p90",
};

/** Build the four percentile tiles in display order for the summary strip. */
export function buildYieldPercentileData(input: {
  p25_yield?: number | null;
  median_yield?: number | null;
  p75_yield?: number | null;
  p90_yield?: number | null;
  formatYield: (value?: number | null) => string;
}): YieldPercentileDatum[] {
  const { formatYield } = input;
  return (["p25", "median", "p75", "p90"] as const).map((key) => ({
    key,
    label: PERCENTILE_LABELS[key],
    value: formatYield(
      key === "p25"
        ? input.p25_yield
        : key === "median"
          ? input.median_yield
          : key === "p75"
            ? input.p75_yield
            : input.p90_yield,
    ),
  }));
}

/**
 * Returns whether a container of `widthPx` should use the 4-up layout.
 * Exported for unit tests — mirrors the `@min-[28rem]` Tailwind breakpoint.
 */
export function shouldUseYieldPercentileFourColumnLayout(widthPx: number): boolean {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return false;
  const rootFontPx = 16;
  const thresholdPx = parseFloat(YIELD_PERCENTILE_FOUR_COL_MIN_WIDTH) * rootFontPx;
  return widthPx >= thresholdPx;
}
