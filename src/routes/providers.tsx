import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { providersQuery } from "@/lib/metagraphed/queries";
import type { Provider } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/providers")({
  head: () => ({
    meta: [
      { title: "Providers — Metagraphed" },
      { name: "description", content: "Subnet teams, infrastructure providers, docs registries, and resource sources." },
    ],
  }),
  component: ProvidersPage,
});

function ProvidersPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Infrastructure"
        title="Providers"
        description="Teams, infra operators, docs registries, and community sources behind public interfaces."
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <ProvidersGrid />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/providers", "/api/v1/source-health"]} artifacts={["/metagraph/providers.json"]} />
    </AppShell>
  );
}

function ProvidersGrid() {
  const { data } = useSuspenseQuery(providersQuery());
  const rows = (data.data ?? []) as Provider[];
  if (rows.length === 0) return <EmptyState title="No providers" />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((p) => (
        <Link key={p.slug} to="/providers/$slug" params={{ slug: p.slug }} className="block rounded border border-border bg-card p-4 hover:border-ink/30">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{p.kind ?? "—"}</div>
              <div className="font-display text-base font-semibold text-ink-strong">{p.name ?? p.slug}</div>
              <div className="font-mono text-[10px] text-ink-muted truncate">{p.slug}</div>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-widest rounded border border-border bg-paper px-1.5 py-0.5 text-ink-muted">
              {p.authority ?? "—"}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded border border-border bg-paper px-2 py-1">
              <div className="font-mono text-[9px] uppercase text-ink-muted">endpoints</div>
              <div className="font-mono text-ink-strong">{p.endpoints_count ?? "—"}</div>
            </div>
            <div className="rounded border border-border bg-paper px-2 py-1">
              <div className="font-mono text-[9px] uppercase text-ink-muted">surfaces</div>
              <div className="font-mono text-ink-strong">{p.surfaces_count ?? "—"}</div>
            </div>
          </div>
          {p.homepage ? (
            <div className="mt-3 text-[11px]">
              <ExternalLink href={p.homepage}>{p.homepage}</ExternalLink>
            </div>
          ) : null}
        </Link>
      ))}
    </div>
  );
}
