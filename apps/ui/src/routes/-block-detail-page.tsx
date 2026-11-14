import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AnalyticsSection, EntityHero, FactSentence, Raw, RawCode } from "@jsonbored/ui-kit";
import { createV2ReadClient, V2ReadClientError } from "../../../../src/v2/client.ts";
import { chainAccountHref } from "@/lib/metagraphed/accounts";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { blockRouteSelection } from "@/lib/metagraphed/block-route-loader";
import { DEFAULT_API_BASE, setApiBase } from "@/lib/metagraphed/config";
import { formatAbsoluteTime } from "@/lib/metagraphed/format";
import {
  blockDetailInput,
  modernExplorerFailure,
  modernExplorerKey,
  modernExplorerPath,
  ModernExplorerSources,
  readModernBlock,
  useModernExplorerConfiguration,
  type ModernBlock,
  type ModernBlockPins,
  type ModernExplorerScope,
} from "@/lib/metagraphed/modern-explorer";
import { Route } from "./blocks.$ref";

const actionClass =
  "inline-flex min-h-11 items-center justify-center rounded border border-border px-3 py-2 text-13 text-ink-strong disabled:opacity-60";

export function BlockDetailPage() {
  const { ref } = Route.useParams();
  const search = Route.useSearch() as { block_hash: string; publication_id: string };
  const configuration = useModernExplorerConfiguration();
  const selection = blockRouteSelection(ref, search);
  if (configuration?.status === "ready" && selection.status === "ready")
    return (
      <PublishedBlock
        key={JSON.stringify([configuration.scope, selection])}
        scope={configuration.scope}
        height={selection.height}
        pins={selection.pins}
      />
    );
  return (
    <AppShell dataProfile="modern">
      <EntityHero
        name={`Block ${ref}`}
        sentence={<FactSentence>Published block evidence.</FactSentence>}
      />
      <p role="status">
        {selection.status === "invalid"
          ? "Use a decimal block height and a complete hash/publication pin. Hash-only lookup is not published by this explorer."
          : !configuration
            ? "Choose your network and API source to load this block."
            : configuration.status === "unsupported-network"
              ? "The modern explorer is not published for this selected network. No other network was queried."
              : "The selected API source must be a public HTTPS origin or a local development origin."}
      </p>
      {configuration?.status === "invalid-origin" ? (
        <button type="button" className={actionClass} onClick={() => setApiBase(DEFAULT_API_BASE)}>
          Reset API source
        </button>
      ) : null}
      <RouterLink href="/chain/blocks">Back to published blocks</RouterLink>
    </AppShell>
  );
}

function PublishedBlock({
  scope,
  height,
  pins,
}: {
  scope: ModernExplorerScope;
  height: string;
  pins?: ModernBlockPins;
}) {
  const reader = useMemo(() => createV2ReadClient({ origin: scope.origin }), [scope.origin]);
  const [restart, setRestart] = useState(0);
  const block = useQuery({
    queryKey: [
      ...modernExplorerKey(scope, restart),
      "block",
      height,
      pins?.block_hash,
      pins?.publication_id,
    ],
    queryFn: ({ signal }) =>
      readModernBlock(reader, scope, height, pins, undefined, undefined, undefined, signal),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const {
    network: _network,
    height: _height,
    ...selectors
  } = blockDetailInput(scope, height, pins);
  const data = block.data;
  const absent = block.error instanceof V2ReadClientError && block.error.serverCode === "not_found";
  return (
    <AppShell dataProfile="modern">
      <ModernExplorerSources
        paths={[modernExplorerPath(scope, height, selectors)]}
        origin={scope.origin}
      />
      <EntityHero
        crumbs={[{ label: "Blocks", href: "/chain/blocks" }]}
        name={`Block ${height}`}
        sentence={
          <FactSentence>
            {data
              ? `${data.extrinsic_count} extrinsics · ${data.event_count} events. Published evidence observed ${formatAbsoluteTime(data.snapshot.observed_at)}.`
              : "Inspect this published block's decoded record."}
          </FactSentence>
        }
      />
      {block.isPending ? <p role="status">Loading published block evidence.</p> : null}
      {absent ? (
        <p role="status">No published block matches this height.</p>
      ) : block.isError ? (
        <ErrorState
          error={modernExplorerFailure()}
          context="this published block"
          onRetry={() => void block.refetch()}
        />
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <button
          type="button"
          className={actionClass}
          onClick={() => setRestart((value) => value + 1)}
        >
          {pins ? "Retry pinned block" : "Reload block"}
        </button>
        <RouterLink href="/chain/blocks">Restart from latest blocks</RouterLink>
      </div>
      {data ? (
        <>
          <p className="mb-4 text-13 text-ink-muted">
            This record is pinned to its block hash and publication. Observation time describes the
            captured publication; it does not establish current chain freshness.
          </p>
          <Raw
            defaultOpen
            title="Published block identity"
            rows={[
              { label: "Block hash", value: data.snapshot.block_hash },
              { label: "Parent hash", value: data.snapshot.parent_hash },
              { label: "Publication", value: data.snapshot.publication_id },
              { label: "Source capture digest", value: data.source_capture_digest },
              { label: "Metadata digest", value: data.snapshot.metadata_digest },
              { label: "Runtime spec version", value: String(data.snapshot.spec_version) },
              { label: "Transaction version", value: String(data.snapshot.transaction_version) },
              {
                label: "Published at",
                value: formatAbsoluteTime(data.snapshot.published_at) ?? data.snapshot.published_at,
              },
            ]}
          />
          <BlockCollection
            key={`extrinsics:${restart}:${data.snapshot.publication_id}`}
            scope={scope}
            reader={reader}
            first={data}
            collection="extrinsics"
            restart={restart}
          />
          <BlockCollection
            key={`events:${restart}:${data.snapshot.publication_id}`}
            scope={scope}
            reader={reader}
            first={data}
            collection="events"
            restart={restart}
          />
        </>
      ) : null}
    </AppShell>
  );
}

function BlockCollection({
  scope,
  reader,
  first,
  collection,
  restart,
}: {
  scope: ModernExplorerScope;
  reader: ReturnType<typeof createV2ReadClient>;
  first: ModernBlock;
  collection: "events" | "extrinsics";
  restart: number;
}) {
  const height = first.snapshot.block_number;
  const pins = {
    block_hash: first.snapshot.block_hash,
    publication_id: first.snapshot.publication_id,
  };
  const query = useInfiniteQuery({
    queryKey: [
      ...modernExplorerKey(scope, restart),
      "block",
      height,
      pins.block_hash,
      pins.publication_id,
      collection,
    ],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      pageParam === undefined
        ? Promise.resolve(first)
        : readModernBlock(reader, scope, height, pins, first, collection, pageParam, signal),
    getNextPageParam: (last) =>
      (collection === "events" ? last.next_event_index : last.next_extrinsic_index) ?? undefined,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const pages = query.data?.pages ?? [first];
  const cursors = query.data?.pageParams ?? [undefined];
  const paths = cursors.map((after) => {
    if (
      after !== undefined &&
      (typeof after !== "number" || !Number.isInteger(after) || after < 0 || after > 65535)
    ) {
      throw modernExplorerFailure();
    }
    const {
      network: _network,
      height: _height,
      ...selectors
    } = blockDetailInput(scope, height, pins, collection, after);
    return modernExplorerPath(scope, height, selectors);
  });
  useRegisterApiSource(paths, [], scope.origin);
  const events = pages.flatMap((page) => page.events);
  const extrinsics = pages.flatMap((page) => page.extrinsics);
  const total = collection === "events" ? first.event_count : first.extrinsic_count;
  const shown = collection === "events" ? events.length : extrinsics.length;
  return (
    <AnalyticsSection
      id={collection}
      name={collection === "events" ? "Events" : "Extrinsics"}
      question={`${shown} of ${total} published ${collection}.`}
    >
      {collection === "events" ? (
        <ol className="space-y-4">
          {events.map((event) => (
            <li
              key={event.event_index}
              className="min-w-0 rounded border border-border p-3"
              data-event-index={event.event_index}
            >
              <h3 className="text-15 font-medium">
                Event #{event.event_index} · {event.pallet}.{event.variant}
              </h3>
              <p className="mt-2 text-13">
                Phase: {event.phase} ·{" "}
                {event.extrinsic_index === null
                  ? "No originating extrinsic"
                  : `Originating extrinsic #${event.extrinsic_index}`}
              </p>
              <p className="mt-2 text-13">
                Topics:{" "}
                {event.topics.length
                  ? event.topics.map((topic) => (
                      <code key={topic} className="block break-all">
                        {topic}
                      </code>
                    ))
                  : "None"}
              </p>
              <p className="mt-2 text-13">
                Participants: {event.participants.length ? null : "None"}
              </p>
              <ul>
                {event.participants.map((participant) => (
                  <li key={participant.participant_index} className="text-13">
                    {participant.role} ·{" "}
                    <RouterLink href={chainAccountHref(participant.account_id)!}>
                      <code className="break-all">{participant.account_id}</code>
                    </RouterLink>
                  </li>
                ))}
              </ul>
              <Raw defaultOpen title={`Event #${event.event_index} fields`}>
                <RawCode label={`Event #${event.event_index} fields`}>
                  {JSON.stringify(event.fields, null, 2)}
                </RawCode>
              </Raw>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="space-y-4">
          {extrinsics.map((extrinsic) => (
            <li
              key={extrinsic.extrinsic_index}
              className="min-w-0 rounded border border-border p-3"
              data-extrinsic-index={extrinsic.extrinsic_index}
            >
              <h3 className="text-15 font-medium">
                Extrinsic #{extrinsic.extrinsic_index} · {extrinsic.pallet}.{extrinsic.call}
              </h3>
              <p className="mt-2 break-all text-13">
                <code>{extrinsic.extrinsic_hash}</code>
              </p>
              <p className="mt-2 text-13">{extrinsic.is_signed ? "Signed" : "Unsigned"}</p>
              <Raw defaultOpen title={`Extrinsic #${extrinsic.extrinsic_index} decoded fields`}>
                <RawCode label={`Extrinsic #${extrinsic.extrinsic_index} fields`}>
                  {JSON.stringify(extrinsic.fields, null, 2)}
                </RawCode>
                {extrinsic.is_signed ? (
                  <RawCode label={`Extrinsic #${extrinsic.extrinsic_index} signer`}>
                    {JSON.stringify(extrinsic.signer, null, 2)}
                  </RawCode>
                ) : null}
              </Raw>
            </li>
          ))}
        </ol>
      )}
      {total === 0 ? <p role="status">This published block contains no {collection}.</p> : null}
      {query.isError ? (
        <>
          <ErrorState error={modernExplorerFailure()} context={`block ${collection}`} />
          <p role="status">
            Accepted rows retained. Restart from latest blocks if this publication changed.
          </p>
        </>
      ) : null}
      {query.hasNextPage ? (
        <button
          type="button"
          className={`mt-3 ${actionClass}`}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? `Loading ${collection}…` : `Load more ${collection}`}
        </button>
      ) : null}
    </AnalyticsSection>
  );
}
