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
import { BlockDetailCatchupStatus, ErrorState } from "@/components/metagraphed/states";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatDecimal, formatNumber, formatTao, formatUsd } from "@/lib/metagraphed/format";
import {
  blockChainEventsQuery,
  blockEventsInfiniteQuery,
  blockExtrinsicsInfiniteQuery,
  blockQuery,
  blocksQuery,
} from "@/lib/metagraphed/queries";
import type { AccountEvent, Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import { extrinsicColumns } from "@/components/metagraphed/chain-stream/chain-stream-columns";
import { argRows } from "@/components/metagraphed/chain-detail/chain-detail-logic";
import {
  CADENCE_BLOCK_LIMIT,
  blockFactCells,
  blockFacts,
  cadencePoints,
  cadenceRange,
  eventHref,
  eventLabel,
  eventsByPallet,
  neighbourHrefs,
  shouldFetchCountedBlockDetail,
} from "@/components/metagraphed/chain-detail/chain-detail-logic";
import {
  BLOCK_DETAIL_RETRY_COUNT,
  blockDetailRetryDelay,
  isBlockDetailUnavailable,
  shouldRetryBlockDetail,
} from "@/components/metagraphed/chain-detail/block-detail-retry";
import { Route } from "./blocks.$ref";

const API_PATHS = [
  "/api/v1/blocks",
  "/api/v1/blocks/{ref}",
  "/api/v1/blocks/{ref}/extrinsics",
  "/api/v1/blocks/{ref}/events",
  "/api/v1/blocks/{ref}/chain-events",
];
const BLOCK_EXTRINSIC_PAGE_SIZE = 100;
const BLOCK_EFFECT_PAGE_SIZE = 100;

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

function EconomicFootprint({ block }: { block: Block | null }) {
  const status = block?.decode_status ?? "unavailable";
  const ids = block?.subnet_ids ?? [];
  const metric = (label: string, value: number | null | undefined, note: string) => (
    <div>
      <dt>{label}</dt>
      <dd>{typeof value === "number" ? formatTao(value) : "—"}</dd>
      <span className="mg-block-economics-ledger-note">{note}</span>
    </div>
  );

  return (
    <section className="mg-block-economics" aria-labelledby="block-economics-title">
      <div className="mg-block-economics-head">
        <div>
          <p className="mg-block-event-stream-kicker">Economic footprint</p>
          <h2 id="block-economics-title">Value moved in this block.</h2>
        </div>
        <p>
          Native transfers and stake flow form the headline. Fees, issuance and alpha stay separate.
        </p>
      </div>

      {status === "pending" ? (
        <div className="mg-block-economics-state" role="status" aria-live="polite">
          <strong>Decoding economic activity…</strong>
          <span>The block header is live; its event-level value breakdown is catching up.</span>
        </div>
      ) : status !== "complete" ? (
        <div className="mg-block-economics-state">
          <strong>Economic breakdown unavailable.</strong>
          <span>This block predates the retained derivation; no zero has been inferred.</span>
        </div>
      ) : (
        <>
          <div className="mg-block-economics-total">
            <span>Economic activity</span>
            <strong>{formatTao(block?.economic_activity_tao)}</strong>
            <span className="mg-block-economics-total-note">
              {typeof block?.economic_activity_usd === "number"
                ? `${formatUsd(block.economic_activity_usd)} at ${formatUsd(block.usd_per_tao)} / TAO`
                : "USD conversion unavailable"}
            </span>
          </div>
          <dl className="mg-block-economics-ledger">
            {metric("Native transfers", block?.native_transfer_tao, "Balances.Transfer only")}
            {metric("Stake flow", block?.stake_flow_tao, "Added plus removed")}
            {metric("Fees", block?.fee_tao, "Signed extrinsics")}
            {metric("Tips", block?.tip_tao, "Explicit transaction tips")}
            {metric("Issuance", block?.issuance_tao, "Reported separately")}
          </dl>
          <div className="mg-block-economics-subnets">
            <span>Subnets touched</span>
            {ids.length > 0 ? (
              <span className="mg-subnet-links">
                {ids.map((netuid) => (
                  <RouterLink key={netuid} href={`/subnets/${netuid}`}>
                    SN{netuid}
                  </RouterLink>
                ))}
              </span>
            ) : (
              <strong>None decoded</strong>
            )}
          </div>
          <p className="mg-block-economics-source">
            USD uses the current source-linked TAO/USD reading
            {block?.tao_usd_observed_at ? (
              <>
                , observed <TimeAgo at={block.tao_usd_observed_at} />
              </>
            ) : null}
            . It is a current conversion, not the historical price at block time.
          </p>
        </>
      )}
    </section>
  );
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
    retry: shouldRetryBlockDetail,
    retryDelay: blockDetailRetryDelay,
  });
  // Decoded events can be a substantial all-events payload. The block header
  // already gives the exact count, so keep the primary extrinsic ledger fast
  // and only ask for the full technical record when a reader opens it.
  const events = useQuery({
    ...blockChainEventsQuery(ref),
    enabled: shouldFetchEvents,
    retry: shouldRetryBlockDetail,
    retryDelay: blockDetailRetryDelay,
  });
  const economicEvents = useInfiniteQuery({
    ...blockEventsInfiniteQuery(ref, BLOCK_EFFECT_PAGE_SIZE),
    enabled: shouldFetchEvents,
    retry: shouldRetryBlockDetail,
    retryDelay: blockDetailRetryDelay,
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
  const economicEventRows = useMemo(
    () => (economicEvents.data?.pages ?? []).flatMap((page) => page.data.events as AccountEvent[]),
    [economicEvents.data],
  );
  const segments = useMemo(() => eventsByPallet(eventRows), [eventRows]);
  const points = useMemo(() => cadencePoints((window.data?.data ?? []) as Block[]), [window.data]);
  const heroFacts = blockFacts(block, { count: formatNumber });
  const heroCells = blockFactCells(block, { count: formatNumber });
  const eventCount = block?.event_count;
  const extrinsicsCatchingUp =
    extrinsics.isFetching && isBlockDetailUnavailable(extrinsics.failureReason);
  const eventsCatchingUp = events.isFetching && isBlockDetailUnavailable(events.failureReason);

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

  const economicEventColumns: DataTableColumn<AccountEvent>[] = [
    {
      key: "index",
      label: "Index",
      kind: "number",
      align: "right",
      width: 90,
      value: (row) => row.event_index,
    },
    { key: "effect", label: "Decoded effect", width: 180, value: (row) => row.event_kind },
    {
      key: "tao",
      label: "TAO amount",
      kind: "number",
      align: "right",
      width: 140,
      value: (row) => row.amount_tao ?? null,
      format: (value) => (typeof value === "number" ? formatTao(value) : "—"),
      definition: "Native TAO decoded for this effect; alpha is never substituted here.",
    },
    {
      key: "alpha",
      label: "Alpha amount",
      kind: "number",
      align: "right",
      width: 140,
      value: (row) => row.alpha_amount ?? null,
      format: (value) => (typeof value === "number" ? `${formatNumber(value)} α` : "—"),
      definition: "Subnet alpha decoded for this effect; it remains independent of TAO.",
    },
    {
      key: "subnet",
      label: "Subnet",
      width: 100,
      value: (row) => row.netuid ?? null,
      render: (row) =>
        typeof row.netuid === "number" ? (
          <RouterLink href={`/subnets/${row.netuid}`}>SN{row.netuid}</RouterLink>
        ) : (
          "—"
        ),
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

      {extrinsicsCatchingUp ? (
        <BlockDetailCatchupStatus
          detail="extrinsics"
          attempt={extrinsics.failureCount}
          total={BLOCK_DETAIL_RETRY_COUNT}
        />
      ) : null}
      <EconomicFootprint block={block} />
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
            {eventsCatchingUp ? (
              <BlockDetailCatchupStatus
                detail="events"
                attempt={events.failureCount}
                total={BLOCK_DETAIL_RETRY_COUNT}
              />
            ) : null}
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
              id="economic-events"
              rows={economicEventRows}
              columns={economicEventColumns}
              rowKey={(row) => `${row.event_index ?? "?"}-${row.event_kind ?? "effect"}`}
              caption="Account-attributed economic effects"
              link={RouterLink}
              source="block-economic-event"
              loading={shouldFetchEvents && economicEvents.isPending}
              error={
                economicEvents.isError && economicEventRows.length === 0 ? (
                  <ErrorState
                    error={economicEvents.error}
                    onRetry={() => void economicEvents.refetch()}
                    context="economic effects"
                  />
                ) : undefined
              }
              paginate={false}
              empty="No account-attributed economic effects were decoded for this block."
            />
            {economicEvents.hasNextPage ||
            (economicEvents.error && economicEventRows.length > 0) ? (
              <LoadMore
                hasMore={Boolean(economicEvents.hasNextPage)}
                isLoading={economicEvents.isFetchingNextPage}
                onLoadMore={() => void economicEvents.fetchNextPage()}
                shown={economicEventRows.length}
                error={economicEvents.error}
              />
            ) : null}
            <DataTable
              id="events"
              rows={eventRows}
              columns={eventColumns}
              rowKey={(row) => `${row.event_index ?? "?"}`}
              caption="Events emitted"
              rowHref={(row) => eventHref(row) ?? undefined}
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
