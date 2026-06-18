import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetTrajectoryQuery, subnetUptimeQuery } from "@/lib/metagraphed/queries";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { classNames } from "@/lib/metagraphed/format";
import type { TrajectoryPoint } from "@/lib/metagraphed/types";

// #1115: subnet evolution — structural growth (trajectory) + long-range daily
// uptime, both live from D1. Non-blocking useQuery; each section self-states.

function gradeTone(grade?: string): string {
  const g = (grade ?? "").toUpperCase();
  if (g === "A") return "text-health-ok";
  if (g === "B" || g === "C") return "text-health-warn";
  if (g === "D" || g === "F") return "text-health-down";
  return "text-ink-muted";
}

function deltaLabel(d?: number): { text: string; tone: string } | null {
  if (d == null) return null;
  if (d === 0) return { text: "±0", tone: "text-ink-muted" };
  return d > 0
    ? { text: `+${d}`, tone: "text-health-ok" }
    : { text: `${d}`, tone: "text-health-down" };
}

function shortSurfaceId(id: string, netuid: number): string {
  return id.replace(new RegExp(`^(community-)?sn-${netuid}-`), "");
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

// ---------------------------- growth ----------------------------
export function GrowthSection({ netuid }: { netuid: number }) {
  const { data: res, isPending } = useQuery(subnetTrajectoryQuery(netuid));
  const points = res?.data.points ?? [];
  const delta7d = res?.data.deltas?.["7d"] ?? null;

  if (isPending && points.length === 0) return <Empty>Loading growth…</Empty>;
  if (points.length < 2) {
    return (
      <Empty>
        Not enough history yet — structural trajectory needs at least two weekly snapshots.
      </Empty>
    );
  }

  const metrics: Array<{
    label: string;
    get: (p: TrajectoryPoint) => number | undefined;
    delta?: number;
  }> = [
    { label: "Completeness", get: (p) => p.completeness_score, delta: delta7d?.completeness_score },
    { label: "Surfaces", get: (p) => p.surface_count, delta: delta7d?.surface_count },
    { label: "Endpoints", get: (p) => p.endpoint_count, delta: delta7d?.endpoint_count },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {metrics.map((m) => {
        const values = points.map((p) => m.get(p) ?? 0);
        const current = values[values.length - 1] ?? 0;
        const d = deltaLabel(m.delta);
        return (
          <div key={m.label} className="rounded-lg border border-border bg-card p-4">
            <div className="mg-label">{m.label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-display text-2xl font-semibold tabular-nums text-ink-strong">
                {current}
              </span>
              {d ? (
                <span className={classNames("font-mono text-xs", d.tone)}>{d.text} · 7d</span>
              ) : null}
            </div>
            <div className="mt-2">
              <Sparkline
                values={values}
                width={180}
                height={32}
                interactive={false}
                ariaLabel={`${m.label} over time`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------- uptime history -------------------------
const UPTIME_WINDOWS = ["90d", "1y"] as const;
type UptimeWindow = (typeof UPTIME_WINDOWS)[number];

export function UptimeHistorySection({ netuid }: { netuid: number }) {
  const [window, setWindow] = useState<UptimeWindow>("90d");
  const { data: res, isPending } = useQuery(subnetUptimeQuery(netuid, window));
  const overall = res?.data.reliability;
  const surfaces = res?.data.surfaces ?? [];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          {overall?.grade ? (
            <span
              className={classNames("font-display text-2xl font-bold", gradeTone(overall.grade))}
            >
              {overall.grade}
            </span>
          ) : null}
          <div className="font-mono text-[11px] text-ink-muted">
            {overall?.uptime_ratio != null
              ? `${(overall.uptime_ratio * 100).toFixed(2)}% uptime`
              : "—"}
            {overall?.surface_count != null ? ` · ${overall.surface_count} surfaces` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {UPTIME_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={classNames(
                "rounded px-2 py-0.5 font-mono text-[11px] transition-colors",
                w === window ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      {isPending && surfaces.length === 0 ? (
        <div className="p-4 text-xs text-ink-muted">Loading uptime…</div>
      ) : surfaces.length === 0 ? (
        <div className="p-4 text-xs text-ink-muted">
          No daily uptime history in the {window} window yet.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {surfaces.map((s) => (
            <li key={s.surface_id} className="flex items-center justify-between gap-4 px-4 py-2">
              <div className="min-w-0 flex-1">
                <div
                  className="truncate font-mono text-[11px] text-ink-strong"
                  title={s.surface_id}
                >
                  {shortSurfaceId(s.surface_id, netuid)}
                </div>
                <div className="font-mono text-[10px] text-ink-muted">
                  {s.uptime_ratio != null ? `${(s.uptime_ratio * 100).toFixed(1)}%` : "—"}
                  {s.day_count != null ? ` · ${s.day_count}d` : ""}
                </div>
              </div>
              <Sparkline
                values={s.days.map((d) => (d.uptime_ratio ?? 0) * 100)}
                width={120}
                height={24}
                interactive={false}
                ariaLabel="daily uptime"
              />
              {s.reliability?.grade ? (
                <span
                  className={classNames(
                    "w-5 text-center font-display text-sm font-bold",
                    gradeTone(s.reliability.grade),
                  )}
                >
                  {s.reliability.grade}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
