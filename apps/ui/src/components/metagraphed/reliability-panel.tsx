import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetHealthPercentilesQuery,
  subnetHealthIncidentsQuery,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { ErrorState } from "@/components/metagraphed/states";
import type { SurfaceLatencyPercentiles, SurfaceSla } from "@/lib/metagraphed/types";

// #1114: per-surface reliability — uptime SLA + latency percentiles (p50/p95/p99)
// over a 7d/30d window, both computed live from D1. The window toggle is the
// "trends" dimension (7d vs 30d). Non-blocking useQuery; renders its own states.
const WINDOWS = ["7d", "30d"] as const;
type WindowKey = (typeof WINDOWS)[number];

interface Row {
  surfaceId: string;
  uptime?: number;
  incidentCount?: number;
  downtimeMs?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

function shortSurfaceId(id: string, netuid: number): string {
  return id.replace(new RegExp(`^(community-)?sn-${netuid}-`), "");
}

function fmtMs(v?: number): string {
  return typeof v === "number" ? `${Math.round(v)}ms` : "—";
}

function fmtDowntime(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function uptimeTone(u?: number): string {
  if (u == null) return "text-ink-muted";
  if (u >= 0.99) return "text-health-ok";
  if (u >= 0.95) return "text-health-warn";
  return "text-health-down";
}

export function ReliabilityPanel({ netuid }: { netuid: number }) {
  const [window, setWindow] = useState<WindowKey>("7d");
  const {
    data: pctRes,
    isPending: pctPending,
    isError: pctError,
    error: pctErrorObj,
    refetch: refetchPct,
  } = useQuery(subnetHealthPercentilesQuery(netuid, window));
  const {
    data: slaRes,
    isPending: slaPending,
    isError: slaIsError,
    error: slaErrorObj,
    refetch: refetchSla,
  } = useQuery(subnetHealthIncidentsQuery(netuid, window));

  const percentiles: SurfaceLatencyPercentiles[] = pctRes?.data ?? [];
  const slas: SurfaceSla[] = slaRes?.data ?? [];

  const byId = new Map<string, Row>();
  for (const s of slas) {
    byId.set(s.surface_id, {
      surfaceId: s.surface_id,
      uptime: s.uptime_ratio,
      incidentCount: s.incident_count,
      downtimeMs: s.downtime_ms,
    });
  }
  for (const p of percentiles) {
    const row = byId.get(p.surface_id) ?? { surfaceId: p.surface_id };
    row.p50 = p.latency_ms?.p50;
    row.p95 = p.latency_ms?.p95;
    row.p99 = p.latency_ms?.p99;
    byId.set(p.surface_id, row);
  }
  const rows = [...byId.values()].sort((a, b) => (a.uptime ?? 1) - (b.uptime ?? 1));
  const loading = pctPending || slaPending;
  const isError = pctError || slaIsError;
  const errorObj = pctErrorObj ?? slaErrorObj;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Per-surface reliability · uptime · latency percentiles
        </div>
        <div role="tablist" aria-label="Reliability window" className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={w === window}
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
      {loading && rows.length === 0 ? (
        <div className="p-4 text-xs text-ink-muted">Loading reliability…</div>
      ) : isError ? (
        <div className="p-4">
          <ErrorState
            error={errorObj}
            onRetry={() => {
              void refetchPct();
              void refetchSla();
            }}
            context="reliability"
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-xs text-ink-muted">
          No probe history for this subnet in the {window} window yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-ink-muted">
                <th className="border-b border-border px-3 py-2 text-left">Surface</th>
                <th className="border-b border-border px-2 py-2 text-right">Uptime</th>
                <th className="border-b border-border px-2 py-2 text-right">p50</th>
                <th className="border-b border-border px-2 py-2 text-right">p95</th>
                <th className="border-b border-border px-2 py-2 text-right">p99</th>
                <th className="border-b border-border px-3 py-2 text-right">Incidents</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.surfaceId} className="border-b border-border last:border-b-0">
                  <td
                    className="max-w-[260px] truncate px-3 py-1.5 text-ink-strong"
                    title={r.surfaceId}
                  >
                    {shortSurfaceId(r.surfaceId, netuid)}
                  </td>
                  <td
                    className={classNames(
                      "px-2 py-1.5 text-right tabular-nums",
                      uptimeTone(r.uptime),
                    )}
                  >
                    {r.uptime != null ? `${(r.uptime * 100).toFixed(2)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-muted">
                    {fmtMs(r.p50)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-muted">
                    {fmtMs(r.p95)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-muted">
                    {fmtMs(r.p99)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">
                    {r.incidentCount ? `${r.incidentCount} · ${fmtDowntime(r.downtimeMs)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
