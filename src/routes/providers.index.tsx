import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, type ReactNode } from "react";
import { Globe, Github, BookOpen, Radio, Layers } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { BrandIcon, prefetchBrandIcon } from "@/components/metagraphed/brand-icon";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { providersQuery, providerCountsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { Provider } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/providers/")({
  head: () => ({
    meta: [
      { title: "Providers — Metagraphed" },
      {
        name: "description",
        content:
          "Subnet teams, infrastructure providers, docs registries, and resource sources.",
      },
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
      <ApiSourceFooter
        paths={["/api/v1/providers", "/api/v1/source-health"]}
        artifacts={["/metagraph/providers.json"]}
      />
    </AppShell>
  );
}

function maskHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? null;
  }
}

function authorityTone(a?: string): string {
  switch (a) {
    case "official":
      return "border-curation-verified/40 bg-curation-verified/10 text-curation-verified";
    case "provider-claimed":
      return "border-curation-pilot/40 bg-curation-pilot/10 text-curation-pilot";
    case "community":
      return "border-curation-machine/40 bg-curation-machine/10 text-curation-machine";
    default:
      return "border-border bg-paper text-ink-muted";
  }
}

function ProvidersGrid() {
  const { data } = useSuspenseQuery(providersQuery());
  const { data: counts } = useSuspenseQuery(providerCountsQuery());
  const rows = (data.data ?? []) as Provider[];
  if (rows.length === 0)
    return (
      <EmptyState
        title="No providers tracked yet"
        description="Once provider entries are registered, they'll be listed here."
        action={{ label: "Browse all endpoints", href: "/endpoints" }}
      />
    );
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((p) => {
        const webHost = maskHost(p.website);
        const repoHost = maskHost(p.repo);
        const docsHost = maskHost(p.docs);
        const isOfficial = p.authority === "official";
        return (
          <Link
            key={p.slug}
            to="/providers/$slug"
            params={{ slug: p.slug }}
            className={classNames(
              "group block rounded-lg border border-border bg-card p-4 transition-colors",
              "hover:border-accent/60 hover:shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-3 min-w-0">
                <BrandIcon
                  url={p.website ?? p.homepage}
                  iconUrl={p.icon_url}
                  name={p.name ?? p.slug}
                  fallback={p.slug}
                  size={36}
                />
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    {p.kind ?? "provider"}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {isOfficial ? (
                      <span
                        aria-label="Official provider"
                        title="Official"
                        className="inline-block size-1.5 rounded-full bg-accent shrink-0"
                      />
                    ) : null}
                    <div className="font-display text-base font-semibold text-ink-strong truncate">
                      {p.name ?? p.slug}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] text-ink-muted truncate">
                    {p.slug}
                  </div>
                </div>
              </div>
              {p.authority ? (
                <span
                  className={classNames(
                    "font-mono text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5 shrink-0",
                    authorityTone(p.authority),
                  )}
                >
                  {p.authority}
                </span>
              ) : null}
            </div>
            {p.notes ? (
              <p className="mt-3 text-[12px] text-ink-muted leading-relaxed line-clamp-2">
                {p.notes}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
              {webHost ? (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <Globe className="size-3 shrink-0" />
                  <span className="font-mono truncate max-w-[18ch]">{webHost}</span>
                </span>
              ) : null}
              {repoHost ? (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <Github className="size-3 shrink-0" />
                  <span className="font-mono truncate max-w-[18ch]">{repoHost}</span>
                </span>
              ) : null}
              {docsHost ? (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <BookOpen className="size-3 shrink-0" />
                  <span className="font-mono truncate max-w-[18ch]">{docsHost}</span>
                </span>
              ) : null}
              {!webHost && !repoHost && !docsHost ? (
                <span className="font-mono text-[10px]">no public links yet</span>
              ) : null}
            </div>
            <ProviderCountsRow counts={counts[p.slug]} />
          </Link>
        );
      })}
    </div>
  );
}

function ProviderCountsRow({ counts }: { counts?: { surfaces: number; endpoints: number; subnets: number } }) {
  const s = counts?.surfaces ?? 0;
  const e = counts?.endpoints ?? 0;
  const n = counts?.subnets ?? 0;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
      <CountTile icon={<Layers className="size-3" />} label="Surfaces" value={s} />
      <CountTile icon={<Radio className="size-3" />} label="Endpoints" value={e} />
      <CountTile label="Subnets" value={n} />
    </div>
  );
}

function CountTile({ icon, label, value }: { icon?: ReactNode; label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-ink-muted">
        {icon}
        {label}
      </span>
      <span className={classNames(
        "font-mono text-sm tabular-nums",
        value > 0 ? "text-ink-strong" : "text-ink-muted",
      )}>
        {value > 0 ? value : "—"}
      </span>
    </div>
  );
}
