import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { RangeControl } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import {
  MetricHistory,
  toLinePoints,
  type MetricHistorySeries,
} from "@/components/metagraphed/metric-history";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";

// The route's own published windows (#10994) -- restating them here is
// how a chart offers a window its route rejects.
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/subnets/{netuid}/history"].window;
type Win = (typeof WINDOWS)[number];

/**
 * Per-subnet on-chain history (#1302): a window selector drives a daily
 * snapshot series; one `LineWithWindow` shows the picked metric. Renders the
 * empty state when the subnet has no history yet.
 */
export function SubnetHistoryChart({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetHistoryQuery(netuid, win));
  const points = useMemo<SubnetHistoryPoint[]>(() => res?.data?.points ?? [], [res?.data?.points]);

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof SubnetHistoryPoint) =>
      toLinePoints(
        points,
        (p) => p.snapshot_date,
        (p) => p[key],
      );
    return [
      {
        key: "neurons",
        label: "Neurons",
        unit: "neurons",
        points: pick("neuron_count"),
        format: (v) => formatNumber(v),
      },
      {
        key: "validators",
        label: "Validators",
        unit: "validators",
        points: pick("validator_count"),
        format: (v) => formatNumber(v),
      },
      {
        key: "stake",
        label: "Total stake",
        unit: "alpha staked",
        points: pick("total_stake_alpha"),
        format: formatTao,
      },
      {
        key: "emission",
        label: "Total emission",
        unit: "alpha emitted",
        points: pick("total_emission_alpha"),
        format: formatTao,
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
        <ErrorState error={error} onRetry={() => refetch()} context="subnet history" />
      ) : !hasData ? (
        <EmptyState
          title="No on-chain history"
          description="Daily snapshots will appear here once enough chain history has accumulated for this subnet."
        />
      ) : (
        <MetricHistory
          id={`subnet-${netuid}-history`}
          metrics={metrics}
          ariaLabel={`Subnet ${netuid} history`}
        />
      )}
    </div>
  );
}
