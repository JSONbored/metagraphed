import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { subnetHealthIncidentsQuery, flattenSurfaceIncidents } from "@/lib/metagraphed/queries";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { TimeAgo, SectionAnchor } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import { incidentDurationLabel } from "@/lib/metagraphed/incident-duration";

function severityIcon(sev?: string) {
  if (sev === "high") return <AlertOctagon className="size-3.5 text-health-down" />;
  if (sev === "medium") return <AlertTriangle className="size-3.5 text-health-warn" />;
  return <Info className="size-3.5 text-ink-muted" />;
}

/** Trim the "sn-<netuid>-" / "community-sn-<netuid>-" prefix from a surface id. */
function shortSurfaceId(id: string, netuid: number): string {
  return id.replace(new RegExp(`^(community-)?sn-${netuid}-`), "");
}

export function IncidentTimeline({ netuid }: { netuid: number }) {
  const { data, isLoading } = useQuery(subnetHealthIncidentsQuery(netuid));
  const incidents = flattenSurfaceIncidents(data?.data ?? []);

  return (
    <SectionAnchor
      id="incidents"
      title="Incident history"
      subtitle="Recorded health regressions and SLA breaks for this subnet."
      info="GET /api/v1/subnets/{netuid}/health/incidents"
    >
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : incidents.length === 0 ? (
        <EmptyState
          title="No incidents recorded"
          description="This subnet has a clean health history in the registry."
        />
      ) : (
        <ol className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          {incidents.slice(0, 12).map((inc, i) => {
            const open = !inc.ended_at;
            const duration = incidentDurationLabel(inc.started_at, inc.ended_at);
            return (
              <li
                key={`${inc.surface_id}-${inc.started_at ?? i}`}
                className="px-4 py-2.5 flex items-center gap-3 text-sm"
              >
                {severityIcon(inc.severity)}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-ink-strong" title={inc.surface_id}>
                    {shortSurfaceId(inc.surface_id, netuid)}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                    {inc.started_at ? (
                      <span>
                        started <TimeAgo at={inc.started_at} />
                      </span>
                    ) : null}
                    {duration ? <span>· {duration}</span> : null}
                    {inc.failed_samples != null ? <span>· {inc.failed_samples} failed</span> : null}
                  </div>
                </div>
                <span
                  className={classNames(
                    "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                    open
                      ? "border-health-down/40 bg-health-down/10 text-health-down"
                      : "border-border bg-surface/40 text-ink-muted",
                  )}
                >
                  {open ? "open" : "resolved"}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SectionAnchor>
  );
}
