import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import {
  SUBNET_HISTORY_METRICS,
  SUBNET_HISTORY_WINDOWS,
  pickMetricValues,
  type SubnetHistoryWindow,
} from "@/lib/metagraphed/subnet-history-metrics";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

/**
 * Per-subnet on-chain history (#1302). A window selector drives a daily snapshot
 * series; each metric renders as a labelled Sparkline row (mirrors
 * subnet-growth-card.tsx's GrowthRow). Optional detail — renders null when the
 * subnet has no history yet, so it never clutters a cold profile.
 *
 * The window + metric vocabulary lives in lib/metagraphed/subnet-history-metrics
 * so the compare drawer's multi-subnet overlay (#6885) offers exactly the same
 * set without either side drifting.
 */
export function SubnetHistoryChart({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<SubnetHistoryWindow>("90d");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetHistoryQuery(netuid, win));
  const points = useMemo<SubnetHistoryPoint[]>(() => res?.data?.points ?? [], [res?.data?.points]);

  const series = useMemo(
    () =>
      SUBNET_HISTORY_METRICS.map((metric) => ({
        metric,
        values: pickMetricValues(points, metric.field),
      })),
    [points],
  );

  const hasData = series.some((s) => s.values.length > 0);

  const windowSelector = (
    <div
      role="tablist"
      aria-label="History window"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {SUBNET_HISTORY_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={w === win}
          onClick={() => setWin(w)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            w === win ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">{windowSelector}</div>
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="subnet history" />
      ) : !hasData ? (
        <EmptyState
          title="No on-chain history"
          description="Daily snapshots will appear here once enough chain history has accumulated for this subnet."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          {series.map(({ metric, values }) =>
            values.length > 0 ? (
              <HistoryRow
                key={metric.key}
                label={metric.label}
                series={values}
                color={metric.color}
                format={metric.format}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  label,
  series,
  color,
  format,
}: {
  label: string;
  series: number[];
  color: string;
  format?: (v: number) => string;
}) {
  const last = series[series.length - 1]!;
  const display = format ? format(last) : Number.isFinite(last) ? formatNumber(last) : "—";
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <Sparkline values={series} color={color} width={220} height={28} formatValue={format} />
      </div>
      <span className="w-20 shrink-0 text-right font-display text-sm font-semibold tabular-nums text-ink-strong">
        {display}
      </span>
    </div>
  );
}
