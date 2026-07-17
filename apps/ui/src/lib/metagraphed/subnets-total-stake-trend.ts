import type { EconomicsTrendsDay } from "@/lib/metagraphed/types";
import type { SparklinePoint } from "@jsonbored/ui-kit";

/**
 * Shape the network-wide total-stake series for the /subnets headline tile (#6271).
 *
 * `economics/trends` returns days newest-first (same contract explorer.tsx relies
 * on). We reverse for chronological sparklines and surface the newest day's stake
 * as the tile value — a static latest-only tile is not enough for #6271.
 */
export function totalStakeTrendFromDays(days: EconomicsTrendsDay[]): {
  latestTao: number | null;
  values: number[];
  points: SparklinePoint[];
} {
  const chrono = [...days].reverse();
  const latestTao = days[0]?.total_stake_tao ?? null;
  return {
    latestTao,
    values: chrono.map((d) => d.total_stake_tao ?? 0),
    points: chrono.map((d) => ({
      t: d.snapshot_date,
      v: d.total_stake_tao ?? 0,
    })),
  };
}
