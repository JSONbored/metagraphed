import { useQuery } from "@tanstack/react-query";
import { subnetTrajectoryQuery, subnetUptimeQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";

function pctStr(v?: number) {
  if (v == null) return "—";
  const pct = v <= 1 ? v * 100 : v;
  return `${pct.toFixed(2)}%`;
}

export function SubnetGrowthCard({ netuid }: { netuid: number }) {
  const { data: trajRes, isLoading } = useQuery(subnetTrajectoryQuery(netuid));
  const { data: upRes } = useQuery(subnetUptimeQuery(netuid));
  const points = trajRes?.data?.points ?? [];
  const surfaceSeries = points
    .map((p) => p.surface_count)
    .filter((v): v is number => typeof v === "number");
  const endpointSeries = points
    .map((p) => p.endpoint_count)
    .filter((v): v is number => typeof v === "number");
  const completenessSeries = points
    .map((p) =>
      typeof p.completeness_score === "number"
        ? p.completeness_score <= 1
          ? p.completeness_score * 100
          : p.completeness_score
        : null,
    )
    .filter((v): v is number => v != null);

  const up = upRes?.data;
  // The /uptime artifact carries a single window (default 90d): an overall
  // reliability grade plus per-surface uptime. There is no 30d/90d/180d split,
  // so surface the real window-level reliability uptime ratio instead.
  const overallUptime = up?.reliability?.uptime_ratio;
  const surfaceUptimes = (up?.surfaces ?? [])
    .map((s) => s.uptime_ratio)
    .filter((v): v is number => typeof v === "number");
  const hasGrowth = surfaceSeries.length + endpointSeries.length + completenessSeries.length > 0;
  const hasUptime = overallUptime != null || surfaceUptimes.length > 0;

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (!hasGrowth && !hasUptime) return null;

  return (
    <SectionAnchor
      id="growth"
      title="Structural growth & long-range uptime"
      subtitle="How surfaces, endpoints and completeness have evolved over time."
      info="GET /api/v1/subnets/{netuid}/trajectory · /uptime"
    >
      <div className="grid gap-3 md:grid-cols-2">
        {hasGrowth ? (
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Trajectory
            </div>
            {surfaceSeries.length > 0 ? (
              <GrowthRow label="Surfaces" series={surfaceSeries} color="var(--accent, #7aa2ff)" />
            ) : null}
            {endpointSeries.length > 0 ? (
              <GrowthRow
                label="Endpoints"
                series={endpointSeries}
                color="var(--health-ok, #4ade80)"
              />
            ) : null}
            {completenessSeries.length > 0 ? (
              <GrowthRow
                label="Completeness"
                series={completenessSeries}
                color="var(--health-warn, #fbbf24)"
                suffix="%"
              />
            ) : null}
          </div>
        ) : null}

        {hasUptime ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Long-range uptime
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <UptimeCell label={up?.window ?? "window"} value={pctStr(overallUptime)} />
              <UptimeCell label="grade" value={up?.reliability?.grade ?? "—"} />
              <UptimeCell
                label="surfaces"
                value={
                  up?.reliability?.surface_count != null
                    ? String(up.reliability.surface_count)
                    : surfaceUptimes.length
                      ? String(surfaceUptimes.length)
                      : "—"
                }
              />
            </div>
            {up?.reliability?.sample_count != null ? (
              <div className="mt-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                {up.reliability.sample_count} samples
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="No long-range uptime"
            description="Uptime windows will appear once enough samples accumulate."
          />
        )}
      </div>
    </SectionAnchor>
  );
}

function GrowthRow({
  label,
  series,
  color,
  suffix,
}: {
  label: string;
  series: number[];
  color: string;
  suffix?: string;
}) {
  const last = series[series.length - 1]!;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <Sparkline values={series} color={color} width={220} height={28} />
      </div>
      <span className="w-16 shrink-0 text-right font-display text-sm font-semibold tabular-nums text-ink-strong">
        {Number.isFinite(last) ? `${suffix === "%" ? last.toFixed(0) : last}${suffix ?? ""}` : "—"}
      </span>
    </div>
  );
}

function UptimeCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-lg font-semibold tabular-nums text-ink-strong">
        {value}
      </div>
    </div>
  );
}
