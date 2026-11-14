import { useMemo, useState } from "react";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, Raw, RawCode, type DataTableColumn } from "@jsonbored/ui-kit";
import { createV2ReadClient } from "../../../../../../src/v2/client.ts";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ss58AccountId } from "@/lib/metagraphed/accounts";
import { formatAbsoluteTime } from "@/lib/metagraphed/format";
import {
  MODERN_ACCOUNT_MAX_PAGES,
  modernAccountAnchor,
  modernAccountKey,
  modernAccountPath,
  modernBlockHref,
  ModernExplorerSources,
  readModernAccountEvents,
  useModernExplorerConfiguration,
  type ModernAccountContinuation,
  type ModernAccountEvents,
  type ModernExplorerScope,
} from "@/lib/metagraphed/modern-explorer";

type Activity = ModernAccountEvents["events"][number];
const actionClass =
  "inline-flex min-h-11 items-center justify-center rounded border border-border px-3 py-2 text-13 text-ink-strong disabled:opacity-60";
const columns: DataTableColumn<Activity>[] = [
  {
    key: "block",
    label: "Block",
    kind: "link",
    value: (row) => row.snapshot.block_number,
    href: modernBlockHref,
  },
  {
    key: "event",
    label: "Event",
    value: (row) => `#${row.event.event_index} ${row.event.pallet}.${row.event.variant}`,
  },
  { key: "phase", label: "Phase", value: (row) => row.event.phase },
  {
    key: "extrinsic",
    label: "Extrinsic",
    value: (row) => (row.event.extrinsic_index === null ? "None" : `#${row.event.extrinsic_index}`),
  },
  {
    key: "appearances",
    label: "Matching positions",
    value: (row) =>
      row.matching_participants.map((p) => `#${p.participant_index} ${p.role}`).join(" · "),
  },
  {
    key: "fields",
    label: "Decoded fields",
    value: (row) => JSON.stringify(row.event.fields),
    render: (row) => (
      <Raw title={`Event #${row.event.event_index} decoded fields`}>
        <RawCode label={`Event #${row.event.event_index} decoded fields`}>
          {JSON.stringify(row.event.fields, null, 2)}
        </RawCode>
      </Raw>
    ),
  },
];

/** One activity owner, bound to the selected source, chain, account and interval. */
export function ActivitySection({ ss58 }: { ss58: string }) {
  const configuration = useModernExplorerConfiguration();
  const accountId = ss58AccountId(ss58);
  if (configuration?.status === "ready" && accountId)
    return (
      <PublishedActivity
        key={JSON.stringify([configuration.scope, accountId])}
        scope={configuration.scope}
        accountId={accountId}
      />
    );
  const pending = accountId !== null && configuration === null;
  return (
    <AnalyticsSection
      id="activity"
      name="Activity"
      question="Published events containing this account."
      visual={
        pending ? (
          <DataTable
            rows={[]}
            columns={columns}
            rowKey={() => "pending"}
            caption="Account events"
            loading
            paginate={false}
            mobile="cards"
            dense
          />
        ) : (
          <p role="status">
            {accountId === null
              ? "This address has an invalid checksum or an unsupported account format. No account activity was queried."
              : configuration?.status === "unsupported-network"
                ? "Published account activity is unavailable for the selected network. No other network was queried."
                : "The selected API source must be a public HTTPS origin or a local development origin."}
          </p>
        )
      }
      footnote={
        pending
          ? "Choose your network and API source to load published account activity."
          : undefined
      }
    />
  );
}

function PublishedActivity({
  scope,
  accountId,
}: {
  scope: ModernExplorerScope;
  accountId: string;
}) {
  const { ref, nearViewport } = useNearViewport("320px 0px");
  const [restart, setRestart] = useState(0);
  const reader = useMemo(() => createV2ReadClient({ origin: scope.origin }), [scope.origin]);
  const feed = useInfiniteQuery<
    ModernAccountEvents,
    Error,
    InfiniteData<ModernAccountEvents, ModernAccountContinuation | null>,
    ReturnType<typeof modernAccountKey>,
    ModernAccountContinuation | null
  >({
    queryKey: modernAccountKey(scope, accountId, restart),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      readModernAccountEvents(reader, scope, accountId, pageParam ?? undefined, signal),
    getNextPageParam: (last) =>
      last.next_cursor === null
        ? undefined
        : { anchor: modernAccountAnchor(last), cursor: last.next_cursor },
    maxPages: MODERN_ACCOUNT_MAX_PAGES,
    gcTime: 0,
    enabled: nearViewport,
    retry: false,
    retryOnMount: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const pages = feed.data?.pages ?? [];
  const first = pages[0];
  const events = pages.flatMap((page) => page.events);
  const params = feed.data?.pageParams ?? [null];
  const paths = params.map((page) => modernAccountPath(scope, accountId, page?.cursor));
  const initialError = feed.isError && events.length === 0;
  const unavailable = new Error(
    "Published account activity is unavailable. Retry or restart from the latest publication.",
  );
  const coverage = first
    ? `blocks ${first.coverage.from_block}–${first.coverage.through_block}`
    : null;
  return (
    <>
      <ModernExplorerSources paths={paths} origin={scope.origin} />
      <AnalyticsSection
        id="activity"
        name="Activity"
        question="Published events containing this account."
        visualRef={ref}
        controls={
          <button
            type="button"
            className={actionClass}
            onClick={() => setRestart((value) => value + 1)}
          >
            Restart from latest activity
          </button>
        }
        visual={
          <>
            <DataTable
              rows={events}
              columns={columns}
              rowKey={(row) => `${row.snapshot.block_number}:${row.event.event_index}`}
              caption="Account events"
              link={RouterLink}
              source="published-account-event"
              paginate={false}
              loading={!nearViewport || feed.isPending}
              error={
                initialError ? (
                  <ErrorState
                    error={unavailable}
                    context="account events"
                    onRetry={() => void feed.refetch()}
                  />
                ) : undefined
              }
              empty={
                coverage
                  ? `No matching typed account appearances in published coverage ${coverage}.`
                  : "Account activity coverage has not been established."
              }
              mobile="cards"
              dense
              storageKey="published-account-events-columns"
            />
            {feed.isError && events.length > 0 ? (
              <>
                <p role="status">
                  Previously accepted account events retained. Restart to select a new publication
                  interval.
                </p>
                <ErrorState
                  error={unavailable}
                  context="older account events"
                  onRetry={() => void feed.fetchNextPage()}
                />
              </>
            ) : null}
            {feed.hasNextPage ? (
              <button
                type="button"
                className={`mt-3 ${actionClass}`}
                disabled={feed.isFetchingNextPage}
                onClick={() => void feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage
                  ? "Loading older account events…"
                  : "Load older account events"}
              </button>
            ) : null}
          </>
        }
        footnote={
          first ? (
            <>
              Published coverage {coverage}. Observation{" "}
              {formatAbsoluteTime(first.snapshot.observed_at)} · freshness {first.freshness.status}.{" "}
              Positions are metadata-derived labels, not economic or authorization roles. Up to{" "}
              {MODERN_ACCOUNT_MAX_PAGES} loaded pages are retained in this view; other account
              sections have separate observations.
            </>
          ) : !nearViewport ? (
            "Account activity loads when this section is near the viewport."
          ) : feed.isPending ? (
            "Loading published account activity."
          ) : (
            "Account activity coverage is unavailable."
          )
        }
      />
    </>
  );
}
