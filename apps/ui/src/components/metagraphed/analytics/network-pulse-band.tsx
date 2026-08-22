import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { StackedColumns, formatLineDate, type StackedColumn } from "@jsonbored/ui-kit";
import { healthQuery, bulkHealthTrendsQuery, bulkTrendDays } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { dayToMs } from "@/components/metagraphed/metric-history";
import {
  useTimeRange,
  RANGE_HOURS,
  RANGE_BUCKETS,
  RANGE_LABEL,
  type TimeRange,
} from "./time-range-context";

// The bulk /api/v1/health/trends artifact is per-DAY, so map a TimeRange onto the
// matching trend window. 1h/24h carry less than a day of real per-day points, so
// they fall back to the live current snapshot (still real, just not a trend).
const RANGE_TO_TREND_WINDOW: Record<TimeRange, string | null> = {
  "1h": null,
  "24h": null,
  "7d": "7d",
  "30d": "30d",
};

const SERIES = ["ok", "down"] as const;
const formatShare = (v: number) => `${Math.round(v * 10) / 10}%`;

/** One column of ok / down shares that always sums to 100. */
function shareColumn(key: string, label: string, okShare: number): StackedColumn {
  const ok = Math.round(Math.min(1, Math.max(0, okShare)) * 1000) / 10;
  const down = Math.round((100 - ok) * 10) / 10;
  return {
    key,
    label,
    axisLabel: label,
    total: 100,
    segments: [
      { key: "ok", label: "ok", value: ok },
      { key: "down", label: "down", value: down },
    ],
  };
}

/**
 * ok / down share per bucket across the active TimeRange. For 7d/30d each
 * column is a REAL sample-weighted day from the bulk /api/v1/health/trends
 * artifact (down = 1 − uptime); for 1h/24h, which have no sub-day series,
 * every bucket repeats the live current snapshot and the caption says so.
 */
export function NetworkPulseBand({ className }: { className?: string }) {
  const { range } = useTimeRange();
  const { data: hRes } = useSuspenseQuery(healthQuery());
  const { data: tRes } = useSuspenseQuery(bulkHealthTrendsQuery());
  const h = hRes.data;

  const total = (h?.total ?? 0) || 1;
  const okShare = (h?.ok ?? 0) / total;
  const bucketCount = RANGE_BUCKETS[range];

  const trendDays = useMemo(() => {
    const windowKey = RANGE_TO_TREND_WINDOW[range];
    if (!windowKey) return [];
    return bulkTrendDays(tRes.data.windows[windowKey]);
  }, [tRes.data, range]);
  const usingTrend = trendDays.length > 1;

  const columns = useMemo<StackedColumn[]>(() => {
    if (usingTrend) {
      // The trailing `bucketCount` days, so the chart ends "now".
      return trendDays
        .slice(-bucketCount)
        .map((d) => shareColumn(d.date, formatLineDate(dayToMs(d.date)), d.uptime_ratio));
    }
    const minutesPerBucket = (RANGE_HOURS[range] * 60) / bucketCount;
    return Array.from({ length: bucketCount }, (_, i) => {
      const minutesAgo = Math.round((bucketCount - 1 - i) * minutesPerBucket);
      const label =
        minutesAgo === 0
          ? "now"
          : minutesAgo >= 60
            ? `−${Math.round(minutesAgo / 60)}h`
            : `−${minutesAgo}m`;
      return shareColumn(`bucket-${i}`, label, okShare);
    });
  }, [usingTrend, trendDays, bucketCount, range, okShare]);

  return (
    <Panel
      title={`Network pulse · ${RANGE_LABEL[range]}`}
      caption={
        usingTrend
          ? "Share of probes answering ok per day, from the daily health trend."
          : "No sub-day series exists, so every bucket repeats the live ok / down snapshot."
      }
      className={className}
    >
      <StackedColumns
        columns={columns}
        seriesOrder={SERIES}
        formatValue={formatShare}
        ariaLabel={`ok and down share over ${RANGE_LABEL[range]}`}
        columnSource="network-pulse"
      />
    </Panel>
  );
}
