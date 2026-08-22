import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetUptimeQuery,
  subnetHealthIncidentsQuery,
  flattenSurfaceIncidents,
} from "@/lib/metagraphed/queries";
import { Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { Definition, ChartTooltip, useEntityMark } from "@jsonbored/ui-kit";
import { useHydrated } from "@/hooks/use-hydrated";

interface Props {
  netuid: number;
  /** Number of weeks shown in the grid. */
  weeks?: number;
}

interface Cell {
  date: Date;
  key: string;
  score: number;
  probes: number;
  incidents: number;
  uptime?: number;
}

/**
 * GitHub-style activity heatmap, but driven by registry probe samples and
 * incident events — explicitly NOT git commit data. Labeled "Registry
 * activity" to avoid confusing developers.
 */
export function ActivityHeatmap({ netuid, weeks = 12 }: Props) {
  // Real per-surface daily uptime history (probe samples) + reconstructed
  // downtime windows. The live API exposes no windows[].points[] series, so we
  // drive the heatmap from the daily uptime rows and the incident SLA rows.
  const { data: uptimeRes, isLoading: tLoading } = useQuery(subnetUptimeQuery(netuid));
  const { data: incRes } = useQuery(subnetHealthIncidentsQuery(netuid));
  // Plain (non-suspense) queries can already be resolved by hydration time
  // even though SSR committed the loading branch — stay "loading" until
  // hydration completes so both passes render the same skeleton.
  const hydrated = useHydrated();

  const cells = useMemo<Cell[]>(() => {
    const days = weeks * 7;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const result: Cell[] = [];
    // Build day buckets from the per-surface daily uptime history: each surface
    // that reported on a given day counts as one probe sample for that day.
    const probeByDay = new Map<string, { count: number; sum: number; n: number }>();
    for (const s of uptimeRes?.data?.surfaces ?? []) {
      for (const day of s.days ?? []) {
        if (!day.day) continue;
        const cur = probeByDay.get(day.day) ?? { count: 0, sum: 0, n: 0 };
        const next = { count: cur.count + 1, sum: cur.sum, n: cur.n };
        if (typeof day.uptime_ratio === "number") {
          next.sum = cur.sum + day.uptime_ratio;
          next.n = cur.n + 1;
        }
        probeByDay.set(day.day, next);
      }
    }
    const incByDay = new Map<string, number>();
    for (const inc of flattenSurfaceIncidents(incRes?.data ?? [])) {
      if (!inc.started_at) continue;
      const d = new Date(inc.started_at);
      if (Number.isNaN(d.getTime())) continue;
      const k = d.toISOString().slice(0, 10);
      incByDay.set(k, (incByDay.get(k) ?? 0) + 1);
    }
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const bucket = probeByDay.get(key);
      const probes = bucket?.count ?? 0;
      const uptime = bucket && bucket.n > 0 ? bucket.sum / bucket.n : undefined;
      const incidents = incByDay.get(key) ?? 0;
      const score = probes + incidents * 2;
      result.push({ date: d, key, score, probes, incidents, uptime });
    }
    return result;
  }, [uptimeRes, incRes, weeks]);

  const maxScore = useMemo(() => Math.max(1, ...cells.map((c) => c.score)), [cells]);
  const activeDays = cells.filter((c) => c.score > 0).length;
  const streak = useMemo(() => {
    let s = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].score > 0) s++;
      else break;
    }
    return s;
  }, [cells]);

  // Bucket cells into columns of 7 (week columns, top = Sunday).
  const columns = useMemo(() => {
    const cols: Cell[][] = [];
    for (let w = 0; w < weeks; w++) {
      cols.push(cells.slice(w * 7, w * 7 + 7));
    }
    return cols;
  }, [cells, weeks]);

  if (!hydrated || tLoading) return <Skeleton className="h-44 w-full" />;

  return (
    <Panel as="div" flush className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-paper">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-13 text-ink-muted">Registry activity</span>
          <Definition term="Activity heatmap" />
        </div>
        <span className="text-10 text-ink-muted">
          {activeDays}/{cells.length} active · streak {streak}d
        </span>
      </div>
      <div className="p-4">
        <div
          className="relative grid gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
          role="group"
          aria-label={`Registry activity heatmap for the last ${weeks} weeks`}
          data-marks
        >
          <ChartTooltip top={0} />
          {columns.map((col, ci) => (
            <div key={ci} className="grid grid-rows-7 gap-[3px]">
              {col.map((c) => (
                <HeatCell key={c.key} cell={c} background={tone(c.score, maxScore)} />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-10 text-ink-muted">
          <span>less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <span
              key={t}
              className="size-2.5 rounded border border-border/40"
              style={{ background: tone(t * maxScore, maxScore) }}
            />
          ))}
          <span>more</span>
        </div>
      </div>
    </Panel>
  );
}

function tone(score: number, max: number): string {
  if (score <= 0) return "var(--surface)";
  const t = Math.min(1, score / max);
  // 4 discrete steps for the github-like feel.
  if (t < 0.25) return "color-mix(in oklab, var(--accent) 18%, var(--surface))";
  if (t < 0.5) return "color-mix(in oklab, var(--accent) 38%, var(--surface))";
  if (t < 0.75) return "color-mix(in oklab, var(--accent) 62%, var(--surface))";
  return "var(--accent)";
}

function HeatCell({ cell: c, background }: { cell: Cell; background: string }) {
  const rows = [
    { key: "probes", label: "probes", value: String(c.probes) },
    ...(c.incidents > 0
      ? [{ key: "incidents", label: "incidents", value: String(c.incidents) }]
      : []),
    ...(c.uptime != null
      ? [{ key: "uptime", label: "uptime", value: `${(c.uptime * 100).toFixed(2)}%` }]
      : []),
  ];
  const mark = useEntityMark(`day:${c.key}`, {
    source: "activity-heatmap",
    label: `${c.key}: ${c.probes} probes, ${c.incidents} incidents`,
    data: { title: c.key, rows },
  });
  return (
    <button
      type="button"
      {...mark}
      className="aspect-square rounded border border-border/40 data-[active=true]:ring-2 data-[active=true]:ring-accent"
      style={{ background }}
    />
  );
}
