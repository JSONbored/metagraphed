import { useQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { evidenceQuery } from "@/lib/metagraphed/queries";
import { ExternalLink } from "./external-link";
import { HoverPreview } from "./hover-preview";
import { EmptyState, Skeleton } from "./states";
import { QueryErrorBoundary } from "./error-boundary";
import { formatRelative } from "@/lib/metagraphed/format";
import type { EvidenceItem } from "@/lib/metagraphed/types";

interface Props {
  netuid?: number;
  limit?: number;
}

/**
 * Grouped evidence/source panel. Groups by `source` and renders hover previews
 * for each item (note + recorded_at + URL).
 */
export function EvidencePanel({ netuid, limit = 200 }: Props) {
  return (
    <QueryErrorBoundary>
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <EvidenceInner netuid={netuid} limit={limit} />
      </Suspense>
    </QueryErrorBoundary>
  );
}

function EvidenceInner({ netuid, limit }: Props) {
  const params: Record<string, string | number> = { limit: limit ?? 200 };
  if (netuid != null) params.netuid = netuid;
  const opts = evidenceQuery(params);
  // Use useQuery (not suspense) so an empty/missing endpoint degrades gracefully.
  const { data, isLoading, error } = useQuery({
    ...opts,
    retry: 0,
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (error) {
    return (
      <EmptyState
        title="No evidence index available"
        description="The evidence endpoint did not respond. Source links may appear on individual resources instead."
      />
    );
  }

  const rows = (data?.data ?? []) as EvidenceItem[];
  if (rows.length === 0) return <EmptyState title="No evidence recorded" />;

  // Group by source label.
  const groups = new Map<string, EvidenceItem[]>();
  for (const r of rows) {
    const key = r.source ?? "unknown";
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="space-y-3">
      {sortedGroups.map(([source, items]) => (
        <div key={source} className="rounded border border-border bg-card p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {source}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">{items.length} item{items.length === 1 ? "" : "s"}</span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {items.slice(0, 24).map((item) => (
              <li key={item.id}>
                <HoverPreview
                  content={
                    <div className="space-y-1.5">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                        {item.source ?? "source"}
                        {item.netuid != null ? <> · SN{item.netuid}</> : null}
                      </div>
                      {item.note ? <div className="text-[12px] text-ink-strong">{item.note}</div> : null}
                      {item.url ? (
                        <div className="font-mono text-[10px] text-ink break-all">{item.url}</div>
                      ) : null}
                      <div className="font-mono text-[10px] text-ink-muted">
                        recorded {formatRelative(item.recorded_at)}
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
    </div>
  );
}

function shortLabel(item: EvidenceItem): string {
  if (item.note && item.note.length < 32) return item.note;
  if (item.url) {
    try {
      const u = new URL(item.url);
      return u.hostname.replace(/^www\./, "") + (u.pathname && u.pathname !== "/" ? u.pathname.slice(0, 24) : "");
    } catch {
      return item.url.slice(0, 32);
    }
  }
  return item.id;
}
