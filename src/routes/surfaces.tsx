import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CurationChip } from "@/components/metagraphed/chips";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  FilterBar,
  Pagination,
  ResetLink,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { surfacesQuery } from "@/lib/metagraphed/queries";
import { formatRelative } from "@/lib/metagraphed/format";
import { matchesQuery, paginate, sortBy, tableSearchSchema } from "@/lib/metagraphed/url-state";
import type { Surface } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/surfaces")({
  validateSearch: zodValidator(tableSearchSchema),
  head: () => ({
    meta: [
      { title: "Surfaces — Metagraphed" },
      { name: "description", content: "Verified public interfaces across Bittensor subnets: APIs, docs, dashboards, repos, SDKs." },
    ],
  }),
  component: SurfacesPage,
});

function SurfacesPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Registry"
        title="Surfaces"
        description="Verified public interfaces across subnets — filter by kind, provider, and netuid."
        right={<ResetLink to="/surfaces" />}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <SurfacesTable />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function SurfacesTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(surfacesQuery());
  const all = (data.data ?? []) as Surface[];

  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) if (s.kind) set.add(s.kind);
    return Array.from(set).sort().map((v) => ({ value: v, label: v }));
  }, [all]);

  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) {
      const p = s.provider_slug ?? s.provider;
      if (p) set.add(p);
    }
    return Array.from(set).sort().map((v) => ({ value: v, label: v }));
  }, [all]);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, page: 1 }) as never });

  const onSort = (field: string) =>
    navigate({
      search: (prev) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "asc" ? "desc" : "asc",
        }) as never,
    });

  const filtered = all.filter((s) => {
    if (!matchesQuery([s.name, s.url, s.provider, s.provider_slug, s.netuid], search.q)) return false;
    if (search.kind && s.kind !== search.kind) return false;
    if (search.provider && (s.provider_slug ?? s.provider) !== search.provider) return false;
    return true;
  });
  const sorted = sortBy(filtered, search.sort, search.order, (row, key) => (row as Record<string, unknown>)[key]);
  const rows = paginate(sorted, search.page, search.pageSize);

  return (
    <div>
      <FilterBar>
        <SearchInput value={search.q} onChange={(v) => setSearch({ q: v })} placeholder="Search by name, URL, provider, or netuid" />
        <SelectFilter label="kind" value={search.kind} onChange={(v) => setSearch({ kind: v })} options={kindOptions} />
        <SelectFilter label="provider" value={search.provider} onChange={(v) => setSearch({ provider: v })} options={providerOptions} />
      </FilterBar>
      {sorted.length === 0 ? (
        <EmptyState title="No matching surfaces" />
      ) : (
        <div className="rounded border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/50">
                <tr>
                  <th className="px-3 py-2"><SortHeader label="Netuid" field="netuid" active={search.sort === "netuid"} order={search.order} onSort={onSort} /></th>
                  <th className="px-3 py-2"><SortHeader label="Kind" field="kind" active={search.sort === "kind"} order={search.order} onSort={onSort} /></th>
                  <th className="px-3 py-2"><SortHeader label="Name" field="name" active={search.sort === "name"} order={search.order} onSort={onSort} /></th>
                  <th className="px-3 py-2">URL</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Curation</th>
                  <th className="px-3 py-2 text-right"><SortHeader label="Updated" field="updated_at" active={search.sort === "updated_at"} order={search.order} onSort={onSort} align="right" /></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((s) => (
                  <tr key={s.id} className="hover:bg-surface/40">
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                      {s.netuid != null ? (
                        <Link to="/subnets/$netuid" params={{ netuid: String(s.netuid) }} className="hover:text-ink-strong">{String(s.netuid).padStart(3, "0")}</Link>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{s.kind ?? "—"}</td>
                    <td className="px-3 py-2 font-medium text-ink-strong">{s.name ?? "—"}</td>
                    <td className="px-3 py-2 text-[12px]">{s.url ? <ExternalLink href={s.url} authRequired={s.auth_required} publicSafe={s.public_safe ?? true}>{s.url}</ExternalLink> : "—"}</td>
                    <td className="px-3 py-2 text-[12px]">
                      {s.provider_slug ? (
                        <Link to="/providers/$slug" params={{ slug: s.provider_slug }} className="hover:underline">{s.provider ?? s.provider_slug}</Link>
                      ) : (s.provider ?? "—")}
                    </td>
                    <td className="px-3 py-2"><CurationChip level={s.curation_level} /></td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{formatRelative(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={search.page} pageSize={search.pageSize} total={sorted.length} onPage={(p) => navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, page: p }) as never })} />
        </div>
      )}
    </div>
  );
}
