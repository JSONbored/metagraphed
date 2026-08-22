import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { ChainWalkRibbon } from "@/components/metagraphed/blocks/chain-walk-ribbon";
import { NeighborCompare } from "@/components/metagraphed/blocks/neighbor-compare";
import { BlockMetadataPanel } from "@/components/metagraphed/blocks/block-metadata-panel";
import { PalletMethodBreakdown } from "@/components/metagraphed/blocks/pallet-method-breakdown";
import { ShortcutsDialog } from "@/components/metagraphed/blocks/shortcuts-dialog";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { AppShell } from "@/components/metagraphed/app-shell";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import {
  EmptyState,
  ErrorState,
  PageHeading,
  Skeleton,
  StaleBanner,
} from "@/components/metagraphed/states";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import {
  CopyableCode,
  CopyButton,
  Kbd,
  TimeAgo,
  BackToTop,
  Definition,
  AnalyticsSection,
  FactCell,
  EntityHero,
  FactSentence,
  DataTable,
} from "@jsonbored/ui-kit";
import {
  blockChainEventsQuery,
  blockEventsQuery,
  blockExtrinsicsQuery,
  blockQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";

import { blockRefPathSegment, isValidBlockRef, shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { formatChainEventArgs } from "@/lib/metagraphed/chain-event-args";
import { eventKindLabel } from "@/lib/metagraphed/event-kinds";
import { BLOCK_SECTION_HINTS, BLOCK_TERM_HINTS } from "@/lib/metagraphed/section-hints";
import { TaoValue } from "@/components/metagraphed/tao-value";
import { ValueUnitProvider, ValueUnitControl } from "@/lib/metagraphed/value-unit";
import {
  BlockNeighborNav,
  RelatedEntityChip,
  RelatedEntityChipHash,
  RelatedEntityChipRow,
  relatedEntityChipLinkClass,
  shortSs58Chip,
} from "@/components/metagraphed/related-entity-chips";
import { nextTabIndex } from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";

export function BlockDetailPage() {
  const { ref } = useParams({ from: "/blocks/$ref" });
  return (
    <AppShell>
      <ValueUnitProvider>
        <AsyncPanel
          context="block detail"
          fallback={<DetailSkeleton />}
          retryQueryKeys={[blockQuery(ref).queryKey]}
        >
          <BlockDetail refValue={ref} />
        </AsyncPanel>
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
  const location = useLocation();
  const sourceRef = blockRefPathSegment(refValue);
  const blockResult = useSuspenseQuery(blockQuery(refValue)).data;
  const block = blockResult.data;
  const generatedAt = blockResult.meta?.generated_at ?? null;
  const extrinsicsQuery = useQuery(blockExtrinsicsQuery(refValue, { limit: 100 }));
  const eventsQuery = useQuery(blockEventsQuery(refValue, { limit: 100 }));
  const chainEventsQuery = useQuery(blockChainEventsQuery(refValue));

  const prevBlockNumber = block?.prev_block_number ?? null;
  const nextBlockNumber = block?.next_block_number ?? null;
  const sectionHash = location.hash?.replace(/^#/, "") || undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (inField) return;

      // ArrowLeft / J → previous block; ArrowRight / K → next block.
      // Matches the vim-style bindings used across the explorer feeds.
      // Preserve the current section hash so tab/section context survives (#8373).
      if ((e.key === "ArrowLeft" || e.key === "j" || e.key === "J") && prevBlockNumber != null) {
        e.preventDefault();
        navigate({
          to: "/blocks/$ref",
          params: { ref: String(prevBlockNumber) },
          hash: sectionHash,
        });
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "k" || e.key === "K") && nextBlockNumber != null) {
        e.preventDefault();
        navigate({
          to: "/blocks/$ref",
          params: { ref: String(nextBlockNumber) },
          hash: sectionHash,
        });
        return;
      }
      // G → jump to blocks feed (head).
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        navigate({ to: "/chain/blocks" });
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, prevBlockNumber, nextBlockNumber, sectionHash]);

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
          action={{ label: "Back to blocks", href: "/chain/blocks" }}
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
      <EntityHero
        name={`#${formatNumber(block.block_number)}`}
        action={
          <>
            <div className="mg-actions">
              <BlockNeighborNav prev={prevBlockNumber} next={nextBlockNumber} hash={sectionHash} />
              <ValueUnitControl />
              <div className="hidden sm:flex">
                <JumpToBlock />
              </div>
            </div>
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[blockQuery(refValue).queryKey]}
              />
            ) : null}
          </>
        }
        sentence={
          <FactSentence>
            {block.block_hash ? (
              <CopyableCode value={block.block_hash} className="max-w-full" />
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FactSentence>
        }
      />

      <RelatedEntityChipRow>
        {block.author ? (
          <Link
            to="/accounts/$ss58"
            params={{ ss58: block.author }}
            className={relatedEntityChipLinkClass}
          >
            <RelatedEntityChip label="author" title="Block author">
              {shortSs58Chip(block.author)}
            </RelatedEntityChip>
          </Link>
        ) : null}
        {(block.extrinsic_count ?? 0) > 0 ? (
          <RelatedEntityChipHash
            label="extrinsics"
            title="Jump to extrinsics in this block"
            hash="extrinsics"
          >
            {formatNumber(block.extrinsic_count ?? 0)}
          </RelatedEntityChipHash>
        ) : null}
      </RelatedEntityChipRow>

      <div className="space-y-10">
        {(() => {
          const withResult = extrinsics.filter((e) => e.success != null);
          const successful = withResult.filter((e) => e.success).length;
          const successRate = withResult.length > 0 ? (successful / withResult.length) * 100 : null;
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
              {/* `?? 0` here reported "0 events" for any block whose count is
                  merely unknown -- true for every block newer than the decode
                  sync's head. A count we do not have is not a count of zero,
                  and the Success tile below already renders that distinction
                  correctly. */}
              <FactCell
                label="Extrinsics"
                value={block.extrinsic_count == null ? "—" : formatNumber(block.extrinsic_count)}
                hint={BLOCK_TERM_HINTS.extrinsic}
              />
              <FactCell
                label="Events"
                value={block.event_count == null ? "—" : formatNumber(block.event_count)}
                hint={BLOCK_TERM_HINTS.event}
              />
              <FactCell
                label="Success"
                value={
                  successRate == null ? "—" : `${successRate.toFixed(successRate === 100 ? 0 : 1)}%`
                }
                hint={BLOCK_TERM_HINTS.successRate}
              />
              <FactCell
                label="Value moved"
                value={valueMovedNode}
                hint={BLOCK_TERM_HINTS.valueMoved}
              />
            </div>
          );
        })()}

        <div className="flex items-center justify-end -mb-6">
          <span className="text-10 text-ink-muted inline-flex items-center gap-1.5">
            Observed <TimeAgo at={block.observed_at} />
          </span>
        </div>

        <AnalyticsSection id="chain" name="Chain walk" footnote={BLOCK_SECTION_HINTS.chain}>
          <div className="space-y-3">
            <ChainWalkRibbon current={block} radius={3} />
            <NeighborCompare current={block} />
          </div>
        </AnalyticsSection>

        <AnalyticsSection id="details" name="Block details" footnote={BLOCK_SECTION_HINTS.details}>
          <dl className="rounded border border-border bg-card divide-y divide-border">
            <FieldRow label="Block number">
              <span className="font-mono text-13 text-ink-strong tabular-nums">
                {formatNumber(block.block_number)}
              </span>
            </FieldRow>
            <FieldRow label="Block hash" hint={BLOCK_TERM_HINTS.blockHash}>
              {block.block_hash ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="font-mono text-13 text-ink-strong break-all md:hidden"
                    title={block.block_hash}
                  >
                    {shortHash(block.block_hash, 10)}
                  </span>
                  <span className="hidden md:inline font-mono text-13 text-ink-strong break-all">
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
                    className="font-mono text-13 text-ink-strong hover:underline break-all md:hidden"
                    title={block.parent_hash}
                  >
                    {shortHash(block.parent_hash, 10)}
                  </Link>
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: block.parent_hash }}
                    className="hidden md:inline font-mono text-13 text-ink-strong hover:underline break-all"
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
                  <AddressDisplay
                    ss58={block.author}
                    keep={8}
                    compact
                    fallback={<span className="text-ink-muted">—</span>}
                  />
                </div>
                <div className="hidden md:block">
                  <AddressDisplay
                    ss58={block.author}
                    truncate={false}
                    fallback={<span className="text-ink-muted">—</span>}
                  />
                </div>
              </div>
            </FieldRow>
            <FieldRow label="Extrinsics">
              <span className="font-mono text-13 text-ink tabular-nums">
                {block.extrinsic_count == null ? "—" : formatNumber(block.extrinsic_count)}
              </span>
            </FieldRow>
            <FieldRow label="Events">
              <span className="font-mono text-13 text-ink tabular-nums">
                {block.event_count == null ? "—" : formatNumber(block.event_count)}
              </span>
            </FieldRow>
            <FieldRow label="Observed at">
              <span className="font-mono text-13 text-ink-muted">
                <TimeAgo at={block.observed_at} />
              </span>
            </FieldRow>
          </dl>
        </AnalyticsSection>

        <AnalyticsSection
          id="metadata"
          name="Block metadata"
          footnote="Extended header fields (runtime version, storage roots) returned by the block API."
        >
          <BlockMetadataPanel block={block} />
        </AnalyticsSection>

        <AnalyticsSection
          id="extrinsics"
          name="Extrinsics"
          footnote={BLOCK_SECTION_HINTS.extrinsics}
        >
          <DataTable
            rows={extrinsics}
            rowKey={(row) => row.extrinsic_hash || `${row.block_number}-${row.extrinsic_index}`}
            caption="Extrinsics"
            captionHidden
            link={RouterLink}
            loading={extrinsicsQuery.isPending}
            error={
              extrinsicsQuery.error ? (
                <ErrorState
                  error={extrinsicsQuery.error}
                  onRetry={() => {
                    void extrinsicsQuery.refetch();
                  }}
                  context="block extrinsics"
                />
              ) : undefined
            }
            empty={
              <EmptyState
                title="No block extrinsics"
                description="This block has no indexed extrinsics (or the poller window for this shard is still catching up)."
              />
            }
            columns={[
              {
                key: "index",
                label: "Index",
                kind: "number",
                sortable: true,
                value: (row) => row.extrinsic_index ?? null,
              },
              {
                key: "hash",
                label: "Extrinsic",
                kind: "link",
                value: (row) => (row.extrinsic_hash ? shortHash(row.extrinsic_hash, 10) : null),
                href: (row) =>
                  row.extrinsic_hash ? `/extrinsics/${row.extrinsic_hash}` : undefined,
              },
              {
                key: "call",
                label: "Call",
                sortable: true,
                value: (row) => extrinsicCall(row.call_module, row.call_function),
              },
              {
                key: "result",
                label: "Result",
                kind: "status",
                value: (row) => (row.success == null ? null : row.success ? "Success" : "Failed"),
              },
            ]}
          />
        </AnalyticsSection>

        <AnalyticsSection
          id="events"
          name="Events"
          footnote={BLOCK_SECTION_HINTS.events}
          question="Grouped by parent extrinsic. System events (fees, deposits, ExtrinsicSuccess) are collapsed by default."
        >
          {eventsQuery.isPending ? (
            <Skeleton className="h-44" />
          ) : eventsQuery.error ? (
            <ErrorState
              error={eventsQuery.error}
              onRetry={() => {
                void eventsQuery.refetch();
              }}
              context="block events"
            />
          ) : events.length === 0 ? (
            <EmptyState
              title="No block events"
              description="This block has no decoded on-chain events indexed yet."
            />
          ) : (
            <GroupedEvents events={events} extrinsics={extrinsics} />
          )}
        </AnalyticsSection>

        {chainEvents.length > 0 ? (
          <AnalyticsSection
            id="pallets"
            name="Pallet · method breakdown"
            footnote="Ranked runtime pallet.method calls emitted by this block."
          >
            <PalletMethodBreakdown events={chainEvents} />
          </AnalyticsSection>
        ) : null}

        <AnalyticsSection
          id="chain-events"
          name="Chain events (raw)"
          footnote={BLOCK_SECTION_HINTS.chainEventsRaw}
          question="Curated events above are grouped by extrinsic; this table is the raw per-event stream — every pallet-level event in the block, decoded from the chain."
        >
          <details className="group rounded border border-border bg-card">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-13 font-medium text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>
                {chainEventsQuery.isPending
                  ? "Loading raw events…"
                  : `${formatNumber(chainEvents.length)} raw pallet events`}
              </span>
              <span className="text-13">
                <span className="group-open:hidden">Show</span>
                <span className="hidden group-open:inline">Hide</span>
              </span>
            </summary>
            <div className="border-t border-border p-2">
              <DataTable
                rows={chainEvents}
                rowKey={(row) => `${row.block_number}-${row.event_index}`}
                caption="Chain events"
                captionHidden
                loading={chainEventsQuery.isPending}
                error={
                  chainEventsQuery.error ? (
                    <ErrorState
                      error={chainEventsQuery.error}
                      onRetry={() => {
                        void chainEventsQuery.refetch();
                      }}
                      context="block chain events"
                    />
                  ) : undefined
                }
                empty={
                  <EmptyState
                    title="No chain events"
                    description="This block has no decoded pallet events indexed yet, or the all-events backfill hasn't reached it."
                  />
                }
                columns={[
                  {
                    key: "method",
                    label: "Pallet.method",
                    sortable: true,
                    value: (row) => extrinsicCall(row.pallet, row.method),
                  },
                  { key: "phase", label: "Phase", value: (row) => row.phase ?? null },
                  {
                    key: "extrinsic",
                    label: "Extrinsic",
                    kind: "number",
                    sortable: true,
                    value: (row) => row.extrinsic_index ?? null,
                  },
                  {
                    key: "args",
                    label: "Args",
                    value: (row) => formatChainEventArgs(row.args),
                    render: (row) => (
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{formatChainEventArgs(row.args)}</span>
                        <CopyButton value={formatChainEventArgs(row.args)} label="args" compact />
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </details>
        </AnalyticsSection>

        <AnalyticsSection
          id="call"
          name="Call this endpoint"
          footnote={BLOCK_SECTION_HINTS.call}
          question="Copy a ready-to-run request for this block."
        >
          <details className="group rounded border border-border bg-card">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-13 font-medium text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>API &amp; artifact URLs</span>
              <span className="text-13">
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
        </AnalyticsSection>

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
    <Panel flush>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-10 text-ink-muted">
          {groups.length} extrinsic{groups.length === 1 ? "" : "s"} · {events.length} event
          {events.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
          className="text-13 font-medium text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
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
                className="flex w-full items-center gap-2 sm:gap-3 px-3 py-2.5 text-left hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={isOpen}
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5 shrink-0 text-ink-muted" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-ink-muted" />
                )}
                <span className="text-11 tabular-nums text-ink-muted w-8 sm:w-10 shrink-0">
                  {g.isSystem ? "sys" : `#${g.index}`}
                </span>
                <span className="text-11 text-ink-strong truncate min-w-0 flex-1">{title}</span>
                {success != null ? (
                  <span
                    className={`hidden sm:inline text-13 ${success ? "text-health-ok" : "text-health-down"}`}
                  >
                    {success ? "success" : "failed"}
                  </span>
                ) : null}
                <span className="text-10 text-ink-muted shrink-0 hidden sm:inline">
                  {g.list.length} evt{g.list.length === 1 ? "" : "s"}
                </span>
                {g.extrinsic?.extrinsic_hash ? (
                  <Link
                    to="/extrinsics/$hash"
                    params={{ hash: g.extrinsic.extrinsic_hash }}
                    onClick={(e) => e.stopPropagation()}
                    className="hidden sm:inline text-10 text-ink-muted hover:text-ink-strong hover:underline shrink-0"
                    title={g.extrinsic.extrinsic_hash}
                  >
                    {shortHash(g.extrinsic.extrinsic_hash, 6)}
                  </Link>
                ) : null}
              </button>
              {isOpen ? (
                <div className="border-t border-border bg-surface px-3 py-2">
                  <DataTable
                    rows={g.list}
                    rowKey={(event) =>
                      `${event.block_number}-${event.event_index}-${event.event_kind ?? "unknown"}`
                    }
                    caption="Events in this extrinsic"
                    captionHidden
                    dense
                    columns={[
                      {
                        key: "kind",
                        label: "Kind",
                        value: (event) => eventKindLabel(event.event_kind),
                      },
                      ...(showHotkeyCol
                        ? [
                            {
                              key: "hotkey",
                              label: "Hotkey",
                              value: (event: (typeof g.list)[number]) => event.hotkey ?? null,
                              render: (event: (typeof g.list)[number]) => (
                                <AddressDisplay
                                  ss58={event.hotkey}
                                  keep={10}
                                  compact
                                  fallback={<span className="text-ink-muted">—</span>}
                                />
                              ),
                            },
                          ]
                        : []),
                      {
                        key: "amount",
                        label: "Amount",
                        kind: "number" as const,
                        value: (event: (typeof g.list)[number]) => event.amount_tao ?? null,
                        render: (event: (typeof g.list)[number]) =>
                          event.amount_tao == null ? (
                            <span className="text-11 text-ink-muted">—</span>
                          ) : (
                            <TaoValue amount={event.amount_tao} layout="stacked" precision={4} />
                          ),
                      },
                    ]}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
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
        className="mg-focus-ring h-8 w-40 rounded border border-border bg-paper px-2 font-mono text-13 tabular-nums text-ink-strong placeholder:text-ink-subtle sm:w-48"
      />
      <Kbd>↵</Kbd>
      {error ? (
        <span id="jump-to-block-err" role="alert" className="ml-1 text-10 text-health-down">
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
      <dt className="inline-flex items-center gap-1 text-13 text-ink-muted sm:w-40 sm:shrink-0">
        <span>{label}</span>
        {hint ? <Definition term={label} sentence={hint} /> : null}
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
