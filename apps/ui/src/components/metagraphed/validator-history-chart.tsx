import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { validatorHistoryQuery } from "@/lib/metagraphed/queries";
import { RangeControl } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import {
  MetricHistory,
  toLinePoints,
  type MetricHistorySeries,
} from "@/components/metagraphed/metric-history";
import type { ValidatorHistoryPoint } from "@/lib/metagraphed/types";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";

// The route's own published windows (#10994) -- restating them here is
// how a chart offers a window its route rejects.
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/validators/{hotkey}/history"].window;
type Win = (typeof WINDOWS)[number];

function taoStr(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  return `${v.toFixed(v < 10 ? 3 : 2)} τ`;
}

function rewardsStr(v: number) {
  return Number.isFinite(v) ? `${v.toFixed(4)} τ/1k` : "—";
}

/** Staked-over-time + rewards-per-1000-TAO daily history for one validator
 * (#4337/7.3), reusing the neuron_daily rollup. Empty state when the validator
 * has no history yet (e.g. a freshly-registered hotkey). */
export function ValidatorHistoryChart({ hotkey }: { hotkey: string }) {
  const [win, setWin] = useState<Win>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(validatorHistoryQuery(hotkey, win));
  const points = useMemo<ValidatorHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof ValidatorHistoryPoint) =>
      toLinePoints(
        points,
        (p) => p.snapshot_date,
        (p) => p[key],
      );
    return [
      {
        key: "stake",
        label: "Staked",
        unit: "TAO staked",
        points: pick("total_stake_tao"),
        format: taoStr,
      },
      {
        key: "rewards",
        label: "Rewards / 1k τ",
        unit: "TAO per 1k staked",
        points: pick("rewards_per_1000_tao"),
        format: rewardsStr,
      },
    ];
  }, [points]);

  const hasData = metrics.some((m) => m.points.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <RangeControl
          label="History window"
          options={WINDOWS.map((w) => ({ value: w, label: String(w) }))}
          value={win}
          onChange={setWin}
        />
      </div>
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="validator history" />
      ) : !hasData ? (
        <EmptyState
          title="No history yet"
          description="Daily snapshots will appear here once enough chain history has accumulated for this validator."
        />
      ) : (
        <MetricHistory
          id={`validator-${hotkey}-history`}
          metrics={metrics}
          ariaLabel="Validator history"
        />
      )}
    </div>
  );
}
