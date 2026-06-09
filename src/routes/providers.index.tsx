import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Globe, Github, BookOpen, Radio, Layers, Search, X } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { BrandIcon, prefetchBrandIcon } from "@/components/metagraphed/brand-icon";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { providersQuery, providerCountsQuery } from "@/lib/metagraphed/queries";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
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
        <Suspense fallback={<ProvidersSkeleton />}>
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

function ProvidersSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 animate-pulse h-[180px]"
        >
          <div className="flex items-start gap-3">
            <div className="size-9 rounded bg-surface" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-1/2 rounded bg-surface" />
              <div className="h-3 w-2/3 rounded bg-surface" />
              <div className="h-2 w-1/3 rounded bg-surface" />
            </div>
          </div>
          <div className="mt-4 h-8 rounded bg-surface" />
        </div>
      ))}
    </div>
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

type SortKey = "name" | "surfaces" | "endpoints" | "subnets";

function ProvidersGrid() {
  const { data: providersRes } = useSuspenseQuery(providersQuery());
  const { data: counts } = useSuspenseQuery(providerCountsQuery());
  const rows = (providersRes.data ?? []) as Provider[];
  const generatedAt = providersRes.meta?.generated_at;
  const stale = isStaleFreshness(generatedAt);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [authority, setAuthority] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");

  const kinds = useMemo(
    () => Array.from(new Set(rows.map((p) => p.kind).filter(Boolean) as string[])).sort(),
    [rows],
  );
  const authorities = useMemo(
    () => Array.from(new Set(rows.map((p) => p.authority).filter(Boolean) as string[])).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((p) => {
      if (kind && p.kind !== kind) return false;
      if (authority && p.authority !== authority) return false;
      if (!needle) return true;
      const host = maskHost(p.website ?? p.homepage) ?? "";
      return [p.name, p.slug, p.notes, host]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [rows, q, kind, authority]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortKey === "name")
        return String(a.name ?? a.slug).localeCompare(String(b.name ?? b.slug));
      const ca = counts[a.slug];
      const cb = counts[b.slug];
      const va = (ca?.[sortKey] as number | undefined) ?? 0;
      const vb = (cb?.[sortKey] as number | undefined) ?? 0;
      return vb - va;
    });
    return arr;
  }, [filtered, sortKey, counts]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ric =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const handle = ric(() => {
      for (const p of sorted)
        prefetchBrandIcon(p.website ?? p.homepage, 36, {
          iconUrl: p.icon_url,
          repoUrl: p.repo,
          lookup: { providerSlug: p.slug },
        });
    });
    return () => {
      const cic =
        (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback ??
        window.clearTimeout;
      cic(handle as number);
    };
  }, [sorted]);

  if (rows.length === 0)
    return (
      <EmptyState
        title="No providers tracked yet"
        description="Once provider entries are registered, they'll be listed here."
        action={{ label: "Browse all endpoints", href: "/endpoints" }}
      />
    );

  const hasFilters = q || kind || authority;

  return (
    <div className="space-y-3">
      {stale ? <StaleBanner generatedAt={res.data.meta?.generated_at} /> : null}

      {/* Toolbar */}
      <div className="sticky top-14 z-10 -mx-1 px-1 py-2 backdrop-blur bg-paper/85 border-b border-border/60 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search providers, slugs, hosts…"
            className="w-full rounded border border-border bg-card pl-7 pr-2 py-1.5 text-[12px] focus:outline-none focus:border-ink/30"
            aria-label="Search providers"
          />
        </div>
        <Selector label="Kind" value={kind} onChange={setKind} options={kinds} />
        <Selector label="Authority" value={authority} onChange={setAuthority} options={authorities} />
        <Selector
          label="Sort"
          value={sortKey}
          onChange={(v) => setSortKey(v as SortKey)}
          options={["name", "surfaces", "endpoints", "subnets"]}
          allowEmpty={false}
        />
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setKind("");
              setAuthority("");
            }}
            className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> Clear
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          {sorted.length} of {rows.length} providers
        </span>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          title="No providers match this filter"
          description="Try clearing filters or adjusting your search."
          action={{ label: "Browse all endpoints", href: "/endpoints" }}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((p) => {
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
                      repoUrl={p.repo}
                      providerSlug={p.slug}
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
                        <div className="font-display text-base font-semibold text-ink-strong line-clamp-2 leading-tight">
                          {p.name ?? p.slug}
                        </div>
                      </div>
                      <div className="font-mono text-[10px] text-ink-muted truncate">{p.slug}</div>
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
      )}
    </div>
  );
}

function Selector({
  label,
  value,
  onChange,
  options,
  allowEmpty = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowEmpty?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
      <span className="font-mono uppercase tracking-widest text-[10px]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-card px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-ink/30"
      >
        {allowEmpty ? <option value="">all</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProviderCountsRow({
  counts,
}: {
  counts?: { surfaces: number; endpoints: number; subnets: number };
}) {
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
      <span
        className={classNames(
          "font-mono text-sm tabular-nums",
          value > 0 ? "text-ink-strong" : "text-ink-muted",
        )}
      >
        {value > 0 ? value : "—"}
      </span>
    </div>
  );
}
