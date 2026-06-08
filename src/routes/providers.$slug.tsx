import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { HealthPill } from "@/components/metagraphed/chips";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { providerQuery, providerEndpointsQuery } from "@/lib/metagraphed/queries";
import { formatRelative } from "@/lib/metagraphed/format";
import type { Endpoint } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/providers/$slug")({
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
      <Link to="/providers" className="text-sm underline">Back to providers</Link>
    </AppShell>
  ),
});

function ProviderDetail() {
  const { slug } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <Header slug={slug} />
        </Suspense>
      </QueryErrorBoundary>
      <section className="mt-6">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Endpoints</h2>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <ProviderEndpoints slug={slug} />
          </Suspense>
        </QueryErrorBoundary>
      </section>
    </AppShell>
  );
}

function Header({ slug }: { slug: string }) {
  const { data } = useSuspenseQuery(providerQuery(slug));
  const p = data.data;
  return (
    <>
      <PageHeading
        eyebrow={p?.kind ?? "Provider"}
        title={p?.name ?? slug}
        description={p?.homepage ?? slug}
        right={p?.authority ? <span className="font-mono text-[10px] uppercase tracking-widest rounded border border-border bg-card px-2 py-1 text-ink-muted">{p.authority}</span> : null}
      />
      <div className="flex flex-wrap gap-2 text-xs">
        {p?.homepage ? <ExternalLink href={p.homepage}>homepage</ExternalLink> : null}
        {p?.docs ? <ExternalLink href={p.docs}>docs</ExternalLink> : null}
      </div>
    </>
  );
}

function ProviderEndpoints({ slug }: { slug: string }) {
  const { data } = useSuspenseQuery(providerEndpointsQuery(slug));
  const rows = (data.data ?? []) as Endpoint[];
  if (rows.length === 0) return <EmptyState title="No endpoints for this provider" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Netuid</th>
            <th className="px-3 py-2 text-left">Kind</th>
            <th className="px-3 py-2 text-left">URL</th>
            <th className="px-3 py-2">Health</th>
            <th className="px-3 py-2 text-right">Latency</th>
            <th className="px-3 py-2 text-right">Probed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                {e.netuid != null ? (
                  <Link to="/subnets/$netuid" params={{ netuid: String(e.netuid) }} className="hover:text-ink-strong">{String(e.netuid).padStart(3, "0")}</Link>
                ) : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[32ch]">{e.url ?? "—"}</td>
              <td className="px-3 py-2"><HealthPill state={e.health} /></td>
              <td className="px-3 py-2 text-right font-mono text-[11px]">{e.latency_ms != null ? `${e.latency_ms}ms` : "—"}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted"><TimeAgo at={e.last_probed_at} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
