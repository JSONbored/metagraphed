import { useMemo } from "react";
import { useInfiniteQuery, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  LoadMore,
  Raw,
  TimeAgo,
  truncateIdentifier,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import {
  chainEventsInfiniteQuery,
  extrinsicQuery,
  extrinsicsQuery,
} from "@/lib/metagraphed/queries";
import type { ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import {
  argRows,
  eventLabel,
  extrinsicFacts,
  extrinsicTitle,
  type ArgRow,
} from "@/components/metagraphed/chain-detail/chain-detail-logic";
import { multisigCallHash } from "@/lib/metagraphed/extrinsics";
import { Route } from "./extrinsics.$hash";

const API_PATHS = ["/api/v1/extrinsics", "/api/v1/extrinsics/{hash}", "/api/v1/chain-events"];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

const SIGNER_LIMIT = 10;
// A decoded call normally emits only a handful of events. Asking the
// lakehouse for its 50-row feed default made the cold path scan substantially
// farther before proving the page was complete. Ten keeps the first forensic
// answer compact; the existing cursor affordance retains lossless continuation
// for unusually event-heavy calls.
const EXTRINSIC_EVENT_PAGE_SIZE = 10;

/**
 * One extrinsic (#11621). Hero, three sections, `Raw`.
 *
 * What went: the KPI tiles that repeated the hero, the `CALL THIS ENDPOINT`
 * tab strip (the endpoint is one `Raw` row), and the data-sources tail.
 *
 * Two spec fields are absent because the tier does not publish them. There is
 * no `nonce` on /api/v1/extrinsics/{hash}, so the fact strip carries fee and
 * tip instead of fee and nonce; and there is no
 * /api/v1/extrinsics/{hash}/chain-events route -- the detail response's own
 * `events` array is the account-attributed shape (`event_kind`, `coldkey`,
 * `amount_tao`), not pallet/method. The pallet-level events come from
 * /api/v1/chain-events filtered to this block and extrinsic index, which is
 * the same rows the block page shows for the same call.
 */
export function ExtrinsicDetailPage() {
  const { hash } = Route.useParams();
  // `extrinsicQuery` returns the Extrinsic itself, not the `{ extrinsic,
  // events }` envelope /api/v1/extrinsics/{hash} publishes -- `normalizeExtrinsic`
  // unwraps it. Reading the envelope shape yields `undefined` for every field
  // and renders a page about an extrinsic signed by nobody.
  const extrinsic = useSuspenseQuery(extrinsicQuery(hash)).data.data as Extrinsic | null;
  const block = extrinsic?.block_number ?? null;
  const index = extrinsic?.extrinsic_index ?? null;
  const { ref: peersRef, nearViewport: peersNearViewport } =
    useNearViewport<HTMLDivElement>("0px 0px");

  const events = useInfiniteQuery({
    ...chainEventsInfiniteQuery(
      block == null || index == null
        ? {}
        : { block, extrinsic: index, limit: EXTRINSIC_EVENT_PAGE_SIZE },
    ),
    enabled: block != null && index != null,
    retry: 0,
  });
  /**
   * The third section asks the question this extrinsic actually raises.
   *
   * For a Multisig call carrying a `call_hash`, that is "what else references
   * this call" -- the approvals and the execution are separate extrinsics by
   * separate signers, and the signer's own recent calls say nothing about
   * them. For everything else it is "what else has this signer been doing".
   * One section either way: two would leave one of them permanently empty on
   * every page, which is how a section teaches readers to skip it.
   */
  const callHash = multisigCallHash(extrinsic?.call_module, extrinsic?.call_args);
  const peers = useQuery({
    ...extrinsicsQuery(
      callHash
        ? { call_hash: callHash, limit: SIGNER_LIMIT + 1 }
        : { signer: extrinsic?.signer ?? "", limit: SIGNER_LIMIT + 1 },
    ),
    // The related-call table answers a later question than the arguments and
    // decoded results above it. Keep the table's place and state explicit,
    // but defer this additional cross-extrinsic lookup until a reader reaches
    // it on the detail route.
    enabled: peersNearViewport && Boolean(callHash || extrinsic?.signer),
    retry: 0,
  });

  const args = useMemo(() => argRows(extrinsic?.call_args), [extrinsic]);
  const eventRows = useMemo(() => {
    // A misbehaving upstream cursor must not duplicate rows in a forensic
    // record. The page keeps the first instance, then reports the cursor
    // problem through `LoadMore` below rather than pretending those repeated
    // rows are separate emitted events.
    const seen = new Set<string>();
    return (events.data?.pages ?? [])
      .flatMap((page) => page.data)
      .filter((event) => {
        const key = `${event.block_number ?? "?"}-${event.event_index ?? "?"}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }) as ChainEvent[];
  }, [events.data]);
  const eventCursorInvalid =
    events.data?.pages.some((page) => page.cursorInvalid === true) ?? false;
  // This extrinsic is not one of "the signer's other calls".
  const peerRows = useMemo(
    () =>
      ((peers.data?.data ?? []) as Extrinsic[])
        .filter((row) => row.extrinsic_hash !== hash)
        .slice(0, SIGNER_LIMIT),
    [peers.data, hash],
  );

  const argColumns: DataTableColumn<ArgRow>[] = [
    { key: "name", label: "Name", width: 220, value: (row) => row.name },
    {
      key: "type",
      label: "Type",
      width: 150,
      demote: true,
      value: (row) => row.type,
    },
    { key: "value", label: "Value", kind: "identifier", value: (row) => row.value },
  ];

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
  ];

  const peerColumns: DataTableColumn<Extrinsic>[] = [
    {
      key: "hash",
      label: "Hash",
      kind: "link",
      width: 150,
      value: (row) => row.extrinsic_hash ?? null,
      href: (row) => (row.extrinsic_hash ? `/extrinsics/${row.extrinsic_hash}` : undefined),
      format: (value) => (typeof value === "string" && value ? truncateIdentifier(value) : "—"),
    },
    {
      key: "block",
      label: "Block",
      kind: "link",
      width: 130,
      value: (row) => row.block_number ?? null,
      href: (row) => (row.block_number == null ? undefined : `/blocks/${row.block_number}`),
      format: (value) => (typeof value === "number" ? `#${formatNumber(value)}` : "—"),
    },
    {
      key: "call",
      label: "Call",
      value: (row) =>
        row.call_module && row.call_function
          ? `${row.call_module}.${row.call_function}`
          : (row.call_module ?? null),
    },
    {
      key: "result",
      label: "Result",
      kind: "status",
      width: 100,
      value: (row) => (row.success == null ? null : row.success ? "ok" : "failed"),
    },
    {
      key: "observed",
      label: "Observed",
      kind: "time",
      width: 110,
      value: (row) => row.observed_at ?? null,
    },
  ];

  const rawRows: RawRow[] = [
    ...(extrinsic?.extrinsic_hash
      ? [{ label: "extrinsic hash", value: extrinsic.extrinsic_hash }]
      : []),
    ...(extrinsic?.signer ? [{ label: "signer", value: extrinsic.signer }] : []),
    ...API_PATHS.map((path) => {
      const resolved = path.replace("{hash}", hash);
      return {
        label: resolved.replace("/api/v1/", ""),
        value: `${API_BASE}${resolved}`,
        href: `${API_BASE}${resolved}`,
      };
    }),
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--entity"
        crumbs={[
          { label: "Chain", href: "/chain" },
          { label: "Extrinsics", href: "/chain/extrinsics" },
        ]}
        name={extrinsicTitle(extrinsic, truncateIdentifier(hash))}
        sentence={
          <FactSentence>
            {truncateIdentifier(hash)}, signed by{" "}
            <AddressDisplay
              ss58={extrinsic?.signer}
              compact
              fallback={extrinsic?.signer ? truncateIdentifier(extrinsic.signer) : "nobody"}
            />{" "}
            {extrinsic?.observed_at ? <TimeAgo at={extrinsic.observed_at} /> : null}.{" "}
            {extrinsicFacts(extrinsic, { count: formatNumber, tao: formatTao }).map((fact) => (
              <Fact key={fact.key}>
                {fact.label} {fact.value}
              </Fact>
            ))}
          </FactSentence>
        }
        live={{ updatedAt: extrinsic?.observed_at ?? null, source: "chain-direct" }}
      />

      <DataTable
        id="arguments"
        rows={args}
        columns={argColumns}
        rowKey={(row) => row.key}
        caption="What this call was made with"
        source="extrinsic-arg"
        paginate={false}
        empty="This call takes no arguments."
      />

      <DataTable
        id="events"
        rows={eventRows}
        columns={eventColumns}
        rowKey={(row) => `${row.event_index ?? "?"}`}
        caption="What it produced"
        source="extrinsic-event"
        loading={events.isPending}
        paginate={false}
        error={
          events.isError ? (
            <ErrorState
              error={events.error}
              onRetry={() => void events.refetch()}
              context="decoded events"
            />
          ) : undefined
        }
        empty="No events are decoded for this extrinsic."
      />
      {/* A raw event record can exceed the initial 50-row read. The detail
          page must offer its continuation instead of implying page one is
          every event this call produced. */}
      {events.hasNextPage || ((events.error || eventCursorInvalid) && eventRows.length > 0) ? (
        <LoadMore
          hasMore={Boolean(events.hasNextPage)}
          isLoading={events.isFetchingNextPage}
          onLoadMore={() => void events.fetchNextPage()}
          shown={eventRows.length}
          error={events.error}
          cursorInvalid={eventCursorInvalid}
        />
      ) : null}

      <div ref={peersRef} data-mg-extrinsic-peer="">
        <DataTable
          id={callHash ? "multisig-chain" : "signer"}
          rows={peerRows}
          columns={peerColumns}
          rowKey={(row) => row.extrinsic_hash || `${row.block_number}-${row.extrinsic_index}`}
          caption={
            callHash ? "Other calls referencing this call hash" : "This signer's other recent calls"
          }
          rowHref={(row) => (row.extrinsic_hash ? `/extrinsics/${row.extrinsic_hash}` : undefined)}
          link={RouterLink}
          source="extrinsic-peer"
          loading={!peersNearViewport || peers.isPending}
          paginate={false}
          // #6426: a failed lookup and a genuine zero are different answers.
          // The retired section rendered the same "no siblings" copy for both,
          // so a reader could not tell "there are none" from "we could not find
          // out"; `DataTable` keeps them apart because `error` and `empty` are
          // separate slots.
          error={
            peers.isError ? (
              <ErrorState
                error={peers.error}
                onRetry={() => void peers.refetch()}
                context={
                  callHash ? "calls referencing this call hash" : "this signer's other recent calls"
                }
              />
            ) : undefined
          }
          empty={
            callHash
              ? "No other extrinsics reference this call hash yet."
              : "No other recent calls from this signer."
          }
        />
      </div>

      <Raw rows={rawRows} />
    </AppShell>
  );
}
