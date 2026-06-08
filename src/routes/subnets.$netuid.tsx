import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CandidateChip, CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import {
  subnetProfileQuery,
  subnetSurfacesQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetCandidatesQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, formatRelative, isStaleFreshness } from "@/lib/metagraphed/format";
import type { Endpoint, Surface, Candidate } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/subnets/$netuid")({
  parseParams: ({ netuid }) => {
    const n = Number(netuid);
    if (!Number.isFinite(n) || n < 0) throw notFound();
    return { netuid: n };
  },
  stringifyParams: ({ netuid }) => ({ netuid: String(netuid) }),
  head: ({ params }) => ({
    meta: [
      { title: `Subnet ${params.netuid} — Metagraphed` },
      { name: "description", content: `Public-interface registry for Bittensor subnet ${params.netuid}.` },
    ],
  }),
  component: SubnetDetailPage,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Subnet not found" description="No active Finney netuid matches this URL." />
      <Link to="/subnets" className="text-sm underline">Back to registry</Link>
    </AppShell>
  ),
});

function SubnetDetailPage() {
  const { netuid } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <Header netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Section title="Verified surfaces">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <SurfacesList netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>
          <Section title="Endpoints">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <EndpointsList netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>
          <Section title="Candidates (unverified leads)">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <CandidatesList netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>
          <Section title="Evidence & sources">
            <EvidencePanel netuid={netuid} />
          </Section>

        </div>
        <aside className="space-y-6">
          <Section title="Health">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <HealthPanel netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>
          <Section title="API">
            <div className="space-y-2">
              <CopyableCode label="profile" value={`${API_BASE}/api/v1/subnets/${netuid}/profile`} truncate={false} className="w-full" />
              <CopyableCode label="surfaces" value={`${API_BASE}/api/v1/subnets/${netuid}/surfaces`} truncate={false} className="w-full" />
              <CopyableCode label="endpoints" value={`${API_BASE}/api/v1/subnets/${netuid}/endpoints`} truncate={false} className="w-full" />
              <CopyableCode label="health" value={`${API_BASE}/api/v1/subnets/${netuid}/health`} truncate={false} className="w-full" />
            </div>
          </Section>
        </aside>
      </div>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">{title}</h2>
      {children}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function Header({ netuid }: { netuid: number }) {
  const { data, meta } = useSuspenseQuery(subnetProfileQuery(netuid)).data;
  const profile = data;
  const stale = meta?.stale || isStaleFreshness(meta?.generated_at);

  return (
    <>
      <PageHeading
        eyebrow={`Netuid ${String(netuid).padStart(3, "0")}`}
        title={profile?.name ?? `Subnet ${netuid}`}
        description={profile?.description ?? undefined}
        right={
          <div className="flex items-center gap-2">
            <CurationChip level={profile?.curation_level} />
            <HealthPill state={profile?.health} />
          </div>
        }
      />
      {stale ? <div className="mb-4"><StaleBanner generatedAt={meta?.generated_at} /></div> : null}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded overflow-hidden">
        <Stat label="Symbol" value={profile?.symbol ?? "—"} />
        <Stat label="Participants" value={formatNumber(profile?.participants)} />
        <Stat label="Tempo" value={profile?.tempo != null ? String(profile.tempo) : "—"} />
        <Stat label="Completeness" value={profile?.completeness != null ? `${Math.round((profile.completeness as number) * 100)}%` : "—"} />
      </div>
      {profile?.homepage || profile?.repo || profile?.docs ? (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {profile?.homepage ? <ExternalLink href={profile.homepage}>homepage</ExternalLink> : null}
          {profile?.repo ? <ExternalLink href={profile.repo}>repo</ExternalLink> : null}
          {profile?.docs ? <ExternalLink href={profile.docs}>docs</ExternalLink> : null}
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className="font-display text-lg font-semibold text-ink-strong tabular-nums">{value}</div>
    </div>
  );
}

function SurfacesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetSurfacesQuery(netuid));
  const rows = (data.data ?? []) as Surface[];
  if (rows.length === 0) return <EmptyState title="No verified surfaces yet" description="Candidates may exist below — they need verification." />;
  return (
    <ul className="space-y-2">
      {rows.map((s) => (
        <li key={s.id} className="rounded border border-border bg-card p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{s.kind ?? "surface"}</span>
                <CurationChip level={s.curation_level} />
              </div>
              <div className="font-medium text-ink-strong">{s.name ?? s.url}</div>
              {s.url ? <ExternalLink href={s.url} authRequired={s.auth_required} publicSafe={s.public_safe ?? true} className="text-xs">{s.url}</ExternalLink> : null}
            </div>
            <span className="font-mono text-[10px] text-ink-muted shrink-0">{formatRelative(s.updated_at)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EndpointsList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetEndpointsQuery(netuid));
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) return <EmptyState title="No endpoints" />;
  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Kind</th>
            <th className="px-3 py-2 text-left">URL</th>
            <th className="px-3 py-2 text-left">Provider</th>
            <th className="px-3 py-2">Health</th>
            <th className="px-3 py-2 text-right">Latency</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">{e.kind ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[28ch]">{e.url ?? "—"}</td>
              <td className="px-3 py-2 text-[12px]">{e.provider ?? e.provider_slug ?? "—"}</td>
              <td className="px-3 py-2"><HealthPill state={e.health} /></td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{e.latency_ms != null ? `${e.latency_ms}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidatesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetCandidatesQuery(netuid));
  const rows = (data.data ?? []) as Candidate[];
  if (rows.length === 0) return <EmptyState title="No candidate leads" description="Submit corrections via the public repo." />;
  return (
    <ul className="space-y-2">
      {rows.map((c) => (
        <li key={c.id} className="rounded border border-dashed border-ink-subtle bg-paper p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <CandidateChip />
                <span className="font-mono text-[10px] uppercase text-ink-muted">{c.kind ?? "lead"}</span>
              </div>
              {c.url ? <ExternalLink href={c.url} className="text-xs">{c.url}</ExternalLink> : null}
              {c.notes ? <p className="mt-1 text-xs text-ink-muted">{c.notes}</p> : null}
            </div>
            <span className="font-mono text-[10px] text-ink-muted shrink-0">{formatRelative(c.discovered_at)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HealthPanel({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetHealthQuery(netuid));
  const h = data.data;
  return (
    <div className="rounded border border-border bg-card p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between"><span className="text-ink-muted">OK</span><span className="font-mono text-health-ok">{formatNumber(h?.ok)}</span></div>
      <div className="flex items-center justify-between"><span className="text-ink-muted">Warn</span><span className="font-mono text-health-warn">{formatNumber(h?.warn)}</span></div>
      <div className="flex items-center justify-between"><span className="text-ink-muted">Down</span><span className="font-mono text-health-down">{formatNumber(h?.down)}</span></div>
      <div className="flex items-center justify-between"><span className="text-ink-muted">Uptime 24h</span><span className="font-mono">{h?.uptime_24h != null ? `${(h.uptime_24h * 100).toFixed(2)}%` : "—"}</span></div>
      <div className="font-mono text-[10px] text-ink-muted">{formatRelative(h?.generated_at)}</div>
    </div>
  );
}
