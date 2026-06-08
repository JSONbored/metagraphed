import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import {
  BookOpen,
  Code2,
  Database,
  ExternalLink as ExternalLinkIcon,
  FileCode,
  Github,
  Globe,
  LayoutDashboard,
  Radio,
  Wrench,
} from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CandidateChip, CurationChip, HealthDot } from "@/components/metagraphed/chips";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import { FreshnessIndicator } from "@/components/metagraphed/freshness";
import {
  subnetProfileQuery,
  subnetSurfacesQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetCandidatesQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames, formatNumber, formatRelative, isStaleFreshness } from "@/lib/metagraphed/format";
import type { Endpoint, Surface, Candidate, SubnetProfile } from "@/lib/metagraphed/types";

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
      {
        name: "description",
        content: `Public-interface registry for Bittensor subnet ${params.netuid}: surfaces, endpoints, schemas, health.`,
      },
    ],
  }),
  component: SubnetDetailPage,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Subnet not found" description="No active Finney netuid matches this URL." />
      <Link to="/subnets" className="text-sm underline">
        Back to registry
      </Link>
    </AppShell>
  ),
});

function SubnetDetailPage() {
  const { netuid } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <Hero netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>

      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="mt-4 h-28 w-full" />}>
          <QuickAccessResources netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>

      <SectionNav />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <LiveHealthPanel netuid={netuid} />
            </Suspense>
          </QueryErrorBoundary>

          <Section id="schemas" title="Schemas & API contracts" subtitle="Generated client targets for this subnet.">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <SchemasPanel netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>

          <Section id="surfaces" title="Verified surfaces" subtitle="Curated public interfaces with provenance.">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <SurfacesList netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>

          <Section id="endpoints" title="Endpoints" subtitle="Probed resources — health and latency are probe-derived.">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <EndpointsList netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>

          <Section id="candidates" title="Candidates" subtitle="Unverified leads from public sources. Always labeled.">
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <CandidatesList netuid={netuid} />
              </Suspense>
            </QueryErrorBoundary>
          </Section>

          <Section id="evidence" title="Evidence & sources" subtitle="Every claim should be traceable.">
            <EvidencePanel netuid={netuid} />
          </Section>
        </div>

        <aside className="space-y-6 lg:sticky lg:top-20 self-start">
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

/**
 * Cosmos-directory-style in-page section navigation. Anchor links scroll to
 * a section; the currently-visible section gets highlighted by the browser
 * via `:target` would lose state on initial load, so we keep it visually
 * minimal and rely on scroll behavior alone. Sticky under the app header.
 */
function SectionNav() {
  const items: Array<{ to: string; label: string }> = [
    { to: "#schemas", label: "Schemas" },
    { to: "#surfaces", label: "Surfaces" },
    { to: "#endpoints", label: "Endpoints" },
    { to: "#candidates", label: "Candidates" },
    { to: "#evidence", label: "Evidence" },
  ];
  return (
    <nav
      aria-label="Subnet sections"
      className="sticky top-14 z-10 -mx-4 md:mx-0 mt-4 border-b border-border bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 md:border md:rounded md:bg-card"
    >
      <ul className="flex items-center gap-1 overflow-x-auto px-3 py-1.5">
        {items.map((it) => (
          <li key={it.to}>
            <a
              href={it.to}
              className="inline-flex items-center rounded px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors whitespace-nowrap"
            >
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-32">
      <div className="mb-2">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 text-[11px] text-ink-muted">{subtitle}</p> : null}
      </div>
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

function Hero({ netuid }: { netuid: number }) {
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
            <HealthDot state={profile?.health} variant="label" />
          </div>
        }
      />
      {stale ? (
        <div className="mb-4">
          <StaleBanner generatedAt={meta?.generated_at} />
        </div>
      ) : null}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded overflow-hidden">
        <Stat label="Symbol" value={profile?.symbol ?? "—"} />
        <Stat label="Participants" value={formatNumber(profile?.participants)} />
        <Stat label="Tempo" value={profile?.tempo != null ? String(profile.tempo) : "—"} />
        <Stat
          label="Completeness"
          value={
            profile?.completeness != null
              ? `${Math.round((profile.completeness as number) * 100)}%`
              : "—"
          }
        />
      </div>
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

interface ResourceCard {
  label: string;
  href: string;
  kind: string;
  icon: typeof Globe;
  source: "profile" | "surface";
}

function pickResources(profile: SubnetProfile | undefined, surfaces: Surface[]): ResourceCard[] {
  const out: ResourceCard[] = [];
  const seen = new Set<string>();
  const push = (c: ResourceCard) => {
    const k = c.href;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };

  if (profile?.homepage) push({ label: "Homepage", href: profile.homepage, kind: "homepage", icon: Globe, source: "profile" });
  if (profile?.docs) push({ label: "Docs", href: profile.docs, kind: "docs", icon: BookOpen, source: "profile" });
  if (profile?.repo) push({ label: "Repository", href: profile.repo, kind: "repo", icon: Github, source: "profile" });

  const iconFor = (kind?: string): typeof Globe => {
    const k = (kind ?? "").toLowerCase();
    if (k === "docs") return BookOpen;
    if (k === "repo") return Github;
    if (k === "dashboard") return LayoutDashboard;
    if (k === "api") return Code2;
    if (k === "sdk") return Wrench;
    if (k === "data") return Database;
    if (k === "sse") return Radio;
    if (k === "schema") return FileCode;
    return Globe;
  };

  for (const s of surfaces) {
    if (!s.url) continue;
    push({
      label: s.name ?? s.kind ?? s.url,
      href: s.url,
      kind: s.kind ?? "surface",
      icon: iconFor(s.kind),
      source: "surface",
    });
  }
  return out.slice(0, 8);
}

function QuickAccessResources({ netuid }: { netuid: number }) {
  const profileRes = useSuspenseQuery(subnetProfileQuery(netuid)).data;
  const surfacesRes = useSuspenseQuery(subnetSurfacesQuery(netuid)).data;
  const profile = profileRes.data as SubnetProfile | undefined;
  const surfaces = (surfacesRes.data ?? []) as Surface[];
  const resources = pickResources(profile, surfaces);
  if (resources.length === 0) {
    return (
      <div className="mt-6">
        <Section title="Quick access" subtitle="No public resources have been curated for this subnet yet.">
          <EmptyState title="No quick-access resources" description="See candidates below for unverified leads." />
        </Section>
      </div>
    );
  }
  return (
    <div className="mt-6">
      <Section title="Quick access" subtitle="Jump straight to the public resources builders use most.">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {resources.map((r) => {
            const Icon = r.icon;
            return (
              <li key={r.href}>
                <a
                  href={r.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex h-full items-start gap-3 rounded border border-border bg-card p-3 hover:border-ink/30 transition-colors min-h-16"
                >
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded bg-surface text-ink-strong">
                    <Icon className="size-4" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                        {r.kind}
                      </span>
                      <ExternalLinkIcon className="size-3 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                    </span>
                    <span className="block truncate text-sm font-medium text-ink-strong">{r.label}</span>
                    <span className="block truncate font-mono text-[10px] text-ink-muted">
                      {hostFor(r.href)}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

function hostFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LiveHealthPanel({ netuid }: { netuid: number }) {
  const { data, meta } = useSuspenseQuery(subnetHealthQuery(netuid)).data;
  const h = data;
  const total = (h?.ok ?? 0) + (h?.warn ?? 0) + (h?.down ?? 0) + (h?.unknown ?? 0);
  return (
    <Section title="Live health" subtitle="Probe-derived only. Refreshes when sources publish new snapshots.">
      <div className="rounded border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border">
          <HCell color="bg-health-ok" label="OK" value={formatNumber(h?.ok)} />
          <HCell color="bg-health-warn" label="Warn" value={formatNumber(h?.warn)} pulse />
          <HCell color="bg-health-down" label="Down" value={formatNumber(h?.down)} pulse />
          <HCell color="bg-health-unknown" label="Unknown" value={formatNumber(h?.unknown)} />
          <HCell
            color="bg-ink-strong"
            label="Uptime 24h"
            value={h?.uptime_24h != null ? `${(h.uptime_24h * 100).toFixed(2)}%` : "—"}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface/30 px-3 py-2 text-[11px]">
          <FreshnessIndicator at={meta?.generated_at ?? h?.generated_at} />
          <span className="font-mono text-ink-muted">
            {total} endpoint{total === 1 ? "" : "s"} tracked
          </span>
        </div>
      </div>
    </Section>
  );
}

function HCell({
  label,
  value,
  color,
  pulse,
}: {
  label: string;
  value: string;
  color: string;
  pulse?: boolean;
}) {
  return (
    <div className="bg-card p-3">
      <div className="flex items-center gap-1.5">
        <span className={classNames("size-1.5 rounded-full", color, pulse && "mg-pulse")} />
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</span>
      </div>
      <div className="mt-1 font-display text-lg font-semibold text-ink-strong tabular-nums">{value}</div>
    </div>
  );
}

function SchemasPanel({ netuid }: { netuid: number }) {
  const surfacesRes = useSuspenseQuery(subnetSurfacesQuery(netuid)).data;
  const surfaces = (surfacesRes.data ?? []) as Surface[];
  const schemas = surfaces.filter((s) => s.schema_url || s.kind === "api");
  if (schemas.length === 0) {
    return <EmptyState title="No schema URLs yet" description="API surfaces with OpenAPI/JSON Schema will appear here." />;
  }
  return (
    <ul className="space-y-2">
      {schemas.map((s) => (
        <li key={s.id} className="rounded border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode className="size-3.5 text-ink-muted shrink-0" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {s.kind ?? "api"}
              </span>
              <span className="truncate text-sm font-medium text-ink-strong">{s.name ?? s.url}</span>
            </div>
            <span className="font-mono text-[10px] text-ink-muted shrink-0">
              {formatRelative(s.updated_at)}
            </span>
          </div>
          {s.schema_url ? (
            <CopyableCode label="schema" value={s.schema_url} truncate={false} className="w-full" />
          ) : s.url ? (
            <CopyableCode label="endpoint" value={s.url} truncate={false} className="w-full" />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SurfacesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetSurfacesQuery(netuid));
  const rows = (data.data ?? []) as Surface[];
  if (rows.length === 0)
    return (
      <EmptyState
        title="No verified surfaces yet"
        description="Candidates may exist below — they need verification."
      />
    );
  return (
    <ul className="space-y-2">
      {rows.map((s) => (
        <li key={s.id} className="rounded border border-border bg-card p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  {s.kind ?? "surface"}
                </span>
                <CurationChip level={s.curation_level} />
              </div>
              <div className="font-medium text-ink-strong">{s.name ?? s.url}</div>
              {s.url ? (
                <ExternalLink
                  href={s.url}
                  authRequired={s.auth_required}
                  publicSafe={s.public_safe ?? true}
                  className="text-xs"
                >
                  {s.url}
                </ExternalLink>
              ) : null}
            </div>
            <span className="font-mono text-[10px] text-ink-muted shrink-0">
              {formatRelative(s.updated_at)}
            </span>
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
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">URL</th>
              <th className="px-3 py-2 text-left">Provider</th>
              <th className="px-3 py-2 text-center">Health</th>
              <th className="px-3 py-2 text-right">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">{e.kind ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[28ch]">{e.url ?? "—"}</td>
                <td className="px-3 py-2 text-[12px]">{e.provider ?? e.provider_slug ?? "—"}</td>
                <td className="px-3 py-2 text-center">
                  <span className="inline-flex justify-center">
                    <HealthDot state={e.health} />
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                  {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CandidatesList({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetCandidatesQuery(netuid));
  const rows = (data.data ?? []) as Candidate[];
  if (rows.length === 0)
    return <EmptyState title="No candidate leads" description="Submit corrections via the public repo." />;
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
              {c.url ? (
                <ExternalLink href={c.url} className="text-xs">
                  {c.url}
                </ExternalLink>
              ) : null}
              {c.notes ? <p className="mt-1 text-xs text-ink-muted">{c.notes}</p> : null}
            </div>
            <span className="font-mono text-[10px] text-ink-muted shrink-0">
              {formatRelative(c.discovered_at)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
