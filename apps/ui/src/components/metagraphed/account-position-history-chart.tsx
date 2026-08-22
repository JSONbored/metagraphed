import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accountPositionHistoryQuery } from "@/lib/metagraphed/queries";
import { RangeControl } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import {
  MetricHistory,
  toLinePoints,
  type MetricHistorySeries,
} from "@/components/metagraphed/metric-history";
import type { AccountPositionHistoryPoint } from "@/lib/metagraphed/types";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";

// The route's own published windows (#10994) -- restating them here is
// how a chart offers a window its route rejects.
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/accounts/{ss58}/subnets/{netuid}/history"].window;
type Win = (typeof WINDOWS)[number];

function taoStr(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  return `${v.toFixed(v < 10 ? 3 : 2)} τ`;
}

function yieldStr(v: number) {
  return Number.isFinite(v) ? v.toExponential(2) : "—";
}

/** Staked/emission-over-time + yield daily history for one account's position
 * on one subnet -- the "Alpha Holdings chart" (#4329/6.4), reusing the
 * account_position_daily rollup. Empty state when this position has no
 * history yet (e.g. a freshly-registered neuron). */
export function AccountPositionHistoryChart({ ss58, netuid }: { ss58: string; netuid: number }) {
  const [win, setWin] = useState<Win>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(accountPositionHistoryQuery(ss58, netuid, win));
  const points = useMemo<AccountPositionHistoryPoint[]>(
    () => res?.data?.points ?? [],
    [res?.data?.points],
  );

  const metrics = useMemo<MetricHistorySeries[]>(() => {
    const pick = (key: keyof AccountPositionHistoryPoint) =>
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
        points: pick("stake_tao"),
        format: taoStr,
      },
      {
        key: "emission",
        label: "Emission",
        unit: "TAO emitted",
        points: pick("emission_tao"),
        format: taoStr,
      },
      { key: "yield", label: "Yield", unit: "yield", points: pick("yield"), format: yieldStr },
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
        <ErrorState error={error} onRetry={() => refetch()} context="position history" />
      ) : !hasData ? (
        <EmptyState
          title="No history yet"
          description="Daily snapshots will appear here once enough chain history has accumulated for this position."
        />
      ) : (
        <MetricHistory
          id={`position-${ss58}-${netuid}-history`}
          metrics={metrics}
          ariaLabel={`SN${netuid} position history`}
        />
      )}
    </div>
  );
}
