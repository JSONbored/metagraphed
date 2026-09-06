import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AnalyticsSection,
  CopyableCode,
  DataTable,
  EntityHero,
  FactSentence,
  FactStrip,
  FilterField,
  FilterSelect,
  LoadMore,
  MarkerRail,
  RangeControl,
  RankedRails,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { EndpointDirectoryControls } from "@/components/metagraphed/endpoints/endpoint-directory-controls";
import { ApiNavigation } from "@/components/metagraphed/apis/api-navigation";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatAbsoluteTime, formatNumber } from "@/lib/metagraphed/format";
import {
  endpointIncidentsQuery,
  endpointsInfiniteQuery,
  endpointsSummaryQuery,
  rpcPoolsQuery,
} from "@/lib/metagraphed/queries";
import { hostOf } from "@/components/metagraphed/providers/providers-logic";
import {
  LATENCY_VIEWS,
  ENDPOINT_SEARCH_MAX_LENGTH,
  endpointFacts,
  endpointMatchCount,
  endpointRows,
  facet,
  incidentRows,
  latencyRails,
  poolRows,
  type EndpointRow,
  type IncidentRow,
  type LatencyView,
} from "@/components/metagraphed/endpoints/endpoints-logic";
import { Route } from "./apis.endpoints";

const API_PATHS = ["/api/v1/endpoints", "/api/v1/rpc/pools", "/api/v1/endpoint-incidents"];
const PROXY_URL = `${API_BASE}/api/v1/rpc/proxy`;

// The latency rail, directory, filter facets, and expanded row each read one
// of these fields. Everything else in an endpoint record is either a
// collection-level summary (requested separately) or is not visible on this
// route. Keeping the projection here makes that payload contract auditable at
// the route that owns it rather than relying on the normalizer to discard data
// after it has already crossed the network.
const ENDPOINT_PAGE_FIELDS =
  "id,provider,operator,kind,url,netuid,subnet_name,subnet_slug,status,latency_ms,last_checked,last_ok,observed_at,archive_support,pool_eligible,auth_required";

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/** The endpoint directory leads; routing and probe diagnostics follow it. */
export function EndpointsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/apis/endpoints" });
  const [settledSearch, setSettledSearch] = useState(search.q);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledSearch(search.q), 150);
    return () => window.clearTimeout(timer);
  }, [search.q]);
  const searchWaiting = search.q !== settledSearch;
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
      hash: true,
    });

  // Search, facets and known status filter before server pagination. Keep
  // the legacy monitored URL value while giving it the canonical API meaning.
  const searchError =
    search.q.length > ENDPOINT_SEARCH_MAX_LENGTH
      ? "Search is too long. Use 200 characters or fewer."
      : undefined;
  const canSearch = !searchError && !searchWaiting;
  const serverParams: Record<string, string | number> = {
    limit: 200,
    fields: ENDPOINT_PAGE_FIELDS,
  };
  if (search.q) serverParams.q = search.q;
  if (search.status === "monitored") serverParams.known_status = "true";
  else if (search.status) serverParams.status = search.status;
  if (search.kind) serverParams.kind = search.kind;
  if (search.provider) serverParams.provider = search.provider;

  const feed = useInfiniteQuery({
    ...endpointsInfiniteQuery(serverParams),
    retry: 0,
    enabled: canSearch,
  });
  const directoryKey = JSON.stringify([search.q, search.status, search.kind, search.provider]);
  const retryFeed = () => {
    if (canSearch) void feed.refetch();
  };
  const loadNextPage = () => {
    if (canSearch) void feed.fetchNextPage();
  };
  const summaryQuery = useQuery({ ...endpointsSummaryQuery(), retry: 0 });
  const pools = useQuery({ ...rpcPoolsQuery(), retry: 0 });
  const incidents = useQuery({ ...endpointIncidentsQuery(), retry: 0 });
  const rows = useMemo(
    () =>
      searchWaiting ? [] : endpointRows((feed.data?.pages ?? []).flatMap((page) => page.data)),
    [feed.data, searchWaiting],
  );
  const poolList = useMemo(() => poolRows(pools.data?.data), [pools.data]);
  const incidentList = useMemo(() => incidentRows(incidents.data?.data), [incidents.data]);

  const summary = summaryQuery.data?.data;
  const knownStatus = search.status === "monitored";
  const matchedTotal = searchWaiting
    ? null
    : endpointMatchCount(feed.data?.pages.at(-1)?.meta?.pagination?.total);
  const resultScope = `${formatNumber(rows.length)} loaded${matchedTotal == null ? " · match count unavailable" : ` of ${formatNumber(matchedTotal)} matching`}`;
  const fleetScope = summary
    ? ` · ${formatNumber(summary.endpoint_count)} tracked across the fleet`
    : "";
  const kinds = useMemo(() => facet(rows, (row) => row.kind), [rows]);
  const providers = useMemo(() => facet(rows, (row) => row.provider), [rows]);
  const rails = useMemo(
    () => latencyRails(rows, search.latency as LatencyView),
    [rows, search.latency],
  );
  const openIncidents = useMemo(() => incidentList.filter((row) => row.open), [incidentList]);
  const shownIncidents = search.incidents === "open" ? openIncidents : incidentList;
  const fleetCells = factCells(
    endpointFacts(
      summary as Parameters<typeof endpointFacts>[0],
      pools.isPending || (pools.isError && !pools.data) ? null : poolList.length,
      incidents.isPending || (incidents.isError && !incidents.data) ? null : openIncidents.length,
      { count: formatNumber },
      { pools: pools.isPending, incidents: incidents.isPending },
    ),
  );
  const refreshAll = () => {
    void Promise.all([
      ...(canSearch ? [feed.refetch()] : []),
      summaryQuery.refetch(),
      pools.refetch(),
      incidents.refetch(),
    ]);
  };

  const columns: DataTableColumn<EndpointRow>[] = [
    {
      // The HOST leads, not the provider. A directory sorted by provider put
      // "opentensor" in the first cell of seven consecutive rows while the one
      // thing that told them apart -- the URL -- sat third, 711px wide, and
      // pushed Status, p50 and Last probe off the right edge of the card
      // (#11696). The scheme and path are in the row's detail, where they can
      // be copied; what a reader compares down a column is the host.
      key: "host",
      label: "Endpoint",
      kind: "link",
      width: 300,
      value: (row) => hostOf(row.url),
      href: (row) => row.url ?? undefined,
    },
    { key: "provider", label: "Provider", width: 150, value: (row) => row.provider },
    { key: "kind", label: "Kind", kind: "status", width: 140, value: (row) => row.kind },
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 100,
      value: (row) => row.netuid,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    { key: "status", label: "Status", kind: "status", width: 110, value: (row) => row.status },
    {
      key: "latency",
      label: "Latency",
      kind: "number",
      align: "right",
      width: 100,
      value: (row) => row.latencyMs,
      format: (value) => (typeof value === "number" ? `${formatNumber(value)} ms` : "—"),
    },
    {
      key: "probed",
      label: "Last probe",
      kind: "time",
      width: 120,
      value: (row) => row.lastChecked,
    },
  ];

  const incidentColumns: DataTableColumn<IncidentRow>[] = [
    {
      // The lead column, because it is the only one that identifies the row:
      // without it three concurrent opentensor RPC incidents were three
      // identical lines (#11693).
      key: "surface",
      label: "Endpoint",
      kind: "identifier",
      width: 260,
      value: (row) => row.surface,
    },
    { key: "detected", label: "Started", kind: "time", width: 130, value: (row) => row.detectedAt },
    { key: "provider", label: "Provider", width: 170, value: (row) => row.provider },
    { key: "kind", label: "Kind", kind: "status", width: 150, value: (row) => row.kind },
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 110,
      value: (row) => row.netuid,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    { key: "reason", label: "Reason", value: (row) => row.reason },
  ];

  /**
   * What a row carries but does not compare.
   *
   * The full URL, whether the endpoint is pool-eligible, whether it serves
   * archive state, whether it needs a key, and when it last answered. Four of
   * those were `demote`d columns -- present in the ⋯ menu, invisible until a
   * reader went looking, and each one widening the table when turned on. A
   * value you copy or check once belongs under its row, not in a column
   * competing for width with the six a reader scans (#11696).
   */
  const endpointDetail = (row: EndpointRow) => (
    <dl className="mg-endpoint-detail">
      <div className="mg-raw-row">
        <dt>Provider</dt>
        <dd>{row.provider ?? "unknown"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Kind</dt>
        <dd>{row.kind ?? "unknown"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Subnet</dt>
        <dd>
          {row.netuid == null ? (
            "not recorded"
          ) : (
            <RouterLink href={`/subnets/${row.netuid}`}>SN{row.netuid}</RouterLink>
          )}
        </dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last probe</dt>
        <dd>{row.lastChecked ? formatAbsoluteTime(row.lastChecked) : "no probe recorded"}</dd>
      </div>
      {row.url ? (
        <div className="mg-raw-row">
          <dt>URL</dt>
          <dd>
            <CopyableCode
              value={row.url}
              label="endpoint URL"
              truncate={false}
              className="min-h-11"
            />
          </dd>
        </div>
      ) : null}
      <div className="mg-raw-row">
        <dt>Pool</dt>
        <dd>
          {row.poolEligible == null
            ? "eligibility unknown"
            : row.poolEligible
              ? "eligible"
              : "not eligible"}
        </dd>
      </div>
      <div className="mg-raw-row">
        <dt>Archive</dt>
        <dd>
          {row.archive == null
            ? "support unknown"
            : row.archive
              ? "serves archive state"
              : "archive not supported"}
        </dd>
      </div>
      <div className="mg-raw-row">
        <dt>Auth</dt>
        <dd>
          {row.authRequired == null
            ? "requirement unknown"
            : row.authRequired
              ? "a key is required"
              : "open"}
        </dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last ok</dt>
        <dd>{row.lastOk ? formatAbsoluteTime(row.lastOk) : "no successful probe recorded"}</dd>
      </div>
    </dl>
  );

  /** The same reasoning for an incident: what it was, not what it is. */
  const incidentDetail = (row: IncidentRow) => (
    <dl>
      <div className="mg-raw-row">
        <dt>Severity</dt>
        <dd>{row.severity ?? "—"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>State</dt>
        <dd>{row.open ? "open" : "resolved"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Probe</dt>
        <dd>{row.health ?? "—"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last probe</dt>
        <dd>{row.lastChecked ? formatAbsoluteTime(row.lastChecked) : "—"}</dd>
      </div>
    </dl>
  );

  const rawRows: RawRow[] = [
    { label: "managed RPC proxy", value: PROXY_URL, href: PROXY_URL },
    ...API_PATHS.map((path) => ({
      label: path.replace("/api/v1/", ""),
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--directory"
        name="Endpoints"
        sentence={
          <FactSentence>
            Find an endpoint, check its latest probe and copy the exact URL.
          </FactSentence>
        }
        live={{
          updatedAt: summary?.observed_at ?? rows[0]?.lastChecked ?? null,
          source: "recorded probes",
          onRefresh: refreshAll,
          refreshing:
            feed.isFetching || summaryQuery.isFetching || pools.isFetching || incidents.isFetching,
        }}
      />
      <ApiNavigation />

      <AnalyticsSection
        id="directory"
        className="mg-directory-section mg-directory-section--table-first"
        name="Directory"
        question="Every endpoint the registry knows about."
        visual={
          <>
            <EndpointDirectoryControls
              search={search}
              kinds={kinds}
              providers={providers}
              onChange={setSearch}
              searchError={searchError}
            />
            <DataTable
              key={directoryKey}
              id="directory"
              className="mg-endpoint-directory"
              mobile="cards"
              rows={rows}
              columns={columns}
              rowKey={(row) => row.id}
              caption="Endpoints"
              captionCount={searchError ? null : matchedTotal}
              link={RouterLink}
              source="endpoint"
              storageKey="mg-endpoints-columns"
              expand={endpointDetail}
              loading={(feed.isPending || searchWaiting) && !searchError}
              error={
                canSearch && feed.isError ? (
                  <ErrorState error={feed.error} onRetry={retryFeed} context="tracked endpoints" />
                ) : undefined
              }
              empty={
                searchError
                  ? "Shorten the search to show endpoint results."
                  : search.q.trim()
                    ? "No endpoints match this search."
                    : "No endpoints match these filters."
              }
            />
          </>
        }
        legend={
          // Only while there IS more to fetch. The table states its own range
          // and total in the pager ("1-50 of 1,545"), so a terminal
          // "1545 of 1545 - end of list" strip directly beneath it was the
          // same fact twice, in two vocabularies (#11696). An error still
          // shows, because a feed that stopped early is not the end of a list.
          !canSearch ? null : feed.isRefetchError && rows.length > 0 ? (
            <ErrorState error={feed.error} onRetry={retryFeed} context="endpoint refresh" />
          ) : feed.hasNextPage || (feed.error && rows.length > 0) ? (
            <LoadMore
              hasMore={feed.hasNextPage}
              isLoading={feed.isFetchingNextPage}
              onLoadMore={loadNextPage}
              shown={rows.length}
              total={matchedTotal ?? undefined}
              error={feed.error}
            />
          ) : null
        }
        footnote={
          searchError
            ? "Search needs attention · endpoint results have not been requested"
            : searchWaiting
              ? "Waiting for search input · results update shortly"
              : feed.isPending
                ? "Searching the endpoint catalog · probe-derived"
                : feed.isError
                  ? rows.length > 0
                    ? "Refresh failed · previously loaded endpoints remain visible · probe-derived"
                    : "Endpoint results are temporarily unavailable · probe-derived"
                  : `${resultScope}${fleetScope} · probe-derived${knownStatus ? " · known status; freshness varies" : ""}`
        }
      />

      <AnalyticsSection
        id="fleet"
        name="Fleet observations"
        question="The recorded probe coverage and routing context."
        visual={fleetCells ? <FactStrip cells={fleetCells} /> : null}
        legend={
          summaryQuery.isError ? (
            <ErrorState
              error={summaryQuery.error}
              onRetry={() => void summaryQuery.refetch()}
              context="endpoint fleet observations"
            />
          ) : undefined
        }
        empty={false}
        footnote={
          summaryQuery.isPending
            ? "Loading fleet observations"
            : "Health reflects measured endpoints · unknown status is separate from a successful probe"
        }
      />

      <AnalyticsSection
        id="pools"
        name="Pools"
        question="The managed RPC pools, and how much of each can be routed to."
        visual={
          pools.isPending ? (
            <MarkerRail
              items={[]}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Eligible", name: "Pool", scale: "Observed eligible members" }}
              ariaLabel="RPC pool readiness"
              source="rpc-pool"
              loading
              loadingRows={5}
            />
          ) : pools.isError ? (
            <ErrorState
              error={pools.error}
              onRetry={() => void pools.refetch()}
              context="managed RPC pools"
            />
          ) : poolList.length > 0 ? (
            <MarkerRail
              items={poolList.map((pool) => ({
                key: pool.id,
                label: pool.id,
                value: pool.readiness,
                detail: `${formatNumber(pool.eligible)}/${formatNumber(pool.members)} eligible${
                  pool.archive > 0 ? ` · ${formatNumber(pool.archive)} archive` : ""
                }${pool.p50 == null ? "" : ` · p50 ${formatNumber(pool.p50)} ms`}`,
              }))}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Eligible", name: "Pool", scale: "Observed eligible members" }}
              ariaLabel="RPC pool readiness"
              source="rpc-pool"
            />
          ) : null
        }
        empty={pools.isPending ? false : "No managed RPC pools are published."}
        // Readiness, not health: a member can be up and still ineligible --
        // behind on blocks, missing an RPC method, rate-limited -- and what a
        // caller needs before pointing a client at a pool is how many members
        // it can actually be routed to.
        legend={
          <p className="mg-section-note">
            Point a client at the managed proxy and it routes to the best eligible member:{" "}
            <CopyableCode value={PROXY_URL} className="max-w-full" />
          </p>
        }
        footnote="observed eligible ÷ recorded members · pool p50 is the median of reported member latencies · probe-derived"
      />

      <AnalyticsSection
        id="latency"
        name="Latency"
        question="How long the last probe took, at the ends of the distribution."
        controls={
          <RangeControl
            label="View"
            options={LATENCY_VIEWS}
            value={search.latency}
            onChange={(latency) => setSearch({ latency })}
          />
        }
        visual={
          (feed.isPending || searchWaiting) && !searchError ? (
            <RankedRails
              items={[]}
              formatValue={(value: number) => `${formatNumber(value)} ms`}
              scale="sqrt"
              columns={{ value: "Latency", name: "Provider · kind", track: "Last probe" }}
              ariaLabel="Endpoint latency"
              source="endpoint-latency"
              loading
              loadingRows={8}
            />
          ) : canSearch && feed.isError && rows.length === 0 ? (
            <ErrorState error={feed.error} onRetry={retryFeed} context="endpoint latency" />
          ) : rails.length > 0 ? (
            <RankedRails
              items={rails}
              formatValue={(value: number) => `${formatNumber(value)} ms`}
              scale="sqrt"
              columns={{ value: "Latency", name: "Provider · kind", track: "Last probe" }}
              ariaLabel="Endpoint latency"
              source="endpoint-latency"
            />
          ) : null
        }
        empty={
          searchError
            ? "Shorten the search to load endpoint latency."
            : feed.isPending || searchWaiting
              ? false
              : "No endpoints reported latency for this view."
        }
        // Only endpoints that REPORTED a latency are ranked: `latency_ms: null`
        // means unmeasured, and ranking it as 0 would put every dead endpoint
        // at the top of "fastest".
        footnote={
          feed.isError && rows.length > 0
            ? "Refresh failed · previous measured endpoints remain visible · probe-derived"
            : "last recorded latency per endpoint · measured endpoints in loaded search results · probe-derived"
        }
      />

      <AnalyticsSection
        id="incidents"
        name="Incidents"
        question="What is failing, and what was."
        visual={
          <DataTable
            id="incidents"
            rows={shownIncidents}
            columns={incidentColumns}
            rowKey={(row) => row.id}
            caption="Endpoint incidents"
            link={RouterLink}
            source="endpoint-incident"
            storageKey="mg-incidents-columns"
            expand={incidentDetail}
            loading={incidents.isPending}
            error={
              incidents.isError ? (
                <ErrorState
                  error={incidents.error}
                  onRetry={() => void incidents.refetch()}
                  context="endpoint incidents"
                />
              ) : undefined
            }
            filters={
              <FilterField label="State">
                <FilterSelect
                  value={search.incidents}
                  onChange={(event) => setSearch({ incidents: event.target.value })}
                >
                  <option value="open">Open now</option>
                  <option value="all">All recorded</option>
                </FilterSelect>
              </FilterField>
            }
            empty={
              search.incidents === "open"
                ? "No endpoint incidents are open."
                : "No endpoint incidents have been recorded."
            }
          />
        }
        footnote={
          incidents.isPending
            ? "Loading recorded incidents · probe-derived"
            : incidents.isError
              ? "Recorded incidents are temporarily unavailable · probe-derived"
              : incidentList.length === openIncidents.length
                ? `${formatNumber(openIncidents.length)} recorded, all still open · probe-derived`
                : `${formatNumber(openIncidents.length)} open of ${formatNumber(
                    incidentList.length,
                  )} recorded · probe-derived`
        }
      />

      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis/endpoints" />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
