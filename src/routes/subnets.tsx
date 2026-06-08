import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ShareButton } from "@/components/metagraphed/share-button";
import {
  FilterBar,
  Pagination,
  ResetLink,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { subnetsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";
import { matchesQuery, paginate, sortBy, tableSearchSchema } from "@/lib/metagraphed/url-state";
import type { Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/subnets")({
  validateSearch: zodValidator(tableSearchSchema),
  head: () => ({
    meta: [
      { title: "Subnets — Metagraphed" },
      {
        name: "description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
    ],
  }),
  component: SubnetsPage,
});

function SubnetsPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Registry"
        title="Subnets"
        description="Every active Finney netuid — root and application — with curation level, surface count, health, and freshness."
        right={<><ShareButton /><ResetLink to="/subnets" /></>}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <SubnetsTable />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function SubnetsTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(subnetsQuery());
  const all = (data.data ?? []) as Subnet[];

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, page: 1 }) as never });

  const onSort = (field: string) =>
    navigate({
      search: (prev: { sort?: string; order?: "asc" | "desc" }) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "asc" ? "desc" : "asc",
        }) as never,
    });


  const filtered = all.filter((s) => {
    if (!matchesQuery([s.netuid, s.name, s.symbol], search.q)) return false;
    if (search.curation && s.curation_level !== search.curation) return false;
    if (search.health && s.health !== search.health) return false;
    return true;
  });

  const sorted = sortBy(filtered, search.sort, search.order, (row, key) => {
    const r = row as Record<string, unknown>;
    return r[key];
  });
  const rows = paginate(sorted, search.page, search.pageSize);

  return (
    <div>
      <FilterBar>
        <SearchInput
          value={search.q}
          onChange={(v) => setSearch({ q: v })}
          placeholder="Search by netuid, name, or symbol"
        />
        <SelectFilter
          label="curation"
          value={search.curation}
          onChange={(v) => setSearch({ curation: v })}
          options={[
            { value: "native", label: "native" },
            { value: "candidate-discovered", label: "candidate" },
            { value: "machine-verified", label: "machine" },
            { value: "maintainer-reviewed", label: "reviewed" },
            { value: "adapter-backed", label: "adapter" },
          ]}
        />
        <SelectFilter
          label="health"
          value={search.health}
          onChange={(v) => setSearch({ health: v })}
          options={[
            { value: "ok", label: "ok" },
            { value: "warn", label: "warn" },
            { value: "down", label: "down" },
            { value: "unknown", label: "unknown" },
          ]}
        />
      </FilterBar>

      {sorted.length === 0 ? (
        <EmptyState
          title="No matching subnets"
          description="Try clearing filters or broadening the search."
        />
      ) : (
        <div className="rounded border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/50">
                <tr>
                  <th className="px-4 py-2.5">
                    <SortHeader label="UID" field="netuid" active={search.sort === "netuid"} order={search.order} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2.5">
                    <SortHeader label="Name" field="name" active={search.sort === "name"} order={search.order} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2.5">
                    <SortHeader label="Symbol" field="symbol" active={search.sort === "symbol"} order={search.order} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2.5 text-right">
                    <SortHeader label="Participants" field="participants" active={search.sort === "participants"} order={search.order} onSort={onSort} align="right" />
                  </th>
                  <th className="px-4 py-2.5">
                    <SortHeader label="Curation" field="curation_level" active={search.sort === "curation_level"} order={search.order} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2.5 text-right">
                    <SortHeader label="Surfaces" field="surfaces_count" active={search.sort === "surfaces_count"} order={search.order} onSort={onSort} align="right" />
                  </th>
                  <th className="px-4 py-2.5">Health</th>
                  <th className="px-4 py-2.5 text-right">
                    <SortHeader label="Updated" field="updated_at" active={search.sort === "updated_at"} order={search.order} onSort={onSort} align="right" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((s) => (
                  <tr key={s.netuid} className="hover:bg-surface/40">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-ink-muted">
                      <Link to="/subnets/$netuid" params={{ netuid: String(s.netuid) }} className="hover:text-ink-strong">
                        {String(s.netuid).padStart(3, "0")}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Link to="/subnets/$netuid" params={{ netuid: String(s.netuid) }} className="font-medium text-ink-strong hover:underline">
                        {s.name ?? `Subnet ${s.netuid}`}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">{s.symbol ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px]">{formatNumber(s.participants)}</td>
                    <td className="px-4 py-2.5"><CurationChip level={s.curation_level} /></td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px]">{s.surfaces_count ?? "—"}</td>
                    <td className="px-4 py-2.5"><HealthPill state={s.health} /></td>
                    <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">{formatRelative(s.updated_at ?? s.freshness)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={search.page}
            pageSize={search.pageSize}
            total={sorted.length}
            onPage={(p) => navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, page: p }) as never })}
          />
        </div>
      )}
    </div>
  );
}
