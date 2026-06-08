import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  healthQuery,
  freshnessQuery,
  sourceHealthQuery,
  endpointIncidentsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatRelative, isStaleFreshness } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/health")({
  head: () => ({
    meta: [
      { title: "Health — Metagraphed" },
      { name: "description", content: "Global health, freshness, source health, and recent incidents across the registry." },
    ],
  }),
  component: HealthPage,
});

function HealthPage() {
  return (
    <AppShell>
      <PageHeading eyebrow="Operations" title="Health & freshness" description="Probe-derived health. User submissions cannot set uptime, latency, or incident state." />
      <div className="space-y-8">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <GlobalHealth />
          </Suspense>
        </QueryErrorBoundary>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Source health</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <SourceHealth />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Incidents</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <Incidents />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
    </AppShell>
  );
}

function GlobalHealth() {
  const { data: hRes } = useSuspenseQuery(healthQuery());
  const { data: fRes } = useSuspenseQuery(freshnessQuery());
  const h = hRes.data;
  const f = fRes.data;
  const stale = isStaleFreshness(hRes.meta?.generated_at);
  return (
    <div className="space-y-3">
      {stale ? <StaleBanner generatedAt={hRes.meta?.generated_at} /> : null}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border border border-border rounded overflow-hidden">
        <Cell label="OK" value={formatNumber(h?.ok)} accent="text-health-ok" />
        <Cell label="Warn" value={formatNumber(h?.warn)} accent="text-health-warn" />
        <Cell label="Down" value={formatNumber(h?.down)} accent="text-health-down" />
        <Cell label="Unknown" value={formatNumber(h?.unknown)} accent="text-ink-muted" />
        <Cell label="Uptime 24h" value={h?.uptime_24h != null ? `${(h.uptime_24h * 100).toFixed(2)}%` : "—"} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-border border border-border rounded overflow-hidden">
        <Cell label="Avg age" value={f?.avg_age_seconds != null ? `${Math.round(f.avg_age_seconds)}s` : "—"} />
        <Cell label="Max age" value={f?.max_age_seconds != null ? `${Math.round(f.max_age_seconds)}s` : "—"} />
        <Cell label="Stale sources" value={formatNumber(f?.stale_count)} />
      </div>
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className={`font-display text-xl font-semibold tabular-nums ${accent ?? "text-ink-strong"}`}>{value}</div>
    </div>
  );
}

function SourceHealth() {
  const { data } = useSuspenseQuery(sourceHealthQuery());
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="No source health" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((s) => (
            <tr key={s.name}>
              <td className="px-3 py-2 font-medium">{s.name}</td>
              <td className="px-3 py-2"><HealthPill state={s.ok === false ? "down" : s.ok ? "ok" : "unknown"} /></td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{formatRelative(s.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Incidents() {
  const { data } = useSuspenseQuery(endpointIncidentsQuery());
  const rows = (data.data ?? []) as EndpointIncident[];
  if (rows.length === 0) return <EmptyState title="No recent incidents" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Endpoint</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2 text-left">Message</th>
            <th className="px-3 py-2 text-right">Started</th>
            <th className="px-3 py-2 text-right">Ended</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2 font-mono text-[11px]">{i.endpoint_id ?? "—"}</td>
              <td className="px-3 py-2"><HealthPill state={i.state} /></td>
              <td className="px-3 py-2 text-[12px] text-ink-muted">{i.message ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{formatRelative(i.started_at)}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{i.ended_at ? formatRelative(i.ended_at) : "ongoing"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
