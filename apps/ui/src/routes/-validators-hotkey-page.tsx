import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  RankedRails,
  Raw,
  type DataTableColumn,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { CopyLinkButton } from "@/components/metagraphed/copy-link-button";
import { ErrorState } from "@/components/metagraphed/states";
import { StakeUnstakeLauncher } from "@/components/metagraphed/stake-unstake-launcher";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  fmtAlpha,
  fmtScore,
  fmtStake,
  membershipsBySubnet,
  nominatorRail,
  shortKey,
} from "@/components/metagraphed/validator-detail/validator-detail-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  SUBNETS_ALL_LIMIT,
  subnetsQuery,
  validatorDetailQuery,
  validatorNominatorsQuery,
} from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { VALIDATOR_PRINCIPAL_UNAVAILABLE } from "@/lib/metagraphed/validator-principal";
import type { ValidatorDetailSubnet } from "@/lib/metagraphed/types";
import { Route } from "./validators.$hotkey";

const SECTIONS = [
  { id: "scope", name: "Data scope" },
  { id: "memberships", name: "Per-subnet" },
  { id: "nominators", name: "Nominators" },
] as const;

// The first membership ledger needs a subnet's identity only. Keep the
// all-subnet name map small rather than hydrating directory-only fields the
// validator profile never renders.
const VALIDATOR_SUBNET_NAME_FIELDS = "netuid,name";

const apiPaths = (hotkey: string) => [
  `/api/v1/validators/${hotkey}`,
  `/api/v1/validators/${hotkey}/nominators`,
];

function ApiSources({ paths }: { paths: string[] }) {
  useRegisterApiSource(paths);
  return null;
}

export function ValidatorDetailPage() {
  const { hotkey } = Route.useParams();
  const queryClient = useQueryClient();
  const [showAllNominators, setShowAllNominators] = useState(false);
  const paths = useMemo(() => apiPaths(hotkey), [hotkey]);
  const hydrated = useHydrated();

  const { data: detailResult } = useSuspenseQuery(validatorDetailQuery(hotkey));
  const detail = detailResult.data;
  const { ref: nominatorsRef, nearViewport: nominatorsNearViewport } = useNearViewport("0px 0px");
  const nominators = useQuery({
    ...validatorNominatorsQuery(hotkey, { limit: 200 }),
    enabled: nominatorsNearViewport,
    retry: 0,
  });
  const subnets = useQuery({
    ...subnetsQuery({ limit: SUBNETS_ALL_LIMIT, fields: VALIDATOR_SUBNET_NAME_FIELDS }),
    retry: 0,
  });

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const subnet of subnets.data?.data ?? []) {
      map.set(subnet.netuid, subnet.name ?? `Subnet ${subnet.netuid}`);
    }
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [subnets.data]);

  const memberships = membershipsBySubnet(detail.subnets ?? []);
  const nominatorRows = nominatorRail(nominators.data?.data ?? []);

  const operator = detail.coldkey_identity?.name?.trim() || shortKey(hotkey);

  const permits = memberships.filter((membership) => membership.validator_permit).length;
  const nominatorsLoading = nominatorsNearViewport && (!hydrated || nominators.isPending);
  const showNominatorsLoading = nominatorsNearViewport && hydrated && nominators.isPending;

  // The sentence carries IDENTITY, the strip carries the numbers (#11693).
  // Four of the six chips here restated a cell verbatim -- "116 memberships"
  // above "Memberships 116" -- so the hero said the same thing twice before a
  // reader reached the first chart.
  const sentence: FactNodes = [
    <Fact key="hotkey">{`hotkey ${shortKey(hotkey)}`}</Fact>,
    <Fact key="coldkey">
      {detail.coldkey ? `coldkey ${shortKey(detail.coldkey)}` : "no coldkey"}
    </Fact>,
  ];

  const cells: FactCells = [
    { label: "Capital value", value: "Unavailable" },
    {
      label: "Est. APY",
      value: "Unavailable",
    },
    {
      // One cell, not two: "Memberships 116" beside "Permits 116" reads as the
      // same number typed twice, and the fact worth having is the RATIO --
      // how many of the memberships carry a permit. Slashed like the subnet
      // hero's "Miners / Validators".
      label: "Memberships / permits",
      value: `${formatNumber(memberships.length)} / ${formatNumber(permits)}`,
    },
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
      label: "Voting weight",
      kind: "number",
      value: (row) => row.stake_alpha ?? null,
      format: (value) => (typeof value === "number" ? formatDecimal(value, 3) : "—"),
    },
    {
      key: "emission_alpha",
      label: "Native emission",
      kind: "number",
      value: (row) => row.emission_alpha ?? null,
      render: (row) =>
        row.netuid === 0 ? fmtStake(row.emission_alpha) : fmtAlpha(row.emission_alpha),
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
      // In the menu, not the table. This operator holds a permit on all 116 of
      // its memberships, and an operator without one on a subnet is the rare
      // case -- a column that reads "yes" on every row is a column a reader
      // learns to skip (#11696).
      key: "validator_permit",
      label: "Permit",
      kind: "status",
      demote: true,
      value: (row) => (row.validator_permit ? "yes" : "no"),
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
            className="mg-hero--entity"
            crumbs={[{ label: "Validators", href: "/validators" }, { label: operator }]}
            name={operator}
            action={
              <StakeUnstakeLauncher
                hotkey={hotkey}
                netuid={memberships[0]?.netuid ?? 0}
                validatorName={operator}
              />
            }
            secondary={
              <CopyLinkButton
                label="Copy link to this validator"
                size="sm"
                className="mg-hero-icon-action"
              />
            }
            sentence={
              <FactSentence>
                Where this operator validates, what it takes, and who delegates to it. {sentence}
              </FactSentence>
            }
            cells={cells}
            live={{
              updatedAt: detail.captured_at ?? null,
              source: "chain-direct index",
              onRefresh: () =>
                void queryClient.invalidateQueries(metagraphedQueryInvalidationTarget()),
            }}
          />
        }
      >
        <AnalyticsSection
          id="scope"
          name="Data scope"
          question="What the source establishes."
          visual={
            <p className="max-w-prose text-13 text-ink-muted">
              {VALIDATOR_PRINCIPAL_UNAVAILABLE} Historical capital and yield charts are also
              unavailable. Membership weights are shown per subnet without a currency unit.
              Native emission uses each subnet's own units: TAO on Root and native alpha on
              other subnets. Those units are not interchangeable. Trust, dividends and permits
              describe operation, not an investment return.
            </p>
          }
        />
        <AnalyticsSection
          id="memberships"
          name="Per-subnet"
          question="Every membership in subnet order."
          visual={
            <DataTable
              rows={memberships}
              columns={membershipColumns}
              rowKey={(row) => `${row.netuid}-${row.uid}`}
              caption={`${formatNumber(memberships.length)} memberships`}
              rowHref={(row) => `/subnets/${row.netuid}`}
              link={RouterLink}
              source="validator-subnet"
              pageSize={25}
              mobile="cards"
              dense
              storageKey="validator-memberships-columns"
            />
          }
          footnote={`Voting weight is not principal and is not ranked across subnets · ${formatNumber(permits)} of ${formatNumber(
            memberships.length,
          )} carry a validator permit · chain-direct`}
        />
        <AnalyticsSection
          id="nominators"
          name="Nominators"
          question="Who moved stake during the window."
          visualRef={nominatorsRef}
          visual={
            !nominatorsNearViewport || showNominatorsLoading ? (
              <RankedRails
                items={[]}
                formatValue={(value) => fmtStake(value)}
                scale="sqrt"
                columns={{ value: "Moved", name: "Delegator", track: "Share of movement" }}
                ariaLabel="Nominators by stake moved"
                source="validator-nominator"
                loading
                loadingRows={10}
              />
            ) : nominatorRows.length > 0 ? (
              <RankedRails
                items={showAllNominators ? nominatorRows : nominatorRows.slice(0, 10)}
                formatValue={(value) => fmtStake(value)}
                scale="sqrt"
                columns={{ value: "Moved", name: "Delegator", track: "Share of movement" }}
                ariaLabel="Nominators by stake moved"
                source="validator-nominator"
              />
            ) : nominators.isError ? (
              <ErrorState
                error={nominators.error}
                onRetry={() => void nominators.refetch()}
                context="nominator movement"
              />
            ) : null
          }
          footnote={
            !nominatorsNearViewport ? (
              "30d gross delegation movement · chain-direct"
            ) : nominatorsLoading ? (
              "Loading nominator movement · chain-direct"
            ) : nominators.isError ? (
              "chain-direct · retry the affected record above"
            ) : nominatorRows.length > 10 && !showAllNominators ? (
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
              `${detail.nominator_count == null ? "Nominator count unavailable" : `${formatNumber(detail.nominator_count)} nominators`} · ranked by stake moved in 30d · chain-direct`
            )
          }
        />
        <Raw rows={rawRows} title="Validator identifiers and API" />
      </AnalyticsPage>
    </AppShell>
  );
}
