import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MarkerRail, type MarkerRailItem } from "@jsonbored/ui-kit";
import { subnetHealthTrendsQuery, sortedHealthTrendSurfaces } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { formatFreshness } from "@/lib/metagraphed/freshness";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { useTimeRange, RANGE_LABEL } from "./time-range-context";
import type { HealthTrendSurface } from "@/lib/metagraphed/types";

const formatPct = (v: number) => `${v.toFixed(2)}%`;

function uptimePct(ratio: number | undefined): number | null {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, ratio * 100));
}

/** Trim a fully-qualified surface_id down to something readable in a tight row. */
function shortSurfaceId(id: string): string {
  return id.replace(/^community-sn-\d+-/, "").replace(/^allways-/, "");
}

/**
 * Subnet uptime by surface, one marker per surface on a 0–100% rail.
 *
 * The health-trends API returns each window as an *aggregate* snapshot with a
 * per-surface breakdown (`windows[range].surfaces[]`), NOT a `points[]`
 * time-series, so this is one row per surface for the selected window
 * (largest downtime first). The active TimeRange selects the window: 7d and
 * 30d map to upstream windows directly; 1h/24h have no finer-grained source
 * upstream and fall back to the 7d window.
 */
export function UptimeTimeline({ netuid, className }: { netuid: number; className?: string }) {
  const { range } = useTimeRange();
  const winKey: "7d" | "30d" = range === "30d" ? "30d" : "7d";
  const usingFallbackWindow = range === "1h" || range === "24h";

  const {
    data: tRes,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetHealthTrendsQuery(netuid));

  const window = tRes?.data?.windows?.[winKey];
  const trendsAt = tRes?.meta?.generated_at;
  const freshLine = formatFreshness(trendsAt, RANGE_LABEL[range]);

  const surfaces = useMemo<HealthTrendSurface[]>(() => sortedHealthTrendSurfaces(window), [window]);
  const items = useMemo<MarkerRailItem[]>(
    () =>
      surfaces.map((s) => ({
        key: s.surface_id,
        label: shortSurfaceId(s.surface_id),
        value: uptimePct(s.uptime_ratio),
      })),
    [surfaces],
  );

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (isError) {
    return (
      <Panel>
        <ErrorState error={error} onRetry={() => refetch()} context="uptime timeline" />
      </Panel>
    );
  }

  if (surfaces.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No trend data"
          description="Per-surface uptime will appear here once the prober has collected enough samples for this subnet."
          lastChecked={trendsAt}
        />
      </Panel>
    );
  }

  const overall = uptimePct(window?.uptime_ratio);
  const caption = [
    `${RANGE_LABEL[range]}${usingFallbackWindow ? " (7d window)" : ""}`,
    overall === null ? null : `${formatPct(overall)} overall`,
    typeof window?.samples === "number" ? `${formatNumber(window.samples)} samples` : null,
    freshLine,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Panel title="Uptime by surface" caption={caption} className={className}>
      <MarkerRail
        items={items}
        max={100}
        formatValue={formatPct}
        columns={{ ratio: "Uptime", name: "Surface", scale: "0–100%" }}
        ariaLabel={`Uptime by surface over ${RANGE_LABEL[range]}`}
        source="uptime-timeline"
      />
    </Panel>
  );
}
