import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { FileText, Zap, CheckCircle2, ChevronDown, ChevronRight, DollarSign } from "lucide-react";

import { ChainWalkRibbon } from "@/components/metagraphed/blocks/chain-walk-ribbon";
import { NeighborCompare } from "@/components/metagraphed/blocks/neighbor-compare";
import { BlockMetadataPanel } from "@/components/metagraphed/blocks/block-metadata-panel";
import { PalletMethodBreakdown } from "@/components/metagraphed/blocks/pallet-method-breakdown";
import { ShortcutsDialog } from "@/components/metagraphed/blocks/shortcuts-dialog";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import {
  CopyableCode,
  CopyButton,
  Kbd,
  TimeAgo,
  ShareButton,
  ActionBar,
  SectionAnchor,
  StatTile,
  TableState,
  DownloadCsvButton,
  InfoTooltip,
  BackToTop,
} from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  blockChainEventsQuery,
  blockEventsQuery,
  blockExtrinsicsQuery,
  blockQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import { blockRefPathSegment, isValidBlockRef, shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { formatChainEventArgs } from "@/lib/metagraphed/chain-event-args";
import { eventKindLabel } from "@/lib/metagraphed/event-kinds";
import { BLOCK_SECTION_HINTS, BLOCK_TERM_HINTS } from "@/lib/metagraphed/section-hints";
import { TaoValue } from "@/components/metagraphed/tao-value";
import { ValueUnitProvider, useValueUnit, type ValueUnit } from "@/lib/metagraphed/value-unit";
import { nextTabIndex } from "@/hooks/use-roving-tablist";

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
      <ValueUnitProvider>
        <QueryErrorBoundary>
          <Suspense fallback={<DetailSkeleton />}>
            <BlockDetail refValue={ref} />
          </Suspense>
        </QueryErrorBoundary>
      </ValueUnitProvider>
      <BackToTop />
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
  const blockResult = useSuspenseQuery(blockQuery(refValue)).data;
  const block = blockResult.data;
  const generatedAt = blockResult.meta?.generated_at ?? null;
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

      // ArrowLeft / J → previous block; ArrowRight / K → next block.
      // Matches the vim-style bindings used across the explorer feeds.
      if ((e.key === "ArrowLeft" || e.key === "j" || e.key === "J") && prevBlockNumber != null) {
        e.preventDefault();
        navigate({ to: "/blocks/$ref", params: { ref: String(prevBlockNumber) } });
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "k" || e.key === "K") && nextBlockNumber != null) {
        e.preventDefault();
        navigate({ to: "/blocks/$ref", params: { ref: String(nextBlockNumber) } });
        return;
      }
      // G → jump to blocks feed (head).
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        navigate({ to: "/blocks" });
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
      <ShortcutsDialog blockRef={refValue} />
      <PageMasthead
        crumbs={[
          { to: "/", label: "Home" },
          { to: "/blocks", label: "Blocks" },
          { to: `/blocks/${refValue}`, label: `#${formatNumber(block.block_number)}` },
        ]}
        hideBreadcrumbs={false}
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
          <>
            <ActionBar>
              <ValueUnitControl />
              <div className="hidden sm:flex">
                <JumpToBlock />
              </div>
              <ShareButton bare />
            </ActionBar>
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[blockQuery(refValue).queryKey]}
              />
            ) : null}
          </>
        }
        caption="explorer / v1"
      />

      <div className="space-y-10">
        {(() => {
          const withResult = extrinsics.filter((e) => e.success != null);
          const successful = withResult.filter((e) => e.success).length;
          const successRate = withResult.length > 0 ? (successful / withResult.length) * 100 : null;
          const rateTone: "accent" | "warn" | "down" | "default" =
            successRate == null
              ? "default"
              : successRate >= 99
                ? "accent"
                : successRate >= 90
                  ? "warn"
                  : "down";
          // Sum of τ moved by economically-relevant events in this block.
          // Only events that expose an `amount_tao` contribute — this is a
          // signal, not a settlement total.
          const valueMoved = events.reduce(
            (sum, ev) => sum + (typeof ev.amount_tao === "number" ? ev.amount_tao : 0),
            0,
          );
          const valueMovedNode = eventsQuery.isPending ? (
            <span className="text-ink-muted">…</span>
          ) : valueMoved > 0 ? (
            <TaoValue amount={valueMoved} layout="stacked" precision={2} align="left" size="md" />
          ) : (
            "—"
          );
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile
                icon={FileText}
                eyebrow="Extrinsics"
                value={formatNumber(block.extrinsic_count ?? 0)}
                tooltip={BLOCK_TERM_HINTS.extrinsic}
              />
              <StatTile
                icon={Zap}
                eyebrow="Events"
                value={formatNumber(block.event_count ?? 0)}
                tooltip={BLOCK_TERM_HINTS.event}
              />
              <StatTile
                icon={CheckCircle2}
                eyebrow="Success"
                value={
                  successRate == null ? "—" : `${successRate.toFixed(successRate === 100 ? 0 : 1)}%`
                }
                tone={rateTone}
                tooltip={BLOCK_TERM_HINTS.successRate}
              />
              <StatTile
                icon={DollarSign}
                eyebrow="Value moved"
                value={valueMovedNode}
                tone={valueMoved > 0 ? "accent" : "default"}
                tooltip={BLOCK_TERM_HINTS.valueMoved}
              />
            </div>
          );
        })()}

        <div className="flex items-center justify-end -mb-6">
          <span className="mg-label inline-flex items-center gap-1.5">
            Observed <TimeAgo at={block.observed_at} />
          </span>
        </div>

        <SectionAnchor id="chain" title="Chain walk" info={BLOCK_SECTION_HINTS.chain}>
          <div className="space-y-3">
            <ChainWalkRibbon current={block} radius={3} />
            <NeighborCompare current={block} />
          </div>
        </SectionAnchor>

        <SectionAnchor id="details" title="Block details" info={BLOCK_SECTION_HINTS.details}>
          <dl className="rounded border border-border bg-card divide-y divide-border">
            <FieldRow label="Block number">
              <span className="font-mono text-sm text-ink-strong tabular-nums">
                {formatNumber(block.block_number)}
              </span>
            </FieldRow>
            <FieldRow label="Block hash" hint={BLOCK_TERM_HINTS.blockHash}>
              {block.block_hash ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="font-mono text-[12px] text-ink-strong break-all md:hidden"
                    title={block.block_hash}
                  >
                    {shortHash(block.block_hash, 10)}
                  </span>
                  <span className="hidden md:inline font-mono text-[12px] text-ink-strong break-all">
                    {block.block_hash}
                  </span>
                  <CopyButton value={block.block_hash} label="block hash" compact />
                </div>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </FieldRow>
            <FieldRow label="Parent hash" hint={BLOCK_TERM_HINTS.parentHash}>
              {block.parent_hash ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: block.parent_hash }}
                    className="font-mono text-[12px] text-ink-strong hover:underline break-all md:hidden"
                    title={block.parent_hash}
                  >
                    {shortHash(block.parent_hash, 10)}
                  </Link>
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: block.parent_hash }}
                    className="hidden md:inline font-mono text-[12px] text-ink-strong hover:underline break-all"
                  >
                    {block.parent_hash}
                  </Link>
                  <CopyButton value={block.parent_hash} label="parent hash" compact />
                </div>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </FieldRow>
            <FieldRow label="Author" hint={BLOCK_TERM_HINTS.author}>
              {/* #6424: full ss58 on desktop for readability; on mobile use the
                  shortened form so it fits without wrapping ugly on 393px. */}
              <div className="min-w-0">
                <div className="md:hidden">
                  <AccountAddress
                    ss58={block.author}
                    keep={8}
                    compact
                    fallback={<span className="text-ink-muted">—</span>}
                  />
                </div>
                <div className="hidden md:block">
                  <AccountAddress
                    ss58={block.author}
                    truncate={false}
                    fallback={<span className="text-ink-muted">—</span>}
                  />
                </div>
              </div>
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
              </span>
            </FieldRow>
          </dl>
        </SectionAnchor>

        <SectionAnchor
          id="metadata"
          title="Block metadata"
          info="Extended header fields (runtime version, storage roots) returned by the block API."
        >
          <BlockMetadataPanel block={block} />
        </SectionAnchor>

        <SectionAnchor
          id="extrinsics"
          title="Extrinsics"
          info={BLOCK_SECTION_HINTS.extrinsics}
          right={<DownloadCsvButton url={buildUrl(`/api/v1/blocks/${sourceRef}/extrinsics`)} />}
        >
          {extrinsicsQuery.isPending ? (
            <Skeleton className="h-44" />
          ) : extrinsicsQuery.error ? (
            <TableState
              variant="error"
              title="Couldn't load block extrinsics"
              description="This section is optional — the rest of the block detail is unaffected."
              error={extrinsicsQuery.error}
              onRetry={() => {
                void extrinsicsQuery.refetch();
              }}
            />
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
                    // This table spells the result out ("Success"/"Failed")
                    // rather than the feeds' "ok"/"fail", so it keeps its own
                    // rendering instead of the shared SuccessBadge -- swapping it
                    // in would silently reword the page. What it borrows is the
                    // token pair: the fail branch already used --health-down
                    // while success stayed on raw emerald, so the two halves of
                    // one ternary disagreed (#6403).
                    const resultClass =
                      extrinsic.success == null
                        ? "text-ink-muted"
                        : extrinsic.success
                          ? "text-health-ok"
                          : "text-health-down";

                    return (
                      <tr
                        key={
                          extrinsic.extrinsic_hash ||
                          `${extrinsic.block_number}-${extrinsic.extrinsic_index}`
                        }
                        className="mg-row-accent hover:bg-surface/40"
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

        <SectionAnchor
          id="events"
          title="Events"
          info={BLOCK_SECTION_HINTS.events}
          subtitle="Grouped by parent extrinsic. System events (fees, deposits, ExtrinsicSuccess) are collapsed by default."
          right={<DownloadCsvButton url={buildUrl(`/api/v1/blocks/${sourceRef}/events`)} />}
        >
          {eventsQuery.isPending ? (
            <Skeleton className="h-44" />
          ) : eventsQuery.error ? (
            <TableState
              variant="error"
              title="Couldn't load block events"
              description="This section is optional — the rest of the block detail is unaffected."
              error={eventsQuery.error}
              onRetry={() => {
                void eventsQuery.refetch();
              }}
            />
          ) : events.length === 0 ? (
            <EmptyState
              title="No block events"
              description="This block has no decoded on-chain events indexed yet."
            />
          ) : (
            <GroupedEvents events={events} extrinsics={extrinsics} />
          )}
        </SectionAnchor>

        {chainEvents.length > 0 ? (
          <SectionAnchor
            id="pallets"
            title="Pallet · method breakdown"
            info="Ranked runtime pallet.method calls emitted by this block."
          >
            <PalletMethodBreakdown events={chainEvents} />
          </SectionAnchor>
        ) : null}

        <SectionAnchor
          id="chain-events"
          title="Chain events (raw)"
          info={BLOCK_SECTION_HINTS.chainEventsRaw}
          subtitle="Curated events above are grouped by extrinsic; this table is the raw per-event stream — every pallet-level event in the block, decoded from the chain."
        >
          <details className="group rounded border border-border bg-card">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-[11px] font-medium text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>
                {chainEventsQuery.isPending
                  ? "Loading raw events…"
                  : `${formatNumber(chainEvents.length)} raw pallet events`}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider">
                <span className="group-open:hidden">Show</span>
                <span className="hidden group-open:inline">Hide</span>
              </span>
            </summary>
            <div className="border-t border-border p-2">
              {chainEventsQuery.isPending ? (
                <Skeleton className="h-44" />
              ) : chainEventsQuery.error ? (
                <TableState
                  variant="error"
                  title="Couldn't load block chain events"
                  description="This section is optional — the rest of the block detail is unaffected."
                  error={chainEventsQuery.error}
                  onRetry={() => {
                    void chainEventsQuery.refetch();
                  }}
                />
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
                          className="mg-row-accent hover:bg-surface/40"
                        >
                          <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
                            {extrinsicCall(event.pallet, event.method)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                            {event.phase ?? "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
                            {event.extrinsic_index != null
                              ? formatNumber(event.extrinsic_index)
                              : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                            <div className="flex max-w-xs items-center gap-1.5">
                              <span className="truncate" title={formatChainEventArgs(event.args)}>
                                {formatChainEventArgs(event.args)}
                              </span>
                              <CopyButton
                                value={formatChainEventArgs(event.args)}
                                label="args"
                                compact
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        </SectionAnchor>

        <SectionAnchor
          id="call"
          title="Call this endpoint"
          info={BLOCK_SECTION_HINTS.call}
          subtitle="Copy a ready-to-run request for this block."
        >
          <details className="group rounded border border-border bg-card">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-[11px] font-medium text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>API &amp; artifact URLs</span>
              <span className="font-mono text-[10px] uppercase tracking-wider">
                <span className="group-open:hidden">Show</span>
                <span className="hidden group-open:inline">Hide</span>
              </span>
            </summary>
            <div className="border-t border-border p-3">
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
            </div>
          </details>
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
      </div>
    </>
  );
}

type EventItem = {
  block_number?: number | null;
  event_index?: number | null;
  event_kind?: string | null;
  hotkey?: string | null;
  amount_tao?: number | null;
  extrinsic_index?: number | null;
};

type ExtrinsicItem = {
  block_number?: number | null;
  extrinsic_index?: number | null;
  extrinsic_hash?: string | null;
  call_module?: string | null;
  call_function?: string | null;
  success?: boolean | null;
};

function GroupedEvents({
  events,
  extrinsics,
}: {
  events: EventItem[];
  extrinsics: ExtrinsicItem[];
}) {
  const groups = useMemo(() => {
    const byIndex = new Map<number | "system", EventItem[]>();
    for (const ev of events) {
      const key: number | "system" = ev.extrinsic_index ?? "system";
      const arr = byIndex.get(key) ?? [];
      arr.push(ev);
      byIndex.set(key, arr);
    }
    const extrinsicByIndex = new Map<number, ExtrinsicItem>();
    for (const x of extrinsics) {
      if (x.extrinsic_index != null) extrinsicByIndex.set(x.extrinsic_index, x);
    }
    const numeric = Array.from(byIndex.entries())
      .filter(([k]) => k !== "system")
      .map(([k, list]) => ({
        key: `x-${k}` as const,
        index: k as number,
        list,
        extrinsic: extrinsicByIndex.get(k as number) ?? null,
        isSystem: false,
        hasHotkey: list.some((e) => e.hotkey),
      }))
      .sort((a, b) => a.index - b.index);
    const system = byIndex.get("system");
    const systemGroup = system
      ? [
          {
            key: "system" as const,
            index: -1,
            list: system,
            extrinsic: null,
            isSystem: true,
            hasHotkey: system.some((e) => e.hotkey),
          },
        ]
      : [];
    return [...numeric, ...systemGroup];
  }, [events, extrinsics]);

  const defaultOpen = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) if (g.hasHotkey && !g.isSystem) s.add(g.key);
    return s;
  }, [groups]);

  const [open, setOpen] = useState<Set<string>>(defaultOpen);
  const allOpen = open.size === groups.length;
  const [focusIdx, setFocusIdx] = useState(0);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onHeaderKey = (i: number, key: string) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const next = nextTabIndex(i, e.key, groups.length);
      if (next == null) return;
      e.preventDefault();
      setFocusIdx(next);
      btnRefs.current[next]?.focus();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setOpen((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  };

  return (
    <div className="rounded border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="mg-label">
          {groups.length} extrinsic{groups.length === 1 ? "" : "s"} · {events.length} event
          {events.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
          className="text-[11px] font-medium text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <ul
        className="divide-y divide-border"
        role="tree"
        aria-label="Extrinsics and events. Use up and down to move, right to expand, left to collapse."
      >
        {groups.map((g, i) => {
          const isOpen = open.has(g.key);
          const showHotkeyCol = g.list.some((e) => e.hotkey);
          const title = g.isSystem
            ? "System events"
            : g.extrinsic
              ? extrinsicCall(g.extrinsic.call_module, g.extrinsic.call_function)
              : "Unknown extrinsic";
          const success = g.extrinsic?.success;
          return (
            <li key={g.key} role="treeitem" aria-expanded={isOpen}>
              <button
                ref={(el) => {
                  btnRefs.current[i] = el;
                }}
                type="button"
                tabIndex={i === focusIdx ? 0 : -1}
                onFocus={() => setFocusIdx(i)}
                onKeyDown={onHeaderKey(i, g.key)}
                onClick={() => {
                  setFocusIdx(i);
                  toggle(g.key);
                }}
                className="flex w-full items-center gap-2 sm:gap-3 px-3 py-2.5 text-left hover:bg-surface/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={isOpen}
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5 shrink-0 text-ink-muted" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-ink-muted" />
                )}
                <span className="font-mono text-[11px] tabular-nums text-ink-muted w-8 sm:w-10 shrink-0">
                  {g.isSystem ? "sys" : `#${g.index}`}
                </span>
                <span className="font-mono text-[11px] text-ink-strong truncate min-w-0 flex-1">
                  {title}
                </span>
                {success != null ? (
                  <span
                    className={`hidden sm:inline font-mono text-[10px] uppercase tracking-wider ${success ? "text-health-ok" : "text-health-down"}`}
                  >
                    {success ? "success" : "failed"}
                  </span>
                ) : null}
                <span className="mg-label shrink-0 hidden sm:inline">
                  {g.list.length} evt{g.list.length === 1 ? "" : "s"}
                </span>
                {g.extrinsic?.extrinsic_hash ? (
                  <Link
                    to="/extrinsics/$hash"
                    params={{ hash: g.extrinsic.extrinsic_hash }}
                    onClick={(e) => e.stopPropagation()}
                    className="hidden sm:inline font-mono text-[10px] text-ink-muted hover:text-ink-strong hover:underline shrink-0"
                    title={g.extrinsic.extrinsic_hash}
                  >
                    {shortHash(g.extrinsic.extrinsic_hash, 6)}
                  </Link>
                ) : null}
              </button>
              {isOpen ? (
                <div className="border-t border-border bg-surface/20 px-3 py-2">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-ink-muted">
                        <th className="px-2 py-1.5 font-normal">Kind</th>
                        {showHotkeyCol ? <th className="px-2 py-1.5 font-normal">Hotkey</th> : null}
                        <th className="px-2 py-1.5 text-right font-normal">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.list.map((event) => (
                        <tr
                          key={`${event.block_number}-${event.event_index}-${event.event_kind ?? "unknown"}`}
                        >
                          <td
                            className="px-2 py-1.5 font-mono text-[11px] text-ink-strong"
                            title={event.event_kind ?? undefined}
                          >
                            {eventKindLabel(event.event_kind)}
                          </td>
                          {showHotkeyCol ? (
                            <td className="px-2 py-1.5 font-mono text-[11px] text-ink">
                              <AccountAddress
                                ss58={event.hotkey}
                                keep={10}
                                compact
                                fallback={<span className="text-ink-muted">—</span>}
                              />
                            </td>
                          ) : null}
                          <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                            {event.amount_tao != null ? (
                              <TaoValue amount={event.amount_tao} layout="stacked" precision={4} />
                            ) : (
                              <span className="font-mono text-[11px] text-ink-muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ValueUnitControl() {
  const { unit, setUnit } = useValueUnit();
  const opts: Array<{ v: ValueUnit; label: string; title: string }> = [
    { v: "tao", label: "τ", title: "Show TAO only" },
    { v: "usd", label: "$", title: "Show USD only" },
    { v: "both", label: "Both", title: "Show TAO and USD" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Value display unit"
      className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
    >
      {opts.map((o) => {
        const active = o.v === unit;
        return (
          <button
            key={o.v}
            type="button"
            role="tab"
            aria-selected={active}
            title={o.title}
            onClick={() => setUnit(o.v)}
            className={
              "inline-flex items-center rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8 " +
              (active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function JumpToBlock() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      role="search"
      aria-label="Jump to block"
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (!v) return;
        if (!isValidBlockRef(v)) {
          setError("Enter a decimal block number or 0x… hash");
          return;
        }
        setError(null);
        navigate({ to: "/blocks/$ref", params: { ref: v } });
        setValue("");
      }}
    >
      <label className="sr-only" htmlFor="jump-to-block">
        Jump to block
      </label>
      <input
        id="jump-to-block"
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        placeholder="Jump to # or 0x…"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "jump-to-block-err" : undefined}
        className="mg-focus-ring h-8 w-40 rounded border border-border bg-paper px-2 font-mono text-[12px] tabular-nums text-ink-strong placeholder:text-ink-subtle sm:w-48"
      />
      <Kbd>↵</Kbd>
      {error ? (
        <span
          id="jump-to-block-err"
          role="alert"
          className="ml-1 font-mono text-[10px] text-health-down"
        >
          {error}
        </span>
      ) : null}
    </form>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted sm:w-40 sm:shrink-0">
        <span>{label}</span>
        {hint ? <InfoTooltip label={hint} /> : null}
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
