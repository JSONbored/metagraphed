import { RangeControl, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetHealthPercentilesQuery,
  subnetHealthIncidentsQuery,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import type { SurfaceLatencyPercentiles, SurfaceSla } from "@/lib/metagraphed/types";

// #1114: per-surface reliability — uptime SLA + latency percentiles (p50/p95/p99)
// over a 7d/30d window, both computed live from the store. The window toggle is the
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

const ms = (value: unknown) => fmtMs(typeof value === "number" ? value : undefined);

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

  const columns = useMemo<Array<DataTableColumn<Row>>>(
    () => [
      {
        key: "surface",
        label: "Surface",
        sortable: true,
        value: (r) => shortSurfaceId(r.surfaceId, netuid),
      },
      {
        key: "uptime",
        label: "Uptime",
        kind: "number",
        sortable: true,
        value: (r) => r.uptime ?? null,
        format: (v) => (typeof v === "number" ? `${(v * 100).toFixed(2)}%` : "—"),
        // The tone is the reading: 99.9% and 94% are the same number to a
        // sorter and different facts to an operator.
        render: (r) => (
          <span className={classNames("tabular-nums", uptimeTone(r.uptime))}>
            {r.uptime != null ? `${(r.uptime * 100).toFixed(2)}%` : "—"}
          </span>
        ),
      },
      {
        key: "p50",
        label: "p50",
        kind: "number",
        sortable: true,
        value: (r) => r.p50 ?? null,
        format: ms,
      },
      {
        key: "p95",
        label: "p95",
        kind: "number",
        sortable: true,
        value: (r) => r.p95 ?? null,
        format: ms,
      },
      {
        key: "p99",
        label: "p99",
        kind: "number",
        sortable: true,
        value: (r) => r.p99 ?? null,
        format: ms,
      },
      {
        key: "incidents",
        label: "Incidents",
        kind: "number",
        sortable: true,
        value: (r) => r.incidentCount ?? null,
        format: (v) => (typeof v === "number" && v > 0 ? String(v) : "—"),
        // The count alone does not say how long it was down, and an operator
        // needs both to size the outage.
        render: (r) =>
          r.incidentCount ? `${r.incidentCount} · ${fmtDowntime(r.downtimeMs)}` : "—",
      },
    ],
    [netuid],
  );

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.surfaceId}
      caption="Per-surface reliability"
      link={RouterLink}
      filters={
        <RangeControl
          label="Reliability window"
          options={WINDOWS.map((w) => ({ value: w, label: String(w) }))}
          value={window}
          onChange={setWindow}
        />
      }
      loading={loading && rows.length === 0}
      error={
        isError ? (
          <ErrorState
            error={errorObj}
            onRetry={() => {
              void refetchPct();
              void refetchSla();
            }}
            context="reliability"
          />
        ) : undefined
      }
      empty={
        <EmptyState
          title="No probe history yet"
          description={`Nothing has been probed for this subnet in the ${window} window.`}
        />
      }
    />
  );
}
