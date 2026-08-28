import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CompositionBreakdown,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  LineWithWindow,
  LoadMore,
  Raw,
  TimeAgo,
  truncateIdentifier,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
import {
  blockChainEventsQuery,
  blockExtrinsicsInfiniteQuery,
  blockQuery,
  blocksQuery,
} from "@/lib/metagraphed/queries";
import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import { extrinsicColumns } from "@/components/metagraphed/chain-stream/chain-stream-columns";
import { argRows } from "@/components/metagraphed/chain-detail/chain-detail-logic";
import {
  CADENCE_BLOCK_LIMIT,
  blockFactCells,
  blockFacts,
  cadencePoints,
  cadenceRange,
  eventLabel,
  eventsByPallet,
  neighbourHrefs,
  shouldFetchCountedBlockDetail,
} from "@/components/metagraphed/chain-detail/chain-detail-logic";
import { Route } from "./blocks.$ref";

const API_PATHS = [
  "/api/v1/blocks",
  "/api/v1/blocks/{ref}",
  "/api/v1/blocks/{ref}/extrinsics",
  "/api/v1/blocks/{ref}/chain-events",
];
const BLOCK_EXTRINSIC_PAGE_SIZE = 100;

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/**
 * One block (#11621). Hero, three sections, `Raw`.
 *
 * What went: four KPI tiles that repeated the hero, a chain-walk ribbon of
 * twenty sibling blocks, a neighbour-compare panel, a `CALL THIS ENDPOINT`
 * tab strip and a data-sources tail. The ribbon and the compare panel were
 * both answering "how does this block sit among its neighbours", which is one
 * question and is now one chart -- the cadence line, ruled at this block.
 *
 * Size is deliberately absent from the hero: /api/v1/blocks/{ref} publishes no
 * byte count, and a stat strip carrying a permanent em-dash teaches readers to
 * stop reading stat strips. State root and extrinsics root are absent from
 * `Raw` for the same reason -- the tier does not decode them.
 */
export function BlockDetailPage() {
  const { ref } = Route.useParams();
  const navigate = useNavigate();
  // `blockQuery` returns the Block itself, with the response's own
  // `prev_block_number` / `next_block_number` folded onto it by
  // `normalizeBlock` -- not the `{ block, prev, next }` envelope the endpoint
  // publishes. Reading it as the envelope silently yields `undefined` for
  // every field, and the page renders a hero about nothing.
  const block = useSuspenseQuery(blockQuery(ref)).data.data as Block | null;
  const number = block?.block_number ?? null;
  const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState(false);

  // A reader can walk prev/next without remounting this route. Start the next
  // block from its immediate record rather than carrying a secondary,
  // potentially slow forensic fetch across the navigation.
  useEffect(() => {
    setTechnicalDetailsOpen(false);
  }, [ref]);

  const shouldFetchExtrinsics = shouldFetchCountedBlockDetail(block?.extrinsic_count);
  const shouldFetchEvents =
    technicalDetailsOpen && shouldFetchCountedBlockDetail(block?.event_count);
  const extrinsics = useInfiniteQuery({
    ...blockExtrinsicsInfiniteQuery(ref, BLOCK_EXTRINSIC_PAGE_SIZE, block?.extrinsic_count),
    enabled: shouldFetchExtrinsics,
    retry: 0,
  });
  // Decoded events can be a substantial all-events payload. The block header
  // already gives the exact count, so keep the primary extrinsic ledger fast
  // and only ask for the full technical record when a reader opens it.
  const events = useQuery({
    ...blockChainEventsQuery(ref),
    enabled: shouldFetchEvents,
    retry: 0,
  });
  const [start, end] = number == null ? [0, 0] : cadenceRange(number);
  const window = useQuery({
    ...blocksQuery({ block_start: start, block_end: end, limit: CADENCE_BLOCK_LIMIT }),
    enabled: technicalDetailsOpen && number != null,
    retry: 0,
  });

  const neighbours = neighbourHrefs(
    block?.prev_block_number as number | null | undefined,
    block?.next_block_number as number | null | undefined,
  );

  // `[` and `]` walk the chain, the shortcut the retired ribbon advertised.
  // Bound on the document rather than the hero so it works wherever focus is,
  // and skipped while the reader is typing -- a shortcut that fires inside the
  // search box is a bug, not a feature.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const href = event.key === "[" ? neighbours.prev : event.key === "]" ? neighbours.next : null;
      if (!href) return;
      event.preventDefault();
      void navigate({ to: href });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [neighbours.prev, neighbours.next, navigate]);

  const rows = useMemo(
    () => (extrinsics.data?.pages ?? []).flatMap((page) => page.data.extrinsics as Extrinsic[]),
    [extrinsics.data],
  );
  const extrinsicTotal =
    block?.extrinsic_count ?? extrinsics.data?.pages[0]?.data.extrinsic_count ?? null;
  const eventRows = useMemo(() => (events.data?.data.events ?? []) as ChainEvent[], [events.data]);
  const segments = useMemo(() => eventsByPallet(eventRows), [eventRows]);
  const points = useMemo(() => cadencePoints((window.data?.data ?? []) as Block[]), [window.data]);
  const heroFacts = blockFacts(block, { count: formatNumber });
  const heroCells = blockFactCells(block, { count: formatNumber });
  const eventCount = block?.event_count;

  const eventColumns: DataTableColumn<ChainEvent>[] = [
    {
      key: "index",
      label: "Index",
      kind: "number",
      align: "right",
      width: 90,
      value: (row) => row.event_index,
    },
    { key: "kind", label: "Event", value: (row) => eventLabel(row) },
    {
      key: "summary",
      label: "Summary",
      kind: "text",
      value: (row) => (typeof row.summary === "string" && row.summary ? row.summary : null),
    },
    {
      key: "extrinsic",
      label: "From extrinsic",
      kind: "number",
      align: "right",
      width: 130,
      demote: true,
      value: (row) => row.extrinsic_index ?? null,
    },
  ];

  const rawRows: RawRow[] = [
    ...(block?.block_hash ? [{ label: "block hash", value: block.block_hash }] : []),
    ...(block?.parent_hash ? [{ label: "parent hash", value: block.parent_hash }] : []),
    ...(block?.author ? [{ label: "author", value: block.author }] : []),
    ...API_PATHS.filter((path) => !path.includes("{ref}") || number != null).map((path) => {
      const resolved = path.replace("{ref}", String(number ?? ref));
      return {
        label: resolved.replace("/api/v1/", ""),
        value: `${API_BASE}${resolved}`,
        href: `${API_BASE}${resolved}`,
      };
    }),
  ];

  const heading = number == null ? ref : `#${formatNumber(number)}`;

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--entity mg-hero--block"
        crumbs={[
          { label: "Chain", href: "/chain" },
          { label: "Blocks", href: "/chain/blocks" },
        ]}
        name={heading}
        secondary={
          <>
            {neighbours.prev ? (
              <RouterLink
                href={neighbours.prev}
                className="mg-hero-icon-action"
                aria-label="Previous block ( [ )"
              >
                <ArrowLeft aria-hidden size={14} />
              </RouterLink>
            ) : null}
            {neighbours.next ? (
              <RouterLink
                href={neighbours.next}
                className="mg-hero-icon-action"
                aria-label="Next block ( ] )"
              >
                <ArrowRight aria-hidden size={14} />
              </RouterLink>
            ) : null}
          </>
        }
        sentence={
          <FactSentence>
            Authored by{" "}
            <AddressDisplay
              ss58={block?.author}
              compact
              fallback={block?.author ? truncateIdentifier(block.author) : "an unknown key"}
            />{" "}
            {block?.observed_at ? <TimeAgo at={block.observed_at} /> : null}.{" "}
            {!heroCells
              ? heroFacts.map((fact) => (
                  <Fact key={fact.key}>
                    {fact.label} {fact.value}
                  </Fact>
                ))
              : null}
          </FactSentence>
        }
        cells={heroCells}
        live={{ updatedAt: block?.observed_at ?? null, source: "chain-direct" }}
      />

      <DataTable
        id="contents"
        rows={rows}
        columns={extrinsicColumns().filter((column) => column.key !== "block")}
        rowKey={(row) => row.extrinsic_hash || `${row.extrinsic_index ?? "?"}`}
        // No count in the caption: `DataTable` prints the row count beside it
        // already, and "Extrinsics in this block (18) (18)" is what saying it
        // twice looks like.
        caption="Extrinsics in this block"
        rowHref={(row) => (row.extrinsic_hash ? `/extrinsics/${row.extrinsic_hash}` : undefined)}
        link={RouterLink}
        source="block-extrinsic"
        expand={(row) => {
          const args = argRows(row.call_args);
          return args.length === 0 ? null : (
            // The Raw block's own row grid, not a new one: an argument list
            // IS a label/value list of full, uncut identifiers, which is what
            // `.mg-raw-row` already is.
            <dl>
              {args.map((arg) => (
                <div key={arg.key} className="mg-raw-row">
                  <dt>{arg.type ? `${arg.name} · ${arg.type}` : arg.name}</dt>
                  <dd>{arg.value}</dd>
                </div>
              ))}
            </dl>
          );
        }}
        loading={shouldFetchExtrinsics && extrinsics.isPending}
        paginate={false}
        error={
          extrinsics.isError && rows.length === 0 ? (
            <ErrorState
              error={extrinsics.error}
              onRetry={() => void extrinsics.refetch()}
              context="block extrinsics"
            />
          ) : undefined
        }
        empty="This block carried no extrinsics."
      />
      {extrinsics.hasNextPage || (extrinsics.error && rows.length > 0) ? (
        <LoadMore
          hasMore={Boolean(extrinsics.hasNextPage)}
          isLoading={extrinsics.isFetchingNextPage}
          onLoadMore={() => void extrinsics.fetchNextPage()}
          shown={rows.length}
          total={extrinsicTotal ?? undefined}
          error={extrinsics.error}
        />
      ) : null}

      <section
        className="mg-block-event-stream"
        aria-labelledby="block-event-stream-title"
        aria-busy={
          technicalDetailsOpen && ((shouldFetchEvents && events.isPending) || window.isPending)
            ? true
            : undefined
        }
      >
        <div className="mg-block-event-stream-head">
          <div>
            <p className="mg-block-event-stream-kicker">Technical record</p>
            <h2 id="block-event-stream-title">Decoded event stream</h2>
            <p className="mg-block-event-stream-detail">
              {typeof eventCount === "number"
                ? `${formatNumber(eventCount)} decoded event${eventCount === 1 ? "" : "s"} reported for this block.`
                : "Inspect decoded events and local block cadence when the index provides them."}
            </p>
          </div>
          <button
            type="button"
            className="mg-block-event-trigger"
            aria-expanded={technicalDetailsOpen}
            aria-controls="block-technical-record"
            onClick={() => setTechnicalDetailsOpen((open) => !open)}
          >
            {technicalDetailsOpen ? "Hide technical record" : "Inspect decoded events"}
          </button>
        </div>

        {technicalDetailsOpen ? (
          <div id="block-technical-record" className="mg-block-event-stream-body">
            {shouldFetchEvents && events.isPending ? (
              <CompositionBreakdown
                formatValue={(value) => formatNumber(value)}
                legendCols={4}
                ariaLabel="Events by pallet"
                source="block-pallet"
                loading
                loadingItems={4}
              />
            ) : segments.length > 0 ? (
              <CompositionBreakdown
                segments={segments}
                formatValue={(value) => formatNumber(value)}
                legendCols={4}
                ariaLabel="Events by pallet"
                source="block-pallet"
              />
            ) : null}
            <DataTable
              id="events"
              rows={eventRows}
              columns={eventColumns}
              rowKey={(row) => `${row.event_index ?? "?"}`}
              caption="Events emitted"
              link={RouterLink}
              source="block-event"
              loading={shouldFetchEvents && events.isPending}
              error={
                events.isError ? (
                  <ErrorState
                    error={events.error}
                    onRetry={() => void events.refetch()}
                    context="decoded events"
                  />
                ) : undefined
              }
              empty="No decoded events for this block."
            />

            {window.isPending && number != null ? (
              <LineWithWindow
                compact
                points={[]}
                window={{ from: 0, to: 0 }}
                unit="seconds between blocks"
                ariaLabel={`Block cadence around #${formatNumber(number)}`}
                loading
              />
            ) : window.isError ? (
              <ErrorState
                error={window.error}
                onRetry={() => void window.refetch()}
                context="block cadence"
              />
            ) : points.length > 1 && number != null ? (
              <LineWithWindow
                compact
                points={points}
                window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
                unit="seconds between blocks"
                formatValue={(value) => `${formatDecimal(value, 1)}s`}
                formatDate={(t) => `#${formatNumber(t)}`}
                formatRange={(from, to) => `#${formatNumber(from)} → #${formatNumber(to)}`}
                marker={number}
                markerLabel={`This block, #${formatNumber(number)}`}
                ariaLabel={`Block cadence around #${formatNumber(number)}`}
                source="block-cadence"
              />
            ) : window.isSuccess ? (
              <p className="mg-block-event-stream-empty">
                The indexed window does not yet contain enough consecutive blocks for a cadence
                reading.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <Raw rows={rawRows} />
    </AppShell>
  );
}
