import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankedRails, type RankedRailItem } from "@jsonbored/ui-kit";
import { subnetHealthIncidentsQuery, flattenSurfaceIncidents } from "@/lib/metagraphed/queries";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatRelative, humaniseSeconds } from "@/lib/metagraphed/format";
import type { FlatSurfaceIncident } from "@/lib/metagraphed/types";

/** Trim the "sn-<netuid>-" / "community-sn-<netuid>-" prefix from a surface id. */
function shortSurfaceId(id: string, netuid: number): string {
  return id.replace(new RegExp(`^(community-)?sn-${netuid}-`), "");
}

/** Incident length in seconds; an open incident runs to now. */
function incidentSeconds(inc: FlatSurfaceIncident, now: number): number {
  if (typeof inc.duration_ms === "number" && Number.isFinite(inc.duration_ms)) {
    return Math.max(0, inc.duration_ms / 1000);
  }
  const start = inc.started_at ? Date.parse(inc.started_at) : NaN;
  if (!Number.isFinite(start)) return 0;
  const end = inc.ended_at ? Date.parse(inc.ended_at) : now;
  return Math.max(0, (end - start) / 1000);
}

export function IncidentTimeline({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(subnetHealthIncidentsQuery(netuid));
  const items = useMemo<RankedRailItem[]>(() => {
    const now = Date.now();
    return flattenSurfaceIncidents(data?.data ?? [])
      .map((inc, i) => ({
        key: `incident:${inc.surface_id}:${inc.started_at ?? i}`,
        label: shortSurfaceId(inc.surface_id, netuid),
        value: incidentSeconds(inc, now),
        detail: [
          { key: "state", label: "state", value: inc.ended_at ? "resolved" : "open" },
          { key: "started", label: "started", value: formatRelative(inc.started_at) },
          { key: "resolved", label: "resolved", value: formatRelative(inc.ended_at) },
        ],
      }))
      .sort((a, b) => b.value - a.value);
  }, [data, netuid]);

  return (
    <AnalyticsSection
      id="incidents"
      name="Incident history"
      question="Recorded health regressions and SLA breaks for this subnet, longest first."
      footnote="GET /api/v1/subnets/{netuid}/health/incidents"
    >
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} context="incident history" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No incidents recorded"
          description="This subnet has a clean health history in the registry."
        />
      ) : (
        <RankedRails
          items={items}
          formatValue={(v) => humaniseSeconds(v)}
          columns={{ value: "Duration", name: "Surface", track: "longest first" }}
          limit={10}
          ariaLabel="Incidents ranked by duration"
          source="incident-timeline"
        />
      )}
    </AnalyticsSection>
  );
}
