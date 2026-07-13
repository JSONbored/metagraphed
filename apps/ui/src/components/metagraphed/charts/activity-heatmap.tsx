import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetUptimeQuery,
  subnetHealthIncidentsQuery,
  flattenSurfaceIncidents,
} from "@/lib/metagraphed/queries";
import { Skeleton } from "@/components/metagraphed/states";
import { Tooltip, TooltipContent, TooltipTrigger, InfoTooltip } from "@jsonbored/ui-kit";

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

  if (tLoading) return <Skeleton className="h-44 w-full" />;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-paper/30">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Registry activity
          </span>
          <InfoTooltip label="Daily probe samples and recorded incidents — not GitHub commits. Drives the registry's freshness signal." />
        </div>
        <span className="font-mono text-[10px] text-ink-muted">
          {activeDays}/{cells.length} active · streak {streak}d
        </span>
      </div>
      <div className="p-4">
        <div
          className="grid gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`Registry activity heatmap for the last ${weeks} weeks`}
        >
          {columns.map((col, ci) => (
            <div key={ci} className="grid grid-rows-7 gap-[3px]">
              {col.map((c) => (
                <Tooltip key={c.key} delayDuration={120}>
                  <TooltipTrigger asChild>
                    <div
                      className="aspect-square rounded-[2px] border border-border/40"
                      style={{ background: tone(c.score, maxScore) }}
                      aria-label={`${c.key}: ${c.probes} probes, ${c.incidents} incidents`}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="font-mono text-[10px]">
                    <div className="text-[11px] text-ink-strong">{c.key}</div>
                    <div>
                      {c.probes} probe{c.probes === 1 ? "" : "s"}
                    </div>
                    {c.incidents > 0 ? (
                      <div className="text-health-down">
                        {c.incidents} incident{c.incidents === 1 ? "" : "s"}
                      </div>
                    ) : null}
                    {c.uptime != null ? <div>uptime {(c.uptime * 100).toFixed(2)}%</div> : null}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 font-mono text-[9.5px] text-ink-muted">
          <span>less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <span
              key={t}
              className="size-2.5 rounded-[2px] border border-border/40"
              style={{ background: tone(t * maxScore, maxScore) }}
            />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
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
