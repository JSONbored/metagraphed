import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsPage,
  EntityHero,
  Fact,
  FactSentence,
  Raw,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RankingsSection } from "@/components/metagraphed/subnets-index/rankings";
import { DirectorySection } from "@/components/metagraphed/subnets-index/directory";
import { DomainsSection } from "@/components/metagraphed/subnets-index/domains";
import { ChurnSection } from "@/components/metagraphed/subnets-index/churn";
import {
  directoryRows,
  filterDirectory,
  specSubnets,
  fmtAlpha,
  fmtPct,
  type RankMetric,
  type RankWindow,
} from "@/components/metagraphed/subnets-index/subnets-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  SUBNETS_ALL_LIMIT,
  agentCatalogMapQuery,
  chainSubnetLifecycleQuery,
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

/** Registers this page's reads with the ⌘J drawer, from inside AppShell's provider. */
function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function SubnetsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const { data: listed } = useSuspenseQuery(subnetsQuery({ limit: SUBNETS_ALL_LIMIT }));
  const economics = useQuery({ ...economicsQuery(), retry: 0 });
  const domains = useQuery({ ...domainsQuery(), retry: 0 });
  const health = useQuery({ ...subnetHealthMapQuery(), retry: 0 });
  const lifecycle = useQuery({ ...chainSubnetLifecycleQuery(500), retry: 0 });
  const catalog = useQuery({ ...agentCatalogMapQuery(), retry: 0 });

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
    return joined.map((row) => ({ ...row, health: probed[row.netuid]?.health ?? row.health }));
  }, [subnets, econRows, domainOf, health.data]);

  const withApi = useMemo(() => specSubnets(catalog.data?.data ?? {}), [catalog.data]);

  const filtered = useMemo(
    () =>
      filterDirectory(rows, {
        domain: search.domain,
        health: search.health,
        api: search.api,
        q: search.q,
        withApi,
      }),
    [rows, search.domain, search.health, search.api, search.q, withApi],
  );

  const domainNames = useMemo(
    () => (domains.data?.data ?? []).map((row) => row.domain).sort(),
    [domains.data],
  );

  const totalStake = econRows.reduce((acc, row) => acc + (row.total_stake_alpha ?? 0), 0);
  // `alpha_price_change_7d` is a PERCENTAGE on the wire; every renderer below
  // takes a fraction. See pctToFraction in subnets-index-logic.
  const priced = econRows
    .map((row) => row.alpha_price_change_7d)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b)
    .map((pct) => pct / 100);
  const medianChange = priced.length > 0 ? priced[Math.floor(priced.length / 2)]! : null;
  const probedStates = Object.values(health.data?.data ?? {});
  const healthy = probedStates.filter((entry) => entry.health === "ok").length;
  const probedCount = probedStates.length;
  const churn7d = (lifecycle.data?.data.entries ?? []).filter((entry) => {
    if (!entry.observed_at) return false;
    return Date.now() - Date.parse(entry.observed_at) <= 7 * 86_400_000;
  }).length;

  const sentence: FactNodes = [
    <Fact key="count">{`${formatNumber(subnets.length)} subnets`}</Fact>,
    <Fact key="health">
      {probedCount > 0
        ? `${formatNumber(healthy)}/${formatNumber(probedCount)} probed healthy`
        : "none probed"}
    </Fact>,
    <Fact key="stake">{`${fmtAlpha(totalStake)} α staked`}</Fact>,
    <Fact key="domains">{`${formatNumber(domainNames.length)} domains`}</Fact>,
    <Fact key="churn">{`${formatNumber(churn7d)} lifecycle changes this week`}</Fact>,
  ];

  const cells: FactCells = [
    {
      label: "Publishing an API",
      value: `${formatNumber(withApi.size)} / ${formatNumber(subnets.length)}`,
    },
    { label: "Total stake", value: `${fmtAlpha(totalStake)} α` },
    // No delta chip: the value IS the change, and a chip repeating it beside
    // itself reads as two different numbers that happen to agree.
    { label: "Median price Δ7d", value: fmtPct(medianChange, 1) },
    { label: "Lifecycle changes 7d", value: formatNumber(churn7d) },
  ];

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  })).concat({
    label: "subnets.json artifact",
    value: `${API_BASE}/metagraph/subnets.json`,
    href: `${API_BASE}/metagraph/subnets.json`,
  });

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
            name="Subnets"
            sentence={<FactSentence>{sentence}</FactSentence>}
            cells={cells}
            live={{
              updatedAt: listed.meta?.generated_at ?? null,
              source: "registry + chain",
              onRefresh: () => void queryClient.invalidateQueries({ queryKey: ["mg"] }),
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
          withApi={withApi}
        />
        <RankingsSection
          metric={search.metric as RankMetric}
          window={search.window as RankWindow}
          onMetric={(metric) => setSearch({ metric })}
          onWindow={(window) => setSearch({ window })}
          nameOf={nameOf}
          domainOf={domainOf}
        />
        <DomainsSection onPick={(domain) => setSearch({ domain })} />
        <ChurnSection />
        <Raw rows={rawRows} title="Subnet registry API and artifacts" />
      </AnalyticsPage>
    </AppShell>
  );
}
