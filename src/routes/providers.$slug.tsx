import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { HealthDot } from "@/components/metagraphed/chips";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ProfileHero } from "@/components/metagraphed/profile-hero";
import { PrimaryLinksRail } from "@/components/metagraphed/primary-links-rail";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { providerQuery, providerEndpointsQuery } from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import type { Endpoint } from "@/lib/metagraphed/types";

type SearchParams = { tab?: string };

export const Route = createFileRoute("/providers/$slug")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  parseParams: ({ slug }) => {
    if (!slug) throw notFound();
    return { slug };
  },
  head: ({ params }) => ({
    meta: [
      { title: `${params.slug} — Provider — Metagraphed` },
      { name: "description", content: `Public endpoints and resources from ${params.slug}.` },
    ],
  }),
  component: ProviderDetail,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Provider not found" />
      <Link to="/providers" className="text-sm underline">
        Back to providers
      </Link>
    </AppShell>
  ),
});

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "endpoints", label: "Endpoints" },
  { id: "subnets", label: "Subnets served" },
  { id: "api", label: "API" },
] as const;

function ProviderDetail() {
  const { slug } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <ProviderShell slug={slug} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function ProviderShell({ slug }: { slug: string }) {
  const { data: p } = useSuspenseQuery(providerQuery(slug)).data;
  const summary = p?.endpoint_summary;
  const tab = useActiveTab("overview");

  return (
    <>
      <ProfileHero
        eyebrow={
          <span>
            Provider
            {p?.kind ? <> · {p.kind}</> : null}
            {p?.authority ? <> · {p.authority}</> : null}
          </span>
        }
        title={p?.name ?? slug}
        subtitle={<>· {slug}</>}
        description={p?.notes}
        links={<PrimaryLinksRail website={p?.website ?? p?.homepage} docs={p?.docs} />}
        stats={[
          { label: "Endpoints", value: formatNumber(summary?.endpoint_count) },
          { label: "Monitored", value: formatNumber(summary?.monitored_count) },
          {
            label: "OK",
            value: formatNumber(summary?.by_status?.ok),
          },
          {
            label: "Pool-eligible",
            value: formatNumber(summary?.pool_eligible_count),
          },
        ]}
      />

      <ProfileTabs
        tabs={TABS.map((t) =>
          t.id === "endpoints" ? { ...t, count: summary?.endpoint_count } : t,
        )}
        defaultTab="overview"
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {tab === "overview" ? <OverviewPanel slug={slug} /> : null}
          {tab === "endpoints" ? <EndpointsTable slug={slug} /> : null}
          {tab === "subnets" ? <SubnetsServed slug={slug} /> : null}
          {tab === "api" ? <ApiPanel slug={slug} /> : null}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-32 self-start">
          {summary?.by_kind ? <BreakdownCard title="By kind" data={summary.by_kind} /> : null}
          {summary?.by_status ? <BreakdownCard title="By status" data={summary.by_status} /> : null}
          {summary?.by_layer ? <BreakdownCard title="By layer" data={summary.by_layer} /> : null}
        </aside>
      </div>
    </>
  );
}

function OverviewPanel({ slug }: { slug: string }) {
  return (
    <>
      <section>
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
          Endpoints
        </h2>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <EndpointsTable slug={slug} compact />
          </Suspense>
        </QueryErrorBoundary>
      </section>
      <section>
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
          Subnets served
        </h2>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <SubnetsServed slug={slug} compact />
          </Suspense>
        </QueryErrorBoundary>
      </section>
    </>
  );
}

function EndpointsTable({ slug, compact }: { slug: string; compact?: boolean }) {
  const { data } = useSuspenseQuery(providerEndpointsQuery(slug));
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) return <EmptyState title="No endpoints for this provider" />;
  const visible = compact ? rows.slice(0, 8) : rows;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Netuid</th>
            <th className="px-3 py-2 text-left">Kind</th>
            <th className="px-3 py-2 text-left">URL</th>
            <th className="px-3 py-2 text-center">Health</th>
            <th className="px-3 py-2 text-right">Latency</th>
            <th className="px-3 py-2 text-right hidden md:table-cell">Probed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {visible.map((e) => (
            <tr key={e.id}>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                {e.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: String(e.netuid) }}
                    className="hover:text-ink-strong"
                  >
                    {String(e.netuid).padStart(3, "0")}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[32ch]">
                {e.url ?? "—"}
              </td>
              <td className="px-3 py-2 text-center">
                <span className="inline-flex justify-center">
                  <HealthDot state={e.health} />
                </span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-[11px]">
                {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted hidden md:table-cell">
                <TimeAgo at={e.last_probed_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {compact && rows.length > visible.length ? (
        <div className="border-t border-border bg-surface/30 px-3 py-2 text-[11px] text-ink-muted">
          + {rows.length - visible.length} more — open the Endpoints tab.
        </div>
      ) : null}
    </div>
  );
}

function SubnetsServed({ slug, compact }: { slug: string; compact?: boolean }) {
  const { data } = useSuspenseQuery(providerEndpointsQuery(slug));
  const rows = (data.data ?? []) as Endpoint[];
  const grouped = useMemo(() => {
    const m = new Map<number, Endpoint[]>();
    for (const r of rows) {
      if (r.netuid == null) continue;
      const arr = m.get(r.netuid) ?? [];
      arr.push(r);
      m.set(r.netuid, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [rows]);
  if (grouped.length === 0)
    return <EmptyState title="No per-subnet endpoints recorded" />;
  const visible = compact ? grouped.slice(0, 8) : grouped;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map(([netuid, items]) => (
        <li key={netuid}>
          <Link
            to="/subnets/$netuid"
            params={{ netuid: String(netuid) }}
            className="block rounded border border-border bg-card p-3 hover:border-ink/30"
          >
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Netuid
              </span>
              <span className="font-display text-base font-semibold text-ink-strong tabular-nums">
                {String(netuid).padStart(3, "0")}
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] text-ink-muted">
              {items.length} endpoint{items.length === 1 ? "" : "s"}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BreakdownCard({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map((e) => e[1]));
  return (
    <section className="rounded border border-border bg-card p-3">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {entries.map(([k, v]) => (
          <li key={k}>
            <div className="flex items-baseline justify-between gap-2 mb-0.5">
              <span className="font-mono text-[11px] text-ink truncate">{k}</span>
              <span className="font-mono text-[11px] text-ink-muted tabular-nums">{v}</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded bg-surface">
              <div
                className="h-full bg-ink-strong/70"
                style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApiPanel({ slug }: { slug: string }) {
  const rows: Array<{ label: string; path: string }> = [
    { label: "provider", path: `/api/v1/providers/${slug}` },
    { label: "endpoints", path: `/api/v1/providers/${slug}/endpoints` },
    { label: "artifact", path: `/metagraph/providers/${slug}.json` },
  ];
  return (
    <section>
      <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
        API & artifacts
      </h2>
      <div className="space-y-2">
        {rows.map((r) => (
          <CopyableCode
            key={r.label}
            label={r.label}
            value={`${API_BASE}${r.path}`}
            truncate={false}
            className="w-full"
          />
        ))}
      </div>
    </section>
  );
}
