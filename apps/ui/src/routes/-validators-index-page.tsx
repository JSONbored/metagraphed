import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  CompositionBreakdown,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FilterField,
  FilterSelect,
  RankGrid,
  RESIDUAL_KEY,
  RankedRails,
  Raw,
  type DataTableColumn,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ValidatorCompareBar } from "@/components/metagraphed/compare-bar";
import { ValidatorCompareToggle } from "@/components/metagraphed/compare-toggle";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  ALL_VALIDATORS_LIMIT,
  concentration,
  filterOperators,
  fmtStake,
  median,
  operatorRows,
  shortKey,
  takeLabel,
  type OperatorRow,
} from "@/components/metagraphed/validators-index/validators-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { validatorEconomicsQuery, validatorsQuery } from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber, formatPct } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { Route } from "./validators.index";

const SECTIONS = [
  { id: "concentration", name: "Concentration" },
  { id: "operators", name: "Operators" },
  { id: "cost", name: "Cost to validate" },
] as const;

const API_PATHS = ["/api/v1/validators", "/api/v1/validators/economics"];

const MIN_STAKE_OPTIONS = [
  { value: 0, label: "Any stake" },
  { value: 1_000, label: "1k τ and up" },
  { value: 10_000, label: "10k τ and up" },
  { value: 100_000, label: "100k τ and up" },
];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function ValidatorsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const { ref: costRef, nearViewport: costNearViewport } = useNearViewport("0px 0px");

  const { data: listed } = useSuspenseQuery(
    validatorsQuery({
      sort: "total_stake",
      limit: ALL_VALIDATORS_LIMIT,
      subnets: false,
      identity: false,
      projection: "operator",
    }),
  );
  const economics = useQuery({
    ...validatorEconomicsQuery(130),
    // Permit cost is a distinct third reading after the directory. Preserve
    // its anchor and its loading/error geometry without fetching a 130-row
    // comparison before a reader chooses to inspect it.
    enabled: costNearViewport,
    retry: 0,
  });

  const validators = listed.data.validators;
  const operators = useMemo(() => operatorRows(validators), [validators]);
  const shown = useMemo(
    () =>
      filterOperators(operators, {
        q: search.q,
        minStake: search.minStake,
        namedOnly: search.named,
      }),
    [operators, search.q, search.minStake, search.named],
  );
  const { segments, listedTotal } = useMemo(() => concentration(operators, 10), [operators]);

  const medianTake = median(validators.map((validator) => validator.take));
  const medianApy = median(operators.map((operator) => operator.apyEstimate));
  const topTen = segments
    .filter((segment) => segment.key !== RESIDUAL_KEY)
    .reduce((acc, segment) => acc + segment.value, 0);
  const topShare = listedTotal > 0 ? topTen / listedTotal : null;

  // A filter that matched nothing and a directory with nothing in it are
  // different answers. Only the second offers "Open the API": the first would
  // send the reader to the UNFILTERED response, which is not what they asked
  // for (#6340).
  const filtersActive = Boolean(search.q || search.minStake > 0 || search.named);

  const setSearch = (next: Partial<typeof search>) => {
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  };

  // Nothing the strip below states appears here too (#11693). The operator
  // count, the median take and the median APY were chips AND cells, so the
  // hero said each of them twice, a line apart, in two type sizes.
  const sentence: FactNodes = [
    <Fact key="keys">{`${formatNumber(validators.length)} hotkeys`}</Fact>,
    <Fact key="top">
      {topShare === null ? "share unavailable" : `top 10 hold ${formatPct(topShare, 1)}`}
    </Fact>,
  ];

  const cells: FactCells = [
    { label: "Stake listed", value: fmtStake(listedTotal) },
    { label: "Operators", value: formatNumber(operators.length) },
    {
      label: "Median take",
      value: medianTake === null ? "—" : `${formatPct(medianTake, 1)}`,
    },
    { label: "Median APY", value: medianApy === null ? "—" : `${formatPct(medianApy, 1)}` },
  ];

  const columns: DataTableColumn<OperatorRow>[] = [
    {
      key: "name",
      label: "Operator",
      kind: "text",
      sortable: true,
      // Bounded, or an unusually long identity name widens the table past its
      // card and takes Compare off the right edge (#11696).
      width: 330,
      value: (row) => row.name,
      render: (row) => (
        <span className="mg-dt-entity">
          <span className="truncate">{row.name}</span>
          {row.keyCount > 1 ? <span className="mg-dt-count">×{row.keyCount}</span> : null}
        </span>
      ),
      definition: "Operator",
    },
    {
      key: "take",
      label: "Take",
      kind: "text",
      // Wide enough for a RANGE: an operator running several hotkeys at
      // different takes reads "9.0%-18.0%".
      width: 130,
      value: (row) => takeLabel(row.takeMin, row.takeMax),
      definition: "Take",
    },
    {
      key: "apy",
      label: "Est. APY",
      kind: "number",
      sortable: true,
      value: (row) => row.apyEstimate,
      format: (value) => (typeof value === "number" ? `${formatPct(value, 1)}` : "—"),
      definition: "Estimated APY",
    },
    {
      key: "memberships",
      label: "Memberships",
      kind: "number",
      sortable: true,
      // Wide enough for the label PLUS its sort chevron. The column widths
      // were set against a monospace; the sans is narrower per character but
      // the chevron and the "?" are not, so two headers came out a few pixels
      // short and ellipsed (#11698).
      width: 150,
      value: (row) => row.memberships,
    },
    {
      key: "nominators",
      label: "Nominators",
      kind: "number",
      sortable: true,
      width: 160,
      value: (row) => row.nominators,
      format: (value) => (typeof value === "number" ? formatNumber(value) : "—"),
      definition: "Nominators",
    },
    {
      key: "stake",
      label: "Total stake",
      width: 140,
      kind: "number",
      sortable: true,
      value: (row) => row.totalStakeTao,
      format: (value) => (typeof value === "number" ? fmtStake(value) : "—"),
    },
    {
      key: "dominance",
      label: "Dominance",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.dominance,
      format: (value) => (typeof value === "number" ? `${formatPct(value, 2)}` : "—"),
      definition: "Stake dominance",
    },
    {
      key: "uids",
      label: "UIDs",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.uidCount,
    },
    {
      key: "emission",
      label: "Emission",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.totalEmissionTao,
      format: (value) => (typeof value === "number" ? fmtStake(value) : "—"),
    },
    {
      key: "coldkey",
      label: "Coldkey",
      kind: "identifier",
      demote: true,
      value: (row) => row.coldkey ?? "—",
    },
    {
      // Selection is a CELL, not a table mode: the dock below turns it into a
      // link to /compare, which is a page with a URL you can send someone.
      key: "compare",
      label: "Compare",
      kind: "text",
      // A checkbox needs no more than its own width plus the header word, and
      // without a bound it took whatever was left and pushed itself off the
      // right edge of the card (#11695). No `align`: that would emit
      // `data-align` on all 604 cells for a column one checkbox wide, which is
      // 11 KB of served HTML and this route is on a payload ratchet.
      width: 96,
      value: () => "",
      render: (row) => <ValidatorCompareToggle hotkey={row.primaryHotkey} />,
      definition: "Compare",
    },
  ];

  const costRows = (economics.data?.data.rows ?? [])
    .filter((row) => typeof row.permit_floor_cost_tao === "number")
    .sort((a, b) => (a.permit_floor_cost_tao ?? 0) - (b.permit_floor_cost_tao ?? 0));

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <AnalyticsPage
        sections={SECTIONS}
        hero={
          <EntityHero
            className="mg-hero--directory"
            name="Validators"
            sentence={
              <FactSentence>
                Every hotkey holding a validator permit, and the operator running it. {sentence}
              </FactSentence>
            }
            cells={cells}
            live={{
              updatedAt: listed.meta?.generated_at ?? null,
              source: "chain-direct index",
              onRefresh: () =>
                void queryClient.invalidateQueries(metagraphedQueryInvalidationTarget()),
            }}
          />
        }
      >
        <AnalyticsSection
          id="concentration"
          name="Concentration"
          question="How much of the listed stake the largest operators hold."
          visual={
            segments.length > 0 ? (
              <CompositionBreakdown
                segments={segments}
                formatValue={(value) => fmtStake(value)}
                legendCols={5}
                ariaLabel="Stake share of the largest operators"
                source="validator-operator"
              />
            ) : null
          }
          footnote={`shares of the ${fmtStake(listedTotal)} held by the ${formatNumber(
            operators.length,
          )} listed operators, not of all stake`}
        />
        <AnalyticsSection
          id="operators"
          name="Operators"
          question="Every operator, ranked."
          className="mg-directory-section"
          visual={
            <DataTable
              rows={shown}
              columns={columns}
              rowKey={(row) => row.key}
              caption={
                shown.length === operators.length
                  ? "Every operator"
                  : `${formatNumber(shown.length)} of ${formatNumber(operators.length)} operators`
              }
              rowHref={(row) => `/validators/${row.primaryHotkey}`}
              link={RouterLink}
              source="validator-operator"
              mobile="cards"
              storageKey="validators-operators-columns"
              empty={
                filtersActive ? (
                  <EmptyState
                    title="No operators match these filters"
                    description="Clear the search or lower the minimum stake."
                  />
                ) : (
                  <EmptyState
                    title="No validators indexed yet"
                    description="The validator index is built from chain state; it fills in as the capture runs."
                    action={{
                      label: "Open /api/v1/validators",
                      href: `${API_BASE}/api/v1/validators`,
                      external: true,
                    }}
                  />
                )
              }
              search={{
                value: search.q,
                onChange: (q) => setSearch({ q }),
                placeholder: "Operator, hotkey or coldkey",
              }}
              filters={
                <>
                  <FilterField label="Minimum stake">
                    <FilterSelect
                      value={String(search.minStake)}
                      onChange={(event) => setSearch({ minStake: Number(event.target.value) })}
                    >
                      {MIN_STAKE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </FilterSelect>
                  </FilterField>
                  <FilterField label="Identity">
                    <FilterSelect
                      value={search.named ? "1" : ""}
                      onChange={(event) => setSearch({ named: event.target.value === "1" })}
                    >
                      <option value="">Any operator</option>
                      <option value="1">Declares an identity</option>
                    </FilterSelect>
                  </FilterField>
                </>
              }
              expand={(row) =>
                row.keyCount > 1 ? (
                  <RankGrid
                    items={row.keys.map((validator) => ({
                      key: validator.hotkey,
                      label: shortKey(validator.hotkey),
                      value: fmtStake(validator.total_stake_tao),
                      share:
                        typeof validator.take === "number"
                          ? `${formatPct(validator.take, 1)} take`
                          : undefined,
                      href: `/validators/${validator.hotkey}`,
                    }))}
                    cols={4}
                    ariaLabel={`${row.name} hotkeys`}
                    source="validator-key"
                  />
                ) : null
              }
            />
          }
          footnote={`${formatNumber(validators.length)} hotkeys grouped by declared identity · chain-direct`}
        >
          <ValidatorCompareBar />
        </AnalyticsSection>
        <AnalyticsSection
          id="cost"
          name="Cost to validate"
          question="What a permit costs, per subnet."
          visualRef={costRef}
          visual={
            !costNearViewport || economics.isPending ? (
              <RankedRails
                items={[]}
                formatValue={(value) => fmtStake(value)}
                scale="sqrt"
                columns={{ value: "Permit floor", name: "Subnet", track: "Relative cost" }}
                ariaLabel="Cheapest subnets to hold a validator permit on"
                source="validator-cost"
                loading
                loadingRows={10}
              />
            ) : economics.isError ? (
              <ErrorState
                error={economics.error}
                onRetry={() => void economics.refetch()}
                context="validator permit costs"
              />
            ) : costRows.length > 0 ? (
              <RankedRails
                items={costRows.slice(0, 15).map((row) => ({
                  key: `sn-${row.netuid}`,
                  label: `SN${row.netuid}`,
                  value: row.permit_floor_cost_tao ?? 0,
                  href: `/subnets/${row.netuid}`,
                  detail: [
                    {
                      key: "earning",
                      label: "Earning floor",
                      value: fmtStake(row.earning_floor_cost_tao),
                    },
                    {
                      key: "multiple",
                      label: "Permit → earning",
                      value:
                        typeof row.permit_to_earning_multiple === "number"
                          ? `${formatDecimal(row.permit_to_earning_multiple, 2)}×`
                          : "—",
                    },
                    {
                      key: "slots",
                      label: "Slots open",
                      value:
                        typeof row.validator_slots_open === "number"
                          ? formatNumber(row.validator_slots_open)
                          : "—",
                    },
                  ],
                }))}
                formatValue={(value) => fmtStake(value)}
                scale="sqrt"
                columns={{ value: "Permit floor", name: "Subnet", track: "Relative cost" }}
                ariaLabel="Cheapest subnets to hold a validator permit on"
                source="validator-cost"
              />
            ) : null
          }
          footnote={
            !costNearViewport
              ? "permit and earning floors by subnet · chain-direct"
              : economics.isPending
                ? "loading validator permit-cost readings"
                : economics.isError
                  ? "validator permit-cost readings could not be loaded"
                  : `the 15 cheapest of ${formatNumber(costRows.length)} ranked subnets · a permit is the floor to VALIDATE, not to earn`
          }
        />
        <Raw rows={rawRows} title="Validator index API" />
        <HubSections path="/validators" />
      </AnalyticsPage>
    </AppShell>
  );
}
