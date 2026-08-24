import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AnalyticsSection,
  CopyableCode,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  LoadMore,
  MarkerRail,
  RangeControl,
  RankedRails,
  Raw,
  SectionNav,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatAbsoluteTime, formatNumber } from "@/lib/metagraphed/format";
import {
  endpointIncidentsQuery,
  endpointsInfiniteQuery,
  endpointsSummaryQuery,
  rpcPoolsQuery,
} from "@/lib/metagraphed/queries";
import { apisNav } from "@/components/metagraphed/apis/apis-logic";
import { hostOf } from "@/components/metagraphed/providers/providers-logic";
import {
  LATENCY_VIEWS,
  endpointFacts,
  endpointRows,
  facet,
  filterEndpoints,
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

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/**
 * Endpoints (#11623) — four sections.
 *
 * What went: a four-tab strip (`Directory / Managed RPC / Pools / Incidents`),
 * four summary count cards, four more `DEGRADED NOW / OPEN INCIDENTS /
 * SLOWEST ARCHIVE / FRESHLY PROBED` cards, nine `AsyncPanel`s, thirty-five
 * bordered boxes, an incident banner, a `Share view` button and a Grid view
 * that was a second rendering of the table. The tabs were four answers to one
 * question, so they are four sections of one page.
 *
 * The managed-proxy tab is one copyable URL in the Pools footnote: it was a
 * whole tab to say "point your client here", and the pools rail is the part a
 * caller actually needs before doing so.
 */
export function EndpointsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/apis/endpoints" });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  /**
   * The facets go to the SERVER; only the free-text one stays here.
   *
   * /api/v1/endpoints caps `limit` at 1,000 against a 3,391-row fleet and
   * takes `status`, `kind` and `provider`, so filtering a loaded page
   * client-side would answer "how many degraded" from the first thousand rows.
   * It has no text search, so `q` is the one filter applied to the rows in
   * hand, and the section footnote says how many are in hand.
   */
  const serverParams: Record<string, string | number> = { limit: 200 };
  if (search.status && search.status !== "monitored") serverParams.status = search.status;
  if (search.kind) serverParams.kind = search.kind;
  if (search.provider) serverParams.provider = search.provider;

  const feed = useInfiniteQuery({ ...endpointsInfiniteQuery(serverParams), retry: 0 });
  const summaryQuery = useQuery({ ...endpointsSummaryQuery(), retry: 0 });
  const pools = useQuery({ ...rpcPoolsQuery(), retry: 0 });
  const incidents = useQuery({ ...endpointIncidentsQuery(), retry: 0 });
  const rows = useMemo(
    () => endpointRows((feed.data?.pages ?? []).flatMap((page) => page.data)),
    [feed.data],
  );
  const poolList = useMemo(() => poolRows(pools.data?.data), [pools.data]);
  const incidentList = useMemo(() => incidentRows(incidents.data?.data), [incidents.data]);

  const summary = summaryQuery.data?.data;
  const shown = useMemo(() => filterEndpoints(rows, search), [rows, search]);
  const kinds = useMemo(() => facet(rows, (row) => row.kind), [rows]);
  const providers = useMemo(() => facet(rows, (row) => row.provider), [rows]);
  const rails = useMemo(
    () => latencyRails(rows, search.latency as LatencyView),
    [rows, search.latency],
  );
  const openIncidents = useMemo(() => incidentList.filter((row) => row.open), [incidentList]);
  const shownIncidents = search.incidents === "open" ? openIncidents : incidentList;

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
      label: "p50",
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
    <dl>
      {row.url ? (
        <div className="mg-raw-row">
          <dt>URL</dt>
          <dd>{row.url}</dd>
        </div>
      ) : null}
      <div className="mg-raw-row">
        <dt>Pool</dt>
        <dd>{row.poolEligible ? "eligible" : "not eligible"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Archive</dt>
        <dd>{row.archive ? "serves archive state" : "recent state only"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Auth</dt>
        <dd>{row.authRequired ? "a key is required" : "open"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last ok</dt>
        <dd>{row.lastOk ? formatAbsoluteTime(row.lastOk) : "never answered"}</dd>
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
        name="Endpoints"
        sentence={
          <FactSentence>What the registry can reach, and how it answered last time.</FactSentence>
        }
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={
          factCells(
            endpointFacts(
              summary as Parameters<typeof endpointFacts>[0],
              poolList.length,
              openIncidents.length,
              { count: formatNumber },
            ),
          ) ?? undefined
        }
        live={{
          updatedAt: summary?.observed_at ?? rows[0]?.lastChecked ?? null,
          source: "probed every 15 min",
          onRefresh: () => void feed.refetch(),
          refreshing: feed.isFetching,
        }}
      />
      <SectionNav items={apisNav(pathname)} link={RouterLink} />

      <AnalyticsSection
        id="pools"
        name="Pools"
        question="The managed RPC pools, and how much of each can be routed to."
        visual={
          poolList.length > 0 ? (
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
              columns={{ ratio: "Ready", name: "Pool", scale: "Members that can be routed to" }}
              ariaLabel="RPC pool readiness"
              source="rpc-pool"
            />
          ) : null
        }
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
        footnote="eligible ÷ members · p50 is the median of members that reported one · probe-derived"
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
          rails.length > 0 ? (
            <RankedRails
              items={rails}
              formatValue={(value: number) => `${formatNumber(value)} ms`}
              scale="sqrt"
              columns={{ value: "p50", name: "Provider · kind", track: "Last probe" }}
              ariaLabel="Endpoint latency"
              source="endpoint-latency"
            />
          ) : null
        }
        // Only endpoints that REPORTED a latency are ranked: `latency_ms: null`
        // means unmeasured, and ranking it as 0 would put every dead endpoint
        // at the top of "fastest".
        footnote="measured endpoints only · probe-derived"
      />

      <AnalyticsSection
        id="directory"
        name="Directory"
        question="Every endpoint the registry knows about."
        visual={
          <DataTable
            id="directory"
            rows={shown}
            columns={columns}
            rowKey={(row) => row.id}
            caption="Endpoints"
            link={RouterLink}
            source="endpoint"
            storageKey="mg-endpoints-columns"
            expand={endpointDetail}
            loading={feed.isPending}
            search={{
              value: search.q,
              onChange: (q) => setSearch({ q }),
              placeholder: "Endpoint, provider or kind",
            }}
            filters={
              <>
                <FilterField label="Status">
                  <FilterSelect
                    value={search.status}
                    onChange={(event) => setSearch({ status: event.target.value })}
                  >
                    <option value="">Any status</option>
                    <option value="monitored">Monitored only</option>
                    <option value="ok">ok</option>
                    <option value="degraded">degraded</option>
                    <option value="failed">failed</option>
                    <option value="unknown">unknown</option>
                  </FilterSelect>
                </FilterField>
                <FilterField label="Kind">
                  <FilterSelect
                    value={search.kind}
                    onChange={(event) => setSearch({ kind: event.target.value })}
                  >
                    <option value="">Any kind</option>
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </FilterSelect>
                </FilterField>
                <FilterField label="Provider">
                  <FilterSelect
                    value={search.provider}
                    onChange={(event) => setSearch({ provider: event.target.value })}
                  >
                    <option value="">Any provider</option>
                    {providers.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </FilterSelect>
                </FilterField>
              </>
            }
            empty="No endpoints match these filters."
          />
        }
        legend={
          // Only while there IS more to fetch. The table states its own range
          // and total in the pager ("1-50 of 1,545"), so a terminal
          // "1545 of 1545 - end of list" strip directly beneath it was the
          // same fact twice, in two vocabularies (#11696). An error still
          // shows, because a feed that stopped early is not the end of a list.
          feed.hasNextPage || feed.error ? (
            <LoadMore
              hasMore={feed.hasNextPage}
              isLoading={feed.isFetchingNextPage}
              onLoadMore={() => void feed.fetchNextPage()}
              shown={rows.length}
              total={summary?.endpoint_count}
              error={feed.error}
            />
          ) : null
        }
        footnote={`${formatNumber(shown.length)} shown of ${formatNumber(
          summary?.endpoint_count ?? rows.length,
        )} tracked · facets applied server-side · probe-derived`}
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
          incidentList.length === openIncidents.length
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
