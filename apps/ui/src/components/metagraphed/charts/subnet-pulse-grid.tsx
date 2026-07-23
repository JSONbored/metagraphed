import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { subnetsQuery, subnetHealthMapQuery } from "@/lib/metagraphed/queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

const HEALTH_TONE: Record<string, string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  down: "bg-health-down",
  unknown: "bg-ink-subtle/60",
};

/**
 * Compact heat-grid of active Finney subnets, tinted by health.
 * Hover for tooltip, click to navigate to the subnet profile.
 */
export function SubnetPulseGrid({ columns = 16 }: { columns?: number }) {
  const { data, isPending, isError } = useQuery({
    ...subnetsQuery(),
    retry: 0,
    placeholderData: (p) => p,
  });
  // subnetsQuery health is always "unknown" (list endpoint only carries chain
  // status). Join with the probe-health map from /api/v1/health for real colors.
  const healthMap = useQuery({ ...subnetHealthMapQuery(), retry: 0 }).data?.data ?? {};

  if (isPending) {
    return (
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        aria-busy="true"
      >
        {Array.from({ length: columns * 8 }).map((_, i) => (
          <div key={i} className="mg-pulse-cell bg-surface" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <div className="text-[11px] text-health-down">Couldn't load subnet pulse.</div>;
  }

  const subs = data?.data ?? [];

  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      role="list"
      aria-label={`${subs.length} active subnets, tinted by health`}
    >
      {subs.map((s, i) => {
        const health = (healthMap[s.netuid]?.health ?? s.health ?? "unknown") as string;
        const tone = HEALTH_TONE[health] ?? HEALTH_TONE.unknown;
        return (
          <Tooltip key={s.netuid} delayDuration={120}>
            <TooltipTrigger asChild>
              <Link
                to="/subnets/$netuid"
                params={{ netuid: s.netuid }}
                className={classNames("mg-pulse-cell", tone)}
                style={{ animationDelay: `${Math.min(i * 8, 600)}ms` }}
                aria-label={`Subnet ${s.netuid}${s.name ? ` · ${s.name}` : ""} · ${health}`}
                role="listitem"
              />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <div className="mg-type-micro text-ink-muted">netuid {s.netuid}</div>
              <div className="font-display text-sm font-semibold text-ink-strong">
                {s.name ?? `Subnet ${s.netuid}`}
              </div>
              <div className="mt-0.5 text-[11px] text-ink-muted">health · {health}</div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
