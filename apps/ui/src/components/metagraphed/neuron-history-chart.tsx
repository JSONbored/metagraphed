import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetNeuronHistoryQuery } from "@/lib/metagraphed/queries";
import { RangeControl } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import {
  MetricHistory,
  toLinePoints,
  type MetricHistorySeries,
} from "@/components/metagraphed/metric-history";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { SubnetNeuronHistoryPoint } from "@/lib/metagraphed/types";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";

// The route's own published windows (#10994) -- restating them here is
// how a chart offers a window its route rejects.
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/subnets/{netuid}/neurons/{uid}/history"].window;
type Win = (typeof WINDOWS)[number];

function scoreStr(v: number) {
  return Number.isFinite(v) ? v.toFixed(3) : "—";
}

/**
 * Per-UID on-chain history (#1302). Mirrors SubnetHistoryChart: a window
 * selector drives a daily snapshot series; the picked metric (emission,
 * incentive, consensus, dividends, stake, rank) is one `LineWithWindow`.
 */
export function NeuronHistoryChart({ netuid, uid }: { netuid: number; uid: number }) {
  const [win, setWin] = useState<Win>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetNeuronHistoryQuery(netuid, uid, win));
  const points = useMemo<SubnetNeuronHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof SubnetNeuronHistoryPoint) =>
      toLinePoints(
        points,
        (p) => p.snapshot_date,
        (p) => p[key],
      );
    return [
      {
        key: "stake",
        label: "Stake",
        unit: "TAO staked",
        points: pick("stake_tao"),
        format: formatTao,
      },
      {
        key: "emission",
        label: "Emission",
        unit: "TAO emitted",
        points: pick("emission_tao"),
        format: formatTao,
      },
      {
        key: "incentive",
        label: "Incentive",
        unit: "incentive",
        points: pick("incentive"),
        format: scoreStr,
      },
      {
        key: "consensus",
        label: "Consensus",
        unit: "consensus",
        points: pick("consensus"),
        format: scoreStr,
      },
      {
        key: "dividends",
        label: "Dividends",
        unit: "dividends",
        points: pick("dividends"),
        format: scoreStr,
      },
      {
        key: "rank",
        label: "Rank",
        unit: "rank",
        points: pick("rank"),
        format: (v) => formatNumber(v),
      },
    ];
  }, [points]);

  const hasData = metrics.some((m) => m.points.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-13 text-ink-muted">UID {uid} history</span>
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
        <ErrorState error={error} onRetry={() => refetch()} context="per-UID history" />
      ) : !hasData ? (
        <EmptyState
          title="No per-UID history"
          description="Daily snapshots for this neuron will appear here once enough chain history has accumulated."
        />
      ) : (
        <MetricHistory
          id={`neuron-${netuid}-${uid}-history`}
          metrics={metrics}
          ariaLabel={`UID ${uid} history`}
        />
      )}
    </div>
  );
}
