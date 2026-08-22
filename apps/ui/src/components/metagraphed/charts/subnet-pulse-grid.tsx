import { ChartTooltip, useEntityMark } from "@jsonbored/ui-kit";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { subnetsQuery, subnetHealthMapQuery } from "@/lib/metagraphed/queries";
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
    return <div className="text-13 text-health-down">Couldn't load subnet pulse.</div>;
  }

  const subs = data?.data ?? [];

  return (
    <div
      className="relative grid gap-1"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      role="list"
      aria-label={`${subs.length} active subnets, tinted by health`}
      data-marks
    >
      <ChartTooltip top={0} />
      {subs.map((s, i) => {
        const health = (healthMap[s.netuid]?.health ?? s.health ?? "unknown") as string;
        return <PulseCell key={s.netuid} subnet={s} health={health} index={i} />;
      })}
    </div>
  );
}

function PulseCell({
  subnet: s,
  health,
  index,
}: {
  subnet: { netuid: number; name?: string | null };
  health: string;
  index: number;
}) {
  const tone = HEALTH_TONE[health] ?? HEALTH_TONE.unknown;
  const mark = useEntityMark(`subnet:${s.netuid}`, {
    source: "subnet-pulse",
    label: `Subnet ${s.netuid}${s.name ? ` · ${s.name}` : ""} · ${health}`,
    data: {
      title: s.name ?? `Subnet ${s.netuid}`,
      total: `SN${s.netuid}`,
      rows: [{ key: "health", label: "health", value: health }],
    },
  });
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: s.netuid }}
      {...mark}
      role="listitem"
      className={classNames(
        "mg-pulse-cell data-[active=true]:ring-2 data-[active=true]:ring-accent",
        tone,
      )}
      style={{ animationDelay: `${Math.min(index * 8, 600)}ms` }}
    />
  );
}
