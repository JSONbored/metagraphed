import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  endpointsQuery,
  endpointIncidentsQuery,
  rpcPoolsQuery,
} from "@/lib/metagraphed/queries";
import { formatRelative } from "@/lib/metagraphed/format";
import type { Endpoint, EndpointIncident, RpcPool } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/endpoints")({
  head: () => ({
    meta: [
      { title: "Endpoints — Metagraphed" },
      { name: "description", content: "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility." },
    ],
  }),
  component: EndpointsPage,
});

function EndpointsPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Infrastructure"
        title="Endpoints"
        description="Subtensor RPC/WSS pools and application-layer endpoints. Pool eligibility is metadata only — proxy routing is future-scoped."
      />
      <div className="space-y-8">
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">RPC pools</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <PoolsTable />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">All endpoints</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <EndpointsTable />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Recent incidents</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <IncidentsTable />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
    </AppShell>
  );
}

function PoolsTable() {
  const { data } = useSuspenseQuery(rpcPoolsQuery());
  const rows = (data.data ?? []) as RpcPool[];
  if (rows.length === 0) return <EmptyState title="No pools" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Pool</th>
            <th className="px-3 py-2 text-left">Region</th>
            <th className="px-3 py-2 text-right">Members</th>
            <th className="px-3 py-2">Archive</th>
            <th className="px-3 py-2">Proxy</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2 font-medium text-ink-strong">{p.name ?? p.id}</td>
              <td className="px-3 py-2 text-[12px]">{p.region ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono">{p.members_count ?? "—"}</td>
              <td className="px-3 py-2 text-[11px] text-ink-muted">{p.archive_capable ? "yes" : "—"}</td>
              <td className="px-3 py-2 text-[11px] text-ink-muted">{p.proxy_enabled ? "enabled" : "future"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointsTable() {
  const { data } = useSuspenseQuery(endpointsQuery());
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) return <EmptyState title="No endpoints" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Netuid</th>
            <th className="px-3 py-2 text-left">Kind</th>
            <th className="px-3 py-2 text-left">URL</th>
            <th className="px-3 py-2 text-left">Provider</th>
            <th className="px-3 py-2 text-left">Region</th>
            <th className="px-3 py-2">Health</th>
            <th className="px-3 py-2 text-right">Latency</th>
            <th className="px-3 py-2 text-right">Probed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((e) => (
            <tr key={e.id} className="hover:bg-surface/40">
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                {e.netuid != null ? (
                  <Link to="/subnets/$netuid" params={{ netuid: String(e.netuid) }} className="hover:text-ink-strong">{String(e.netuid).padStart(3, "0")}</Link>
                ) : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[32ch]">{e.url ?? "—"}</td>
              <td className="px-3 py-2 text-[12px]">{e.provider ?? e.provider_slug ?? "—"}</td>
              <td className="px-3 py-2 text-[12px]">{e.region ?? "—"}</td>
              <td className="px-3 py-2"><HealthPill state={e.health} /></td>
              <td className="px-3 py-2 text-right font-mono text-[11px]">{e.latency_ms != null ? `${e.latency_ms}ms` : "—"}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{formatRelative(e.last_probed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function durationLabel(start?: string | null, end?: string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function IncidentsTable() {
  const { data } = useSuspenseQuery(endpointIncidentsQuery());
  const rows = (data.data ?? []) as EndpointIncident[];
  if (rows.length === 0) return <EmptyState title="No incidents in window" />;
  return (
    <ul className="grid gap-2 md:grid-cols-2">
      {rows.map((i) => {
        const ongoing = !i.ended_at;
        return (
          <li key={i.id} className="rounded border border-border bg-card p-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <HealthPill state={i.state} />
                <span className="font-mono text-[11px] text-ink-strong truncate">{i.endpoint_id ?? "—"}</span>
              </div>
              <span className={`font-mono text-[10px] uppercase tracking-widest ${ongoing ? "text-health-down" : "text-ink-muted"}`}>
                {ongoing ? "ongoing" : "resolved"} · {durationLabel(i.started_at, i.ended_at)}
              </span>
            </div>
            {i.message ? <p className="text-[12px] text-ink-muted line-clamp-2">{i.message}</p> : null}
            <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
              <span>started {formatRelative(i.started_at)}</span>
              <span>{i.ended_at ? `ended ${formatRelative(i.ended_at)}` : "—"}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
