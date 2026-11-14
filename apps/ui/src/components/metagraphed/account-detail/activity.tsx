import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  DataTable,
  FilterField,
  FilterSelect,
  LoadMore,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { accountEventsInfiniteQuery } from "@/lib/metagraphed/queries";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";
import type { AccountEvent } from "@/lib/metagraphed/types";
import { EVENT_SCAN_CAP, eventKindOptions, fmtTao } from "./account-detail-logic";

const PAGE = 100;

/**
 * Section 4 — every first-party event, newest first.
 *
 * One table replaces the Transfers / Activity / Extrinsics tabs: they were
 * three filtered views of one stream, and a reader had to guess which tab
 * held the row they remembered. The kind filter is now the thing that used
 * to be a tab, and it is a control rather than a navigation.
 */
export function ActivitySection({
  ss58,
  nameOf,
  kinds,
  eventCount,
  summaryPending,
  scanCapped,
}: {
  ss58: string;
  nameOf: (netuid: number) => string;
  kinds: readonly { kind: string; count: number }[];
  eventCount: number | null;
  summaryPending: boolean;
  scanCapped: boolean;
}) {
  const [kind, setKind] = useState("");
  const { ref, nearViewport } = useNearViewport("320px 0px");

  const query = useInfiniteQuery({
    ...accountEventsInfiniteQuery(ss58, { limit: PAGE, ...(kind ? { kind } : {}) }),
    enabled: nearViewport,
    retry: 0,
  });

  const events = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data],
  );
  const initialError = query.isError && events.length === 0;

  const columns: DataTableColumn<AccountEvent>[] = [
    { key: "observed_at", label: "When", kind: "time", value: (row) => row.observed_at ?? null },
    { key: "event_kind", label: "Kind", kind: "status", value: (row) => row.event_kind ?? "—" },
    {
      key: "netuid",
      label: "Subnet",
      kind: "link",
      value: (row) => (typeof row.netuid === "number" ? nameOf(row.netuid) : "—"),
      href: (row) => (typeof row.netuid === "number" ? `/subnets/${row.netuid}` : undefined),
    },
    {
      key: "amount_tao",
      label: "Amount",
      kind: "number",
      value: (row) => row.amount_tao ?? null,
      format: (value) => (typeof value === "number" ? fmtTao(value, 4) : "—"),
    },
    {
      key: "hotkey",
      label: "Hotkey",
      kind: "identifier",
      value: (row) => row.hotkey ?? "—",
      demote: true,
    },
    {
      key: "block_number",
      label: "Block",
      kind: "link",
      value: (row) => (row.block_number == null ? "—" : String(row.block_number)),
      href: (row) => (row.block_number == null ? undefined : `/blocks/${row.block_number}`),
    },
  ];

  return (
    <AnalyticsSection
      id="activity"
      name="Activity"
      question="Every first-party event, newest first."
      visualRef={ref}
      controls={
        <FilterField label="Kind">
          <FilterSelect value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Any kind</option>
            {eventKindOptions(kinds).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FilterSelect>
        </FilterField>
      }
      visual={
        <>
          <DataTable
            rows={events}
            columns={columns}
            rowKey={(row) => `${row.block_number}-${row.event_index}`}
            caption="Account events"
            link={RouterLink}
            source="account-event"
            paginate={false}
            loading={!nearViewport || query.isPending}
            error={
              initialError ? (
                <ErrorState
                  error={query.error}
                  onRetry={() => void query.refetch()}
                  context="account events"
                />
              ) : undefined
            }
            empty="No events match this filter."
            mobile="cards"
            dense
            storageKey="account-events-columns"
          />
          {/* A cursor feed has no terminal range to repeat beneath the table. */}
          {query.hasNextPage || (query.error && events.length > 0) ? (
            <LoadMore
              hasMore={Boolean(query.hasNextPage)}
              isLoading={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
              shown={events.length}
              total={kind ? undefined : (eventCount ?? undefined)}
              error={query.error as Error | null}
            />
          ) : null}
        </>
      }
      footnote={
        !nearViewport
          ? "newest-first account event ledger · chain-direct"
          : query.isPending
            ? "Loading account events · chain-direct"
            : initialError
              ? "Account events are temporarily unavailable · chain-direct"
              : scanCapped
                ? `More than ${formatNumber(EVENT_SCAN_CAP)} events: the summary above describes the scanned prefix, not the whole account. This feed is complete — page through it.`
                : eventCount === null
                  ? `${formatNumber(events.length)} loaded · account total ${summaryPending ? "loading" : "unavailable"} · chain-direct`
                  : `${formatNumber(eventCount)} events · chain-direct`
      }
    />
  );
}
