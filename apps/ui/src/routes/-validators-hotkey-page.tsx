import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsPage,
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FactStrip,
  LineWithWindow,
  RangeControl,
  RankGrid,
  RankedRails,
  Raw,
  StackedColumns,
  type DataTableColumn,
  type FactCells,
  type FactNodes,
  type RankGridItem,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { CopyLinkButton } from "@/components/metagraphed/primitives";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import {
  ALL_VALIDATORS_LIMIT,
  operatorRows,
} from "@/components/metagraphed/validators-index/validators-index-logic";
import {
  apyPoints,
  changeOver,
  fmtAlpha,
  fmtScore,
  fmtStake,
  historyPoints,
  nominatorRail,
  peerWindow,
  shortKey,
  stakeBySubnet,
  type ValidatorWindow,
} from "@/components/metagraphed/validator-detail/validator-detail-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  SUBNETS_ALL_LIMIT,
  subnetsQuery,
  validatorDetailQuery,
  validatorHistoryQuery,
  validatorNominatorsQuery,
  validatorsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import type { ValidatorDetailSubnet } from "@/lib/metagraphed/types";
import { Route } from "./validators.$hotkey";

const SECTIONS = [
  { id: "stake", name: "Stake by subnet" },
  { id: "memberships", name: "Per-subnet" },
  { id: "nominators", name: "Nominators" },
  { id: "momentum", name: "Momentum" },
  { id: "peers", name: "Peers" },
] as const;

const WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

const apiPaths = (hotkey: string) => [
  `/api/v1/validators/${hotkey}`,
  `/api/v1/validators/${hotkey}/history`,
  `/api/v1/validators/${hotkey}/nominators`,
  `/api/v1/validators`,
];

function ApiSources({ paths }: { paths: string[] }) {
  useRegisterApiSource(paths);
  return null;
}

export function ValidatorDetailPage() {
  const { hotkey } = Route.useParams();
  const { window } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [showAllNominators, setShowAllNominators] = useState(false);
  const paths = useMemo(() => apiPaths(hotkey), [hotkey]);

  const { data: detailResult } = useSuspenseQuery(validatorDetailQuery(hotkey));
  const detail = detailResult.data;
  const history = useQuery({ ...validatorHistoryQuery(hotkey, window), retry: 0 });
  const nominators = useQuery({
    ...validatorNominatorsQuery(hotkey, { limit: 200 }),
    retry: 0,
  });
  const subnets = useQuery({ ...subnetsQuery({ limit: SUBNETS_ALL_LIMIT }), retry: 0 });
  const allValidators = useQuery({
    ...validatorsQuery({
      sort: "total_stake",
      limit: ALL_VALIDATORS_LIMIT,
      subnets: false,
      identity: false,
    }),
    retry: 0,
  });

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const subnet of subnets.data?.data ?? []) {
      map.set(subnet.netuid, subnet.name ?? `Subnet ${subnet.netuid}`);
    }
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [subnets.data]);

  const memberships = detail.subnets ?? [];
  const columns = stakeBySubnet(memberships, nameOf);
  const points = history.data?.data.points ?? [];
  const stakeSeries = historyPoints(points, (point) => point.total_stake_tao);
  const yieldSeries = apyPoints(points);
  const nominatorRows = nominatorRail(nominators.data?.data ?? []);

  const operator = detail.coldkey_identity?.name?.trim() || shortKey(hotkey);
  const peers = useMemo(() => {
    const ranked = operatorRows(allValidators.data?.data.validators ?? []).map((row) => ({
      hotkey: row.primaryHotkey,
      name: row.name,
      totalStakeTao: row.totalStakeTao,
    }));
    return peerWindow(ranked, hotkey);
  }, [allValidators.data, hotkey]);

  const permits = memberships.filter((membership) => membership.validator_permit).length;

  const sentence: FactNodes = [
    <Fact key="hotkey">{`hotkey ${shortKey(hotkey)}`}</Fact>,
    <Fact key="coldkey">{detail.coldkey ? `coldkey ${shortKey(detail.coldkey)}` : "no coldkey"}</Fact>,
    <Fact key="subnets">{`${formatNumber(memberships.length)} memberships`}</Fact>,
    <Fact key="permits">{`${formatNumber(permits)} with a permit`}</Fact>,
    <Fact key="noms">
      {detail.nominator_count == null
        ? "nominators unavailable"
        : `${formatNumber(detail.nominator_count)} nominators`}
    </Fact>,
    <Fact key="trust">{`avg trust ${fmtScore(detail.avg_validator_trust)}`}</Fact>,
  ];

  const cells: FactCells = [
    { label: "Total stake", value: fmtStake(detail.total_stake_tao) },
    {
      label: "Est. APY",
      value:
        typeof detail.apy_estimate === "number"
          ? `${(detail.apy_estimate * 100).toFixed(1)}%`
          : "—",
    },
    { label: "Memberships", value: formatNumber(memberships.length) },
    { label: "Permits", value: formatNumber(permits) },
    {
      label: "Nominators",
      value: detail.nominator_count == null ? "—" : formatNumber(detail.nominator_count),
    },
    { label: "Avg trust", value: fmtScore(detail.avg_validator_trust) },
  ];

  const membershipColumns: DataTableColumn<ValidatorDetailSubnet>[] = [
    {
      key: "netuid",
      label: "Subnet",
      kind: "link",
      sortable: true,
      value: (row) => nameOf(row.netuid),
      href: (row) => `/subnets/${row.netuid}`,
    },
    { key: "uid", label: "UID", kind: "number", sortable: true, value: (row) => row.uid },
    {
      key: "stake_alpha",
      label: "Stake",
      kind: "number",
      sortable: true,
      value: (row) => row.stake_alpha ?? null,
      format: (value) => (typeof value === "number" ? fmtAlpha(value) : "—"),
    },
    {
      key: "emission_alpha",
      label: "Emission",
      kind: "number",
      sortable: true,
      value: (row) => row.emission_alpha ?? null,
      format: (value) => (typeof value === "number" ? fmtAlpha(value) : "—"),
    },
    {
      key: "dividends",
      label: "Dividends",
      kind: "number",
      sortable: true,
      value: (row) => row.dividends ?? null,
      format: (value) => (typeof value === "number" ? fmtScore(value) : "—"),
    },
    {
      key: "validator_trust",
      label: "Trust",
      kind: "number",
      sortable: true,
      value: (row) => row.validator_trust ?? null,
      format: (value) => (typeof value === "number" ? fmtScore(value) : "—"),
      definition: "Validator trust",
    },
    {
      key: "validator_permit",
      label: "Permit",
      kind: "status",
      value: (row) => (row.validator_permit ? "yes" : "no"),
    },
  ];

  const legend: RankGridItem[] = columns.slice(0, 12).map((column) => ({
    key: column.key,
    label: column.label,
    value: fmtAlpha(column.segments[0]?.value ?? 0),
    share: fmtAlpha(column.segments[1]?.value ?? 0),
  }));

  const momentumCells: FactCells = [
    { label: "Stake now", value: fmtStake(stakeSeries[stakeSeries.length - 1]?.v) },
    {
      label: `Δ stake ${window}`,
      value: (() => {
        const change = changeOver(stakeSeries);
        return change === null ? "—" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
      })(),
    },
    {
      label: "Yield now",
      value: (() => {
        const last = yieldSeries[yieldSeries.length - 1]?.v;
        return typeof last === "number" ? `${(last * 100).toFixed(1)}%` : "—";
      })(),
    },
    {
      label: `Δ yield ${window}`,
      value: (() => {
        const change = changeOver(yieldSeries);
        return change === null ? "—" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
      })(),
    },
  ];

  const rawRows: RawRow[] = [
    { label: "hotkey", value: hotkey },
    ...(detail.coldkey ? [{ label: "coldkey", value: detail.coldkey }] : []),
    ...(detail.coldkey_identity?.url
      ? [
          {
            label: "Identity URL",
            value: detail.coldkey_identity.url,
            href: detail.coldkey_identity.url,
          },
        ]
      : []),
    ...paths.map((path) => ({
      label: path.split("/").slice(5).join("/") || "detail",
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
  ];

  return (
    <AppShell>
      <ApiSources paths={paths} />
      <AnalyticsPage
        sections={SECTIONS}
        hero={
          <EntityHero
            crumbs={[{ label: "Validators", href: "/validators" }, { label: operator }]}
            name={operator}
            action={
              <StakeUnstakeModal
                hotkey={hotkey}
                netuid={memberships[0]?.netuid ?? 0}
                validatorName={operator}
                trigger={(open) => (
                  <button type="button" className="mg-hero-action" onClick={open}>
                    Delegate
                  </button>
                )}
              />
            }
            secondary={
              <CopyLinkButton
                label="Copy link to this validator"
                size="sm"
                className="mg-hero-icon-action"
              />
            }
            sentence={<FactSentence>{sentence}</FactSentence>}
            cells={cells}
            live={{
              updatedAt: detailResult.meta?.generated_at ?? null,
              source: "chain-direct index",
              onRefresh: () => void queryClient.invalidateQueries({ queryKey: ["mg"] }),
            }}
          />
        }
      >
        <AnalyticsSection
          id="stake"
          name="Stake by subnet"
          question="Where the stake is, and what it earns there."
          visual={
            columns.length > 0 ? (
              <StackedColumns
                columns={columns}
                seriesOrder={["stake", "emission"]}
                formatValue={(value) => fmtAlpha(value)}
                ariaLabel="Stake and emission by subnet"
                columnSource="validator-subnet"
              />
            ) : null
          }
          legend={
            legend.length > 0 ? (
              <RankGrid
                items={legend}
                cols={4}
                ariaLabel="Stake and emission per subnet"
                source="validator-subnet"
              />
            ) : null
          }
          // Not a time series: /validators/{hotkey}/history publishes daily
          // NETWORK-WIDE totals with netuid: null, so there is no per-subnet
          // series to stack. Momentum below carries the time dimension.
          footnote={`the ${formatNumber(columns.length)} largest of ${formatNumber(
            memberships.length,
          )} memberships · a snapshot, not a series · chain-direct`}
        />
        <AnalyticsSection
          id="memberships"
          name="Per-subnet"
          question="Every membership, ranked by stake."
          visual={
            <DataTable
              rows={memberships}
              columns={membershipColumns}
              rowKey={(row) => `${row.netuid}-${row.uid}`}
              caption={`${formatNumber(memberships.length)} memberships`}
              rowHref={(row) => `/subnets/${row.netuid}`}
              link={RouterLink}
              source="validator-subnet"
              paginate={false}
              mobile="cards"
              dense
              storageKey="validator-memberships-columns"
            />
          }
          footnote={`${formatNumber(permits)} of ${formatNumber(
            memberships.length,
          )} carry a validator permit · chain-direct`}
        />
        <AnalyticsSection
          id="nominators"
          name="Nominators"
          question="Who delegates here."
          visual={
            nominatorRows.length > 0 ? (
              <RankedRails
                items={showAllNominators ? nominatorRows : nominatorRows.slice(0, 10)}
                formatValue={(value) => fmtStake(value)}
                scale="sqrt"
                columns={{ value: "Moved", name: "Delegator", track: "Share of delegation" }}
                ariaLabel="Nominators by stake moved"
                source="validator-nominator"
              />
            ) : null
          }
          footnote={
            nominatorRows.length > 10 && !showAllNominators ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() => setShowAllNominators(true)}
              >
                Show all {formatNumber(nominatorRows.length)}
              </button>
            ) : (
              // Ranked by GROSS movement in the window, not by net: net goes
              // negative for anyone unwinding, and ranking "who delegates
              // here" by it puts the largest departing delegator last.
              `${formatNumber(detail.nominator_count ?? 0)} nominators · ranked by stake moved in 30d · chain-direct`
            )
          }
        />
        <AnalyticsSection
          id="momentum"
          name="Momentum"
          question="Stake and yield over time."
          controls={
            <RangeControl
              label="Window"
              options={WINDOWS}
              value={window}
              onChange={(next: ValidatorWindow) =>
                void navigate({ search: (prev) => ({ ...prev, window: next }), replace: true })
              }
            />
          }
          visual={
            stakeSeries.length > 1 ? (
              <LineWithWindow
                id={`validator-${hotkey}-stake`}
                points={stakeSeries}
                window={{ from: stakeSeries[0]!.t, to: stakeSeries[stakeSeries.length - 1]!.t }}
                unit="τ"
                formatValue={(value) => fmtStake(value)}
                ariaLabel={`Total stake, ${window}`}
                source={`validator-${hotkey}-stake`}
              />
            ) : null
          }
          legend={<FactStrip cells={momentumCells} />}
          footnote={`${window} · daily snapshots · yield annualised simply from the daily reward rate, not compounded`}
        />
        <AnalyticsSection
          id="peers"
          name="Peers"
          question="The operators ranked either side of this one."
          visual={
            peers.length > 0 ? (
              <RankGrid
                items={peers}
                cols={4}
                ariaLabel="Operators near this one by stake"
                source="validator-peer"
              />
            ) : null
          }
          footnote="by total stake across every subnet · chain-direct"
        />
        <Raw rows={rawRows} title="Validator identifiers and API" />
      </AnalyticsPage>
    </AppShell>
  );
}
