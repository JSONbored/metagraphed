import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ListShell } from "@/components/metagraphed/list-shell";
import { PageSizeSelect } from "@/components/metagraphed/table-controls";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ShareButton } from "@/components/metagraphed/share-button";
import { blocksQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { API_BASE } from "@/lib/metagraphed/config";
import type { Block } from "@/lib/metagraphed/types";

const blocksSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
});

export const Route = createFileRoute("/blocks/")({
  validateSearch: zodValidator(blocksSearchSchema),
  head: () => ({
    meta: [
      { title: "Blocks — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor blocks indexed from the chain — block number, hash, author, extrinsic and event counts, newest first.",
      },
      { property: "og:title", content: "Blocks — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor blocks indexed from the chain — block number, hash, author, extrinsic and event counts, newest first.",
      },
    ],
  }),
  component: BlocksPage,
});

function BlocksPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Blocks"
        description="Recent Bittensor blocks indexed directly from the chain — newest first, with author, extrinsic, and event counts."
        actions={<ShareButton />}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <BlocksTable />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/blocks"]} artifacts={["/metagraph/blocks.json"]} />
    </AppShell>
  );
}

function BlocksTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const rows = (useSuspenseQuery(blocksQuery({ limit: search.limit, offset: search.offset })).data
    .data ?? []) as Block[];

  // Offset pagination: the API returns newest-first pages with no total. A full
  // page (rows === limit) implies more may exist; a short page is the tail.
  const hasPrev = search.offset > 0;
  const hasNext = rows.length === search.limit;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never });

  const goPrev = () => setSearch({ offset: Math.max(0, search.offset - search.limit) });
  const goNext = () => setSearch({ offset: search.offset + search.limit });

  const filters = (
    <>
      <span className="font-mono text-[11px] text-ink-muted">Newest first</span>
      <PageSizeSelect
        value={search.limit}
        onChange={(n) => setSearch({ limit: n, offset: 0 })}
        options={[10, 25, 50, 100]}
      />
    </>
  );

  const emptyNode = (
    <EmptyState
      title="No blocks indexed yet"
      description="The chain poller fills this every few minutes — check back shortly, or open the API directly."
      action={{
        label: "Open /api/v1/blocks",
        href: `${API_BASE}/api/v1/blocks`,
        external: true,
      }}
    />
  );

  const footerNode = (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted">
      <span>
        {rows.length
          ? `${formatNumber(search.offset + 1)}–${formatNumber(search.offset + rows.length)}`
          : "0"}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goPrev}
          disabled={!hasPrev}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed min-h-9"
        >
          <ChevronLeft className="size-3" /> Newer
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={!hasNext}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed min-h-9"
        >
          Older <ChevronRight className="size-3" />
        </button>
      </div>
    </div>
  );

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      empty={emptyNode}
      cards={rows.map((b) => (
        <Link
          key={b.block_hash || b.block_number}
          to="/blocks/$ref"
          params={{ ref: String(b.block_number) }}
          className="block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-sm font-medium text-ink-strong">
              #{formatNumber(b.block_number)}
            </div>
            <span className="font-mono text-[11px] text-ink-muted">
              <TimeAgo at={b.observed_at} />
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-ink-muted truncate">
            {shortHash(b.block_hash)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-ink-muted">
            <span>{shortHash(b.author) ?? "no author"}</span>
            <span>{formatNumber(b.extrinsic_count ?? 0)} ext</span>
            <span>{formatNumber(b.event_count ?? 0)} evt</span>
          </div>
        </Link>
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="sticky top-sticky-offset z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
            <tr>
              <th className="px-4 py-2.5">Block</th>
              <th className="px-4 py-2.5">Hash</th>
              <th className="px-4 py-2.5">Author</th>
              <th className="px-4 py-2.5 text-right">Extrinsics</th>
              <th className="px-4 py-2.5 text-right">Events</th>
              <th className="px-4 py-2.5 text-right">Observed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((b) => (
              <tr
                key={b.block_hash || b.block_number}
                className="mg-row-accent hover:bg-surface/40"
              >
                <td className="px-4 py-2.5 font-mono text-[12px]">
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: String(b.block_number) }}
                    className="font-medium text-ink-strong hover:underline"
                  >
                    #{formatNumber(b.block_number)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: b.block_hash || String(b.block_number) }}
                    className="hover:text-ink-strong"
                    title={b.block_hash}
                  >
                    {shortHash(b.block_hash)}
                  </Link>
                </td>
                <td
                  className="px-4 py-2.5 font-mono text-[11px] text-ink-muted"
                  title={b.author ?? undefined}
                >
                  {shortHash(b.author) ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                  {formatNumber(b.extrinsic_count ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                  {formatNumber(b.event_count ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={b.observed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      footer={footerNode}
    />
  );
}
