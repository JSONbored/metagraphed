import { useEffect, useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CompositionBreakdown,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  LineWithWindow,
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
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  blockChainEventsQuery,
  blockExtrinsicsQuery,
  blockQuery,
  blocksQuery,
} from "@/lib/metagraphed/queries";
import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import { extrinsicColumns } from "@/components/metagraphed/chain-stream/chain-stream-columns";
import { argRows } from "@/components/metagraphed/chain-detail/chain-detail-logic";
import {
  CADENCE_SPAN,
  blockFacts,
  cadencePoints,
  cadenceRange,
  eventLabel,
  eventsByPallet,
  neighbourHrefs,
} from "@/components/metagraphed/chain-detail/chain-detail-logic";
import { Route } from "./blocks.$ref";

const API_PATHS = [
  "/api/v1/blocks",
  "/api/v1/blocks/{ref}",
  "/api/v1/blocks/{ref}/extrinsics",
  "/api/v1/blocks/{ref}/chain-events",
];

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

  const extrinsics = useQuery({ ...blockExtrinsicsQuery(ref, { limit: 100 }), retry: 0 });
  const events = useQuery({ ...blockChainEventsQuery(ref), retry: 0 });
  const [start, end] = number == null ? [0, 0] : cadenceRange(number);
  const window = useQuery({
    ...blocksQuery({ block_start: start, block_end: end, limit: 2 * CADENCE_SPAN + 1 }),
    enabled: number != null,
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
    () => (extrinsics.data?.data.extrinsics ?? []) as Extrinsic[],
    [extrinsics.data],
  );
  const eventRows = useMemo(() => (events.data?.data.events ?? []) as ChainEvent[], [events.data]);
  const segments = useMemo(() => eventsByPallet(eventRows), [eventRows]);
  const points = useMemo(() => cadencePoints((window.data?.data ?? []) as Block[]), [window.data]);

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
            {blockFacts(block, { count: formatNumber }).map((fact) => (
              <Fact key={fact.key}>
                {fact.label} {fact.value}
              </Fact>
            ))}
          </FactSentence>
        }
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
        loading={extrinsics.isPending}
        empty="This block carried no extrinsics."
      />

      {segments.length > 0 ? (
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
        loading={events.isPending}
        empty="No decoded events for this block."
      />

      {points.length > 1 && number != null ? (
        <LineWithWindow
          compact
          points={points}
          window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
          unit="seconds between blocks"
          formatValue={(value) => `${value.toFixed(1)}s`}
          formatDate={(t) => `#${formatNumber(t)}`}
          formatRange={(from, to) => `#${formatNumber(from)} → #${formatNumber(to)}`}
          marker={number}
          markerLabel={`This block, #${formatNumber(number)}`}
          ariaLabel={`Block time within ${CADENCE_SPAN} blocks either side of #${formatNumber(number)}`}
          source="block-cadence"
        />
      ) : null}

      <Raw rows={rawRows} />
    </AppShell>
  );
}
