import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/metagraphed/client";
import { metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { ExternalLink } from "./external-link";
import { HoverPreview } from "./hover-preview";
import { EmptyState, Skeleton } from "./states";
import { TimeAgo } from "./time-ago";
import { formatRelative } from "@/lib/metagraphed/format";
import type { ApiMeta, EvidenceItem } from "@/lib/metagraphed/types";

interface Props {
  netuid?: number;
  /** Page size sent as ?limit=… on each request. */
  pageSize?: number;
}

type SortMode = "recent" | "source" | "count";
type EvidenceCursor = string | number | null;

function nextEvidenceCursor(meta?: ApiMeta): string | number | undefined {
  const next = meta?.next_cursor ?? meta?.pagination?.next_cursor;
  if (typeof next === "string") {
    const trimmed = next.trim();
    return trimmed ? trimmed : undefined;
  }
  return typeof next === "number" && Number.isFinite(next) ? next : undefined;
}

/**
 * Grouped evidence/source panel.
 *
 * Uses cursor-based pagination (?limit=&cursor=) against /api/v1/evidence and
 * exposes a "Load more" control that walks the next cursor returned in API
 * metadata. The panel also supports a source-type filter and group sort.
 */
export function EvidencePanel({ netuid, pageSize = 50 }: Props) {
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  const query = useInfiniteQuery({
    queryKey: metagraphedQueryKey("evidence", {
      netuid: netuid ?? null,
      pageSize,
    }),
    initialPageParam: null as EvidenceCursor,
    queryFn: async ({ pageParam, signal }) => {
      const params: Record<string, string | number> = { limit: pageSize };
      if (pageParam != null) params.cursor = pageParam;
      if (netuid != null) params.netuid = netuid;
      const res = await apiFetch<unknown>("/api/v1/evidence", { params, signal });
      const raw = res.data as unknown;
      let items: EvidenceItem[] = [];
      if (Array.isArray(raw)) items = raw as EvidenceItem[];
      else if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const candidate = obj.evidence ?? obj.entries ?? obj.items;
        if (Array.isArray(candidate)) items = candidate as EvidenceItem[];
      }
      return { items, meta: res.meta as ApiMeta };
    },
    getNextPageParam: (last) => nextEvidenceCursor(last.meta),
    retry: 0,
    staleTime: 5 * 60_000,
  });

  const allRows = useMemo<EvidenceItem[]>(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  const totalKnown =
    query.data?.pages[0]?.meta?.pagination?.total ?? query.data?.pages[0]?.meta?.total;

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(sourceLabel(r));
    return Array.from(set).sort();
  }, [allRows]);

  if (query.isLoading) return <Skeleton className="h-24 w-full" />;
  if (query.error) {
    return (
      <EmptyState
        title="No evidence index available"
        description="The evidence endpoint did not respond. Source links may appear on individual resources instead."
      />
    );
  }
  if (allRows.length === 0) return <EmptyState title="No evidence recorded" />;

  const filtered = sourceFilter ? allRows.filter((r) => sourceLabel(r) === sourceFilter) : allRows;

  // Group by source label, with items sorted by recency inside each group.
  const groups = new Map<string, EvidenceItem[]>();
  for (const r of filtered) {
    const key = sourceLabel(r);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  for (const [, items] of groups) {
    items.sort((a, b) => recordedTime(b) - recordedTime(a));
  }

  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    if (sortMode === "count") return b[1].length - a[1].length;
    if (sortMode === "source") return a[0].localeCompare(b[0]);
    return recordedTime(b[1][0]) - recordedTime(a[1][0]);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono uppercase tracking-widest text-ink-muted">Source</span>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded border border-border bg-card px-2 py-1 text-ink"
          aria-label="Filter evidence by source"
        >
          <option value="">all</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="ml-2 font-mono uppercase tracking-widest text-ink-muted">Sort</span>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="rounded border border-border bg-card px-2 py-1 text-ink"
          aria-label="Sort evidence groups"
        >
          <option value="recent">most recent</option>
          <option value="count">most evidence</option>
          <option value="source">source name</option>
        </select>
        <span className="ml-auto font-mono text-ink-muted">
          {filtered.length}
          {totalKnown != null ? ` of ${totalKnown}` : ""} item{filtered.length === 1 ? "" : "s"}
          {" · "}
          {sortedGroups.length} source{sortedGroups.length === 1 ? "" : "s"}
        </span>
      </div>

      {sortedGroups.map(([source, items]) => (
        <div key={source} className="rounded border border-border bg-card p-3">
          <div className="flex items-center justify-between mb-2 gap-3">
            <span className="mg-label">{source}</span>
            <span className="flex items-center gap-2 font-mono text-[10px] text-ink-muted">
              <span>
                latest <TimeAgo at={items[0]?.recorded_at} />
              </span>
              <span>·</span>
              <span>
                {items.length} item{items.length === 1 ? "" : "s"}
              </span>
            </span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {items.slice(0, 24).map((item) => (
              <li key={item.id}>
                <HoverPreview
                  content={
                    <div className="space-y-1.5">
                      <div className="mg-label">
                        {sourceLabel(item)}
                        {item.netuid != null ? <> · SN{item.netuid}</> : null}
                      </div>
                      {item.note ? (
                        <div className="text-[12px] text-ink-strong">{item.note}</div>
                      ) : null}
                      {item.url ? (
                        <div className="font-mono text-[10px] text-ink break-all">{item.url}</div>
                      ) : null}
                      <div className="font-mono text-[10px] text-ink-muted">
                        recorded <TimeAgo at={item.recorded_at} />
                      </div>
                    </div>
                  }
                >
                  {item.url ? (
                    <ExternalLink href={item.url} className="text-[11px]">
                      {shortLabel(item)}
                    </ExternalLink>
                  ) : (
                    <span className="inline-flex items-center rounded border border-border bg-paper px-1.5 py-0.5 text-[11px] text-ink-muted">
                      {shortLabel(item)}
                    </span>
                  )}
                </HoverPreview>
              </li>
            ))}
            {items.length > 24 ? (
              <li className="text-[11px] text-ink-muted self-center">+{items.length - 24} more</li>
            ) : null}
          </ul>
        </div>
      ))}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="font-mono text-[10px] text-ink-muted">
          loaded {allRows.length}
          {totalKnown != null ? ` of ${totalKnown}` : ""}
        </span>
        {query.hasNextPage ? (
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors disabled:opacity-60"
          >
            {query.isFetchingNextPage ? "Loading…" : `Load ${pageSize} more`}
          </button>
        ) : (
          <span className="font-mono text-[10px] text-ink-muted">end of evidence</span>
        )}
      </div>
    </div>
  );
}

function sourceLabel(item: EvidenceItem): string {
  const source = (item as { source?: unknown }).source;
  return typeof source === "string" && source.length > 0 ? source : "unknown";
}

function recordedTime(item?: EvidenceItem): number {
  if (!item?.recorded_at) return 0;
  const t = Date.parse(item.recorded_at);
  return Number.isFinite(t) ? t : 0;
}

function shortLabel(item: EvidenceItem): string {
  if (item.note && item.note.length < 32) return item.note;
  if (item.url) {
    try {
      const u = new URL(item.url);
      return (
        u.hostname.replace(/^www\./, "") +
        (u.pathname && u.pathname !== "/" ? u.pathname.slice(0, 24) : "")
      );
    } catch {
      return item.url.slice(0, 32);
    }
  }
  return item.id;
}
