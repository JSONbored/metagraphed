import { HealthPill, TimeAgo } from "@jsonbored/ui-kit";
import { durationLabel } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";

/**
 * Single endpoint-incident row. Used by both the `/endpoints` and `/health`
 * incident lists so the visual stays consistent.
 */
export function IncidentCard({ incident }: { incident: EndpointIncident }) {
  const i = incident;
  const ongoing = !i.ended_at;
  return (
    <li className="rounded border border-border bg-card p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <HealthPill state={i.state} />
          <span className="font-mono text-[11px] text-ink-strong truncate">
            {i.endpoint_id ?? "—"}
          </span>
        </div>
        <span className={`mg-type-micro ${ongoing ? "text-health-down" : "text-ink-muted"}`}>
          {ongoing ? "ongoing" : "resolved"} · {durationLabel(i.started_at, i.ended_at)}
        </span>
      </div>
      {i.message ? <p className="text-[12px] text-ink-muted line-clamp-2">{i.message}</p> : null}
      <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
        <span>
          started <TimeAgo at={i.started_at} />
        </span>
        <span>
          {i.ended_at ? (
            <>
              ended <TimeAgo at={i.ended_at} />
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
    </li>
  );
}
