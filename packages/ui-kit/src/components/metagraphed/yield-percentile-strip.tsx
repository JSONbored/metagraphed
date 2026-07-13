import type { ReactNode } from "react";
import {
  YIELD_PERCENTILE_LABEL_CLASS,
  YIELD_PERCENTILE_STRIP_CONTAINER_CLASS,
  YIELD_PERCENTILE_STRIP_GRID_CLASS,
  YIELD_PERCENTILE_VALUE_CLASS,
  buildYieldPercentileData,
  type YieldPercentileDatum,
} from "@/components/metagraphed/yield-percentile-layout";
import { fmtYield } from "@/components/metagraphed/yield-format";

function PercentileFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={YIELD_PERCENTILE_LABEL_CLASS}>{label}</div>
      <div className={YIELD_PERCENTILE_VALUE_CLASS}>{value}</div>
    </div>
  );
}

export type YieldPercentileStripProps = {
  p25_yield?: number | null;
  median_yield?: number | null;
  p75_yield?: number | null;
  p90_yield?: number | null;
  /** Optional override for tests/story fixtures. */
  data?: YieldPercentileDatum[];
};

/**
 * Yield tab percentile summary (P25 / Median / P75 / P90). Uses container
 * queries so the row stays 2×2 when the card is half-width at tablet (768px)
 * beside the validator/miner split, matching Concentration readability without
 * touching that panel's implementation.
 */
export function YieldPercentileStrip({
  p25_yield,
  median_yield,
  p75_yield,
  p90_yield,
  data,
}: YieldPercentileStripProps) {
  const tiles =
    data ??
    buildYieldPercentileData({
      p25_yield,
      median_yield,
      p75_yield,
      p90_yield,
      formatYield: fmtYield,
    });

  return (
    <section
      className={YIELD_PERCENTILE_STRIP_CONTAINER_CLASS}
      aria-label="Yield percentile distribution"
    >
      <div className={YIELD_PERCENTILE_STRIP_GRID_CLASS}>
        {tiles.map((tile) => (
          <PercentileFact
            key={tile.key}
            label={tile.label}
            value={tile.value}
          />
        ))}
      </div>
    </section>
  );
}
