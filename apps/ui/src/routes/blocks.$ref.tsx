import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Boxes, FileText, Zap } from "lucide-react";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, ErrorState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import {
  CopyableCode,
  CopyButton,
  TimeAgo,
  PageHero,
  ShareButton,
  ActionBar,
  SectionAnchor,
  StatTile,
} from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  blockChainEventsQuery,
  blockEventsQuery,
  blockExtrinsicsQuery,
  blockQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { blockRefPathSegment, isValidBlockRef, shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { formatChainEventArgs } from "@/lib/metagraphed/chain-event-args";
import { eventKindLabel } from "@/lib/metagraphed/event-kinds";

export const Route = createFileRoute("/blocks/$ref")({
  // #3422: validate the ref at the router level so an invalid one renders the
  // real not-found boundary (notFoundComponent) instead of an in-page early
  // return. parseParams runs before the loader, so downstream code only ever
  // sees a well-formed ref.
  parseParams: ({ ref }) => {
    if (!isValidBlockRef(ref)) throw notFound();
    return { ref };
  },
  // Prime the shared cache so head() can title the page with the real block
  // number. Non-fatal: any failure falls back to the ref-only copy and the
  // page's own useSuspenseQuery still drives the not-found/empty path.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(blockQuery(params.ref));
      return { blockNumber: data?.block_number ?? null };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    const label = loaderData?.blockNumber != null ? `#${loaderData.blockNumber}` : params.ref;
    const title = `Block ${label} — Metagraphed`;
    const description = `Bittensor block ${label}: hash, parent, author, extrinsic and event counts, indexed from the chain on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Block not found"
        description="Block references must be a decimal block number or a 0x-prefixed hex hash."
      />
      <EmptyState
        title="Invalid block reference"
        description="Use a decimal block number or a 0x-prefixed hexadecimal block hash."
        action={{ label: "Back to blocks", href: "/blocks" }}
      />
    </AppShell>
  ),
  component: BlockDetailPage,
});

function BlockDetailPage() {
  const { ref } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <BlockDetail refValue={ref} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function BlockDetail({ refValue }: { refValue: string }) {
  // The router's parseParams rejects malformed refs before this renders, so the
  // detail component only ever runs with a well-formed ref.
  return <ValidBlockDetail refValue={refValue} />;
}

function ValidBlockDetail({ refValue }: { refValue: string }) {
  const navigate = useNavigate();
  const sourceRef = blockRefPathSegment(refValue);
  const block = useSuspenseQuery(blockQuery(refValue)).data.data;
  const extrinsicsQuery = useQuery(blockExtrinsicsQuery(refValue, { limit: 100 }));
  const eventsQuery = useQuery(blockEventsQuery(refValue, { limit: 100 }));
  const chainEventsQuery = useQuery(blockChainEventsQuery(refValue));

  const prevBlockNumber = block?.prev_block_number ?? null;
  const nextBlockNumber = block?.next_block_number ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (inField) return;

      if (e.key === "ArrowLeft" && prevBlockNumber != null) {
        e.preventDefault();
        navigate({ to: "/blocks/$ref", params: { ref: String(prevBlockNumber) } });
        return;
      }
      if (e.key === "ArrowRight" && nextBlockNumber != null) {
        e.preventDefault();
        navigate({ to: "/blocks/$ref", params: { ref: String(nextBlockNumber) } });
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, prevBlockNumber, nextBlockNumber]);

  const extrinsics = extrinsicsQuery.data?.data.extrinsics ?? [];
  const events = eventsQuery.data?.data.events ?? [];
  const chainEvents = chainEventsQuery.data?.data.events ?? [];

  if (!block) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title={`Block ${refValue}`}
          description="This block isn't indexed yet."
        />
        <EmptyState
          title="Block not found or not yet indexed"
          description="The chain poller indexes recent blocks every few minutes. Cold or out-of-range blocks aren't available."
          action={{ label: "Back to blocks", href: "/blocks" }}
        />
        <ApiSourceFooter
          paths={[`/api/v1/blocks/${sourceRef}`]}
          artifacts={[`/metagraph/blocks/${sourceRef}.json`]}
        />
      </>
    );
  }

  return (
    <>
      <PageHero
        eyebrow="Explorer · block"
        live
        title={`#${formatNumber(block.block_number)}`}
        description={
          block.block_hash ? (
            <CopyableCode value={block.block_hash} className="max-w-full" />
          ) : (
            <span className="text-ink-muted">—</span>
          )
        }
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
        caption="explorer / v1"
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
        <StatTile
          icon={FileText}
          eyebrow="Extrinsics"
          value={formatNumber(block.extrinsic_count ?? 0)}
        />
        <StatTile icon={Zap} eyebrow="Events" value={formatNumber(block.event_count ?? 0)} />
        <StatTile
          icon={Boxes}
          eyebrow="Observed"
          value={<TimeAgo at={block.observed_at} />}
          tone="accent"
        />
      </div>

      <SectionAnchor id="chain" title="Chain walk" tone="accent">
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {block.prev_block_number == null ? (
            <span className="inline-flex cursor-not-allowed items-center gap-1 rounded border border-dashed border-ink-subtle bg-surface/30 px-2.5 py-1 text-[11px] text-ink-muted">
              <ChevronLeft className="size-3" /> Previous block
            </span>
          ) : (
            <Link
              to="/blocks/$ref"
              params={{ ref: String(block.prev_block_number) }}
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 text-[11px] hover:text-ink-strong"
            >
              <ChevronLeft className="size-3" />
              Previous block #{formatNumber(block.prev_block_number)}
            </Link>
          )}

          {block.next_block_number == null ? (
            <span className="inline-flex cursor-not-allowed items-center gap-1 rounded border border-dashed border-ink-subtle bg-surface/30 px-2.5 py-1 text-[11px] text-ink-muted">
              Next block <ChevronRight className="size-3" />
            </span>
          ) : (
            <Link
              to="/blocks/$ref"
              params={{ ref: String(block.next_block_number) }}
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 text-[11px] hover:text-ink-strong"
            >
              Next block #{formatNumber(block.next_block_number)}
              <ChevronRight className="size-3" />
            </Link>
          )}
        </div>
      </SectionAnchor>

      <SectionAnchor id="details" title="Block details" tone="accent">
        <dl className="rounded border border-border bg-card divide-y divide-border">
          <FieldRow label="Block number">
            <span className="font-mono text-sm text-ink-strong tabular-nums">
              {formatNumber(block.block_number)}
            </span>
          </FieldRow>
          <FieldRow label="Block hash">
            {block.block_hash ? (
              // Truncate to match "Parent hash" below (#5343) — the raw untruncated
              // CopyableCode overflowed the details row on mobile. It's the current
              // block, so no self-link; the full hash stays available on hover.
              <span
                className="font-mono text-[12px] text-ink-strong break-all"
                title={block.block_hash}
              >
                {shortHash(block.block_hash, 10)}
              </span>
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Parent hash">
            {block.parent_hash ? (
              <Link
                to="/blocks/$ref"
                params={{ ref: block.parent_hash }}
                className="font-mono text-[12px] text-ink-strong hover:underline break-all"
                title={block.parent_hash}
              >
                {shortHash(block.parent_hash, 10)}
              </Link>
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Author">
            {block.author ? (
              <CopyableCode value={block.author} truncate={false} className="max-w-full" />
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Extrinsics">
            <span className="font-mono text-sm text-ink tabular-nums">
              {formatNumber(block.extrinsic_count ?? 0)}
            </span>
          </FieldRow>
          <FieldRow label="Events">
            <span className="font-mono text-sm text-ink tabular-nums">
              {formatNumber(block.event_count ?? 0)}
            </span>
          </FieldRow>
          <FieldRow label="Observed at">
            <span className="font-mono text-[12px] text-ink-muted">
              <TimeAgo at={block.observed_at} />
              {block.observed_at ? (
                <span className="ml-2 opacity-70">{block.observed_at}</span>
              ) : null}
            </span>
          </FieldRow>
        </dl>
      </SectionAnchor>

      <SectionAnchor id="extrinsics" title="Extrinsics" tone="accent">
        {extrinsicsQuery.isPending ? (
          <Skeleton className="h-44" />
        ) : extrinsicsQuery.error ? (
          <div className="p-4">
            <ErrorState
              error={extrinsicsQuery.error}
              context="block extrinsics"
              onRetry={() => {
                void extrinsicsQuery.refetch();
              }}
            />
          </div>
        ) : extrinsics.length === 0 ? (
          <EmptyState
            title="No block extrinsics"
            description="This block has no indexed extrinsics (or the poller window for this shard is still catching up)."
          />
        ) : (
          <div className="overflow-x-auto rounded border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/40">
                <tr>
                  <th className="px-4 py-2.5 text-right">Index</th>
                  <th className="px-4 py-2.5">Extrinsic</th>
                  <th className="px-4 py-2.5">Call</th>
                  <th className="px-4 py-2.5">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {extrinsics.map((extrinsic) => {
                  const result =
                    extrinsic.success == null ? "—" : extrinsic.success ? "Success" : "Failed";
                  const resultClass =
                    extrinsic.success == null
                      ? "text-ink-muted"
                      : extrinsic.success
                        ? "text-emerald-500"
                        : "text-health-down";

                  return (
                    <tr
                      key={
                        extrinsic.extrinsic_hash ||
                        `${extrinsic.block_number}-${extrinsic.extrinsic_index}`
                      }
                      className="hover:bg-surface/40"
                    >
                      <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                        {extrinsic.extrinsic_index != null
                          ? formatNumber(extrinsic.extrinsic_index)
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted break-all">
                        {extrinsic.extrinsic_hash ? (
                          <Link
                            to="/extrinsics/$hash"
                            params={{ hash: extrinsic.extrinsic_hash }}
                            className="font-medium text-ink-strong hover:underline"
                          >
                            {shortHash(extrinsic.extrinsic_hash, 10)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
                        {extrinsicCall(extrinsic.call_module, extrinsic.call_function)}
                      </td>
                      <td className={`px-4 py-2.5 font-mono text-[11px] ${resultClass}`}>
                        {result}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionAnchor>

      <SectionAnchor id="events" title="Events" tone="accent">
        {eventsQuery.isPending ? (
          <Skeleton className="h-44" />
        ) : eventsQuery.error ? (
          <div className="p-4">
            <ErrorState
              error={eventsQuery.error}
              context="block events"
              onRetry={() => {
                void eventsQuery.refetch();
              }}
            />
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            title="No block events"
            description="This block has no decoded on-chain events indexed yet."
          />
        ) : (
          <div className="overflow-x-auto rounded border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/40">
                <tr>
                  <th className="px-4 py-2.5">Kind</th>
                  <th className="px-4 py-2.5">Hotkey</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((event) => {
                  const amount =
                    event.amount_tao != null ? `${formatNumber(event.amount_tao)} τ` : "—";
                  return (
                    <tr
                      key={`${event.block_number}-${event.event_index}-${event.event_kind ?? "unknown"}`}
                      className="hover:bg-surface/40"
                    >
                      <td
                        className="px-4 py-2.5 font-mono text-[11px] text-ink-strong"
                        title={event.event_kind ?? undefined}
                      >
                        {eventKindLabel(event.event_kind)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink">
                        <AccountAddress
                          ss58={event.hotkey}
                          keep={10}
                          copyButtonClassName="-my-3.5"
                          fallback="—"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
                        {amount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionAnchor>

      <SectionAnchor
        id="chain-events"
        title="Chain events"
        subtitle="Every raw pallet-level event in this block, decoded from the chain — broader than the curated events above, but without account/amount attribution."
        tone="accent"
      >
        {chainEventsQuery.isPending ? (
          <Skeleton className="h-44" />
        ) : chainEventsQuery.error ? (
          <div className="p-4">
            <ErrorState
              error={chainEventsQuery.error}
              context="block chain events"
              onRetry={() => {
                void chainEventsQuery.refetch();
              }}
            />
          </div>
        ) : chainEvents.length === 0 ? (
          <EmptyState
            title="No chain events"
            description="This block has no decoded pallet events indexed yet, or the all-events backfill hasn't reached it."
          />
        ) : (
          <div className="overflow-x-auto rounded border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/40">
                <tr>
                  <th className="px-4 py-2.5">Pallet.method</th>
                  <th className="px-4 py-2.5">Phase</th>
                  <th className="px-4 py-2.5 text-right">Extrinsic</th>
                  <th className="px-4 py-2.5">Args</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {chainEvents.map((event) => (
                  <tr
                    key={`${event.block_number}-${event.event_index}`}
                    className="hover:bg-surface/40"
                  >
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
                      {extrinsicCall(event.pallet, event.method)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                      {event.phase ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
                      {event.extrinsic_index != null ? formatNumber(event.extrinsic_index) : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                      <div className="flex max-w-xs items-center gap-1.5">
                        <span className="truncate" title={formatChainEventArgs(event.args)}>
                          {formatChainEventArgs(event.args)}
                        </span>
                        <CopyButton value={formatChainEventArgs(event.args)} label="args" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionAnchor>

      <div className="mt-6">
        <Link
          to="/blocks"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
        >
          ← All blocks
        </Link>
      </div>

      <SectionAnchor
        id="call"
        title="Call this endpoint"
        subtitle="Copy a ready-to-run request for this block."
      >
        <EndpointSnippet
          rows={[
            { label: "block", path: `/api/v1/blocks/${sourceRef}` },
            { label: "extrinsics", path: `/api/v1/blocks/${sourceRef}/extrinsics` },
            { label: "events", path: `/api/v1/blocks/${sourceRef}/events` },
            {
              label: "chain events",
              path: `/api/v1/blocks/${sourceRef}/chain-events`,
            },
            { label: "artifact", path: `/metagraph/blocks/${sourceRef}.json` },
          ]}
        />
      </SectionAnchor>

      <ApiSourceFooter
        paths={[
          `/api/v1/blocks/${sourceRef}`,
          `/api/v1/blocks/${sourceRef}/extrinsics`,
          `/api/v1/blocks/${sourceRef}/events`,
          `/api/v1/blocks/${sourceRef}/chain-events`,
        ]}
        artifacts={[`/metagraph/blocks/${sourceRef}.json`]}
      />
    </>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted sm:w-40 sm:shrink-0">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <>
      <Skeleton className="h-28 w-full mb-8" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-72 w-full" />
    </>
  );
}
