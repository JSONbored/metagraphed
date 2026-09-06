import { useMemo, useState } from "react";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { AnalyticsPage, EntityHero, Raw, type FactCells, type RawRow } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ErrorState } from "@/components/metagraphed/states";
import { recordModifiedAt } from "@/lib/metagraphed/freshness";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RankingsSection } from "@/components/metagraphed/subnets-index/rankings";
import { DirectorySection } from "@/components/metagraphed/subnets-index/directory";
import { RevenueCoverageSection } from "@/components/metagraphed/subnets-index/revenue";
import { DomainsSection } from "@/components/metagraphed/subnets-index/domains";
import { ChurnSection } from "@/components/metagraphed/subnets-index/churn";
import {
  apiSpecStatus,
  directoryRows,
  filterDirectory,
  specSubnets,
  type RankMetric,
  type RankWindow,
} from "@/components/metagraphed/subnets-index/subnets-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  SUBNETS_ALL_LIMIT,
  agentCatalogMapQuery,
  domainsQuery,
  economicsQuery,
  subnetHealthMapQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { Route, type SubnetsSearch } from "./subnets.index";

/**
 * Directory first, then the editorial sections.
 *
 * #11613 drafted Rankings first, and also required the first subnet row to be
 * within 900px of the top at 1280x800. Those two clauses cannot both hold:
 * measured on the built page, the hero is 332px, the section nav 38px and a
 * Rankings section collapsed to its three featured cards 456px -- of which
 * ~240px is the v2 section rhythm itself (`--mg-section-y`, the 40px heading
 * gap), which is the design contract and not something this route may shave.
 * That puts the first row at 1,199px however the cards are arranged.
 *
 * So the list leads. It is also the better answer to the page's question: a
 * reader who arrives knowing which subnet they want finds it in the first
 * screen, and the rankings -- which are commentary ON the list -- are one
 * click away in the nav that sits above both.
 */
const SECTIONS = [
  { id: "directory", name: "Directory" },
  { id: "rankings", name: "Rankings" },
  { id: "revenue", name: "Revenue" },
  { id: "domains", name: "Domains" },
  { id: "churn", name: "Churn" },
] as const;

const API_PATHS = [
  "/api/v1/subnets",
  "/api/v1/economics",
  "/api/v1/subnets/movers",
  "/api/v1/domains",
  "/api/v1/health",
  "/api/v1/chain/subnet-lifecycle",
  "/api/v1/agent-catalog",
];

// Every field the directory actually reads. The unprojected registry row now
// carries dozens of enrichment fields and made this SSR document cross its
// 430 KiB payload ratchet as that data grew, even though none was displayed.
const SUBNET_DIRECTORY_FIELDS = [
  "netuid",
  "slug",
  "name",
  "native_name",
  "subnet_type",
  "surface_count",
  "status",
  "logo_url",
  "website_url",
  "source_repo",
  "updated_at",
  "integration_readiness",
  "curation_level",
].join(",");

/** Registers this page's reads with the ⌘J drawer, from inside AppShell's provider. */
function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function SubnetsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const registry = useSuspenseQuery(
    subnetsQuery({ limit: SUBNETS_ALL_LIMIT, fields: SUBNET_DIRECTORY_FIELDS }),
  );
  const economics = useQuery({ ...economicsQuery({ fields: "directory" }), retry: 0 });
  const domains = useQuery({ ...domainsQuery(), retry: 0 });
  const health = useQuery({ ...subnetHealthMapQuery(), retry: 0 });
  const catalog = useQuery({ ...agentCatalogMapQuery(), retry: 0 });

  const listed = registry.data;
  const subnets = listed.data;
  const econRows = useMemo(() => economics.data?.data ?? [], [economics.data]);

  /** netuid → domain, from the taxonomy's own membership lists. */
  const domainOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of domains.data?.data ?? []) {
      for (const netuid of row.netuids ?? []) if (!map.has(netuid)) map.set(netuid, row.domain);
    }
    return (netuid: number) => map.get(netuid);
  }, [domains.data]);

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const subnet of subnets) map.set(subnet.netuid, subnet.name ?? `Subnet ${subnet.netuid}`);
    return (netuid: number) => map.get(netuid) ?? `Subnet ${netuid}`;
  }, [subnets]);

  const rows = useMemo(() => {
    const joined = directoryRows(subnets, econRows, domainOf);
    // Probe health is an overlay on the registry row, keyed by netuid; the
    // list's own `health` is chain lifecycle and means something else.
    const probed = health.data?.data ?? {};
    return joined.map((row) => ({
      ...row,
      health: probed[row.netuid]?.health ?? "unknown",
      api_spec: apiSpecStatus(catalog.data?.data[row.netuid]),
    }));
  }, [subnets, econRows, domainOf, health.data, catalog.data]);

  const withApi = useMemo(
    () => (catalog.data ? specSubnets(catalog.data.data) : null),
    [catalog.data],
  );

  const filtered = useMemo(
    () =>
      filterDirectory(rows, {
        domain: search.domain,
        health: search.health,
        api: search.api,
        q: search.q,
        withApi: withApi ?? undefined,
      }),
    [rows, search.domain, search.health, search.api, search.q, withApi],
  );

  const missingFilterReads = [
    ...(search.domain && !domains.data ? [domains] : []),
    ...(search.health && !health.data ? [health] : []),
    ...(search.api && !catalog.data ? [catalog] : []),
  ];
  const filterState =
    missingFilterReads.length === 0
      ? "ready"
      : missingFilterReads.some((read) => read.isPending)
        ? "pending"
        : "unavailable";
  const secondaryReads = [
    { label: "subnet registry refresh", query: registry },
    { label: "subnet economics", query: economics },
    { label: "subnet domains", query: domains },
    { label: "subnet surface health", query: health },
    { label: "subnet API specifications", query: catalog },
  ];

  const domainNames = useMemo(
    () => (domains.data?.data ?? []).map((row) => row.domain).sort(),
    [domains.data],
  );

  const probedStates = Object.values(health.data?.data ?? {});
  const healthy = probedStates.filter((entry) => entry.health === "ok").length;
  const probedCount = probedStates.length;

  const cells: FactCells = [
    {
      label: "Indexed",
      value: formatNumber(subnets.length),
    },
    // The directory's coverage is a real first-scan reading. Individual
    // health, price movement, and lifecycle changes remain where a reader can
    // compare them in the directory or their dedicated analytic section;
    // duplicating all of them above the first result made the mobile route
    // read like a dashboard before it read like an explorer.
    {
      label: "Probed healthy",
      value: probedCount > 0 ? `${formatNumber(healthy)} / ${formatNumber(probedCount)}` : "—",
      loading: health.isPending,
    },
  ];

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  })).concat(
    {
      label: "revenue coverage",
      value: `${API_BASE}/api/v1/chain/revenue-coverage`,
      href: `${API_BASE}/api/v1/chain/revenue-coverage`,
    },
    {
      label: "subnets.json artifact",
      value: `${API_BASE}/metagraph/subnets.json`,
      href: `${API_BASE}/metagraph/subnets.json`,
    },
  );

  const setSearch = (next: Partial<SubnetsSearch>) => {
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  };

  return (
    <AppShell>
      <ApiSources />
      <AnalyticsPage
        sections={SECTIONS}
        hero={
          <EntityHero
            className="mg-hero--directory"
            name="Subnets"
            cells={cells}
            live={{
              updatedAt: recordModifiedAt(listed.meta) ?? null,
              source: "registry + chain",
              onRefresh: () => {
                setRefreshing(true);
                void queryClient
                  .invalidateQueries(metagraphedQueryInvalidationTarget())
                  .finally(() => setRefreshing(false));
              },
              refreshing: refreshing || secondaryReads.some(({ query }) => query.isFetching),
            }}
          />
        }
      >
        <DirectorySection
          rows={filtered}
          total={rows.length}
          domains={domainNames}
          filters={{
            domain: search.domain,
            health: search.health,
            api: search.api,
            q: search.q,
          }}
          onFilter={setSearch}
          unknownApiCount={
            catalog.data ? rows.filter((row) => row.api_spec === "unknown").length : 0
          }
          filterState={filterState}
          status={
            secondaryReads.some(({ query }) => query.isError) ? (
              <div className="mb-4 grid gap-3">
                {secondaryReads
                  .filter(({ query }) => query.isError)
                  .map(({ label, query }) => (
                    <ErrorState
                      key={label}
                      context={label}
                      error={query.error}
                      onRetry={() => void query.refetch()}
                    />
                  ))}
                {secondaryReads.some(({ query }) => query.isError && query.data != null) ? (
                  <p className="text-13 text-ink-muted">
                    Previously loaded readings remain visible while their source is unavailable.
                  </p>
                ) : null}
              </div>
            ) : undefined
          }
        />
        <RankingsSection
          metric={search.metric as RankMetric}
          window={search.window as RankWindow}
          onMetric={(metric) => setSearch({ metric })}
          onWindow={(window) => setSearch({ window })}
          nameOf={nameOf}
          domainOf={domainOf}
        />
        <RevenueCoverageSection nameOf={nameOf} />
        <DomainsSection onPick={(domain) => setSearch({ domain })} />
        <ChurnSection />
        <Raw rows={rawRows} title="Subnet registry API and artifacts" />
        <HubSections path="/subnets" />
      </AnalyticsPage>
    </AppShell>
  );
}
