import { useMemo, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  CompositionBreakdown,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  RankGrid,
  RESIDUAL_KEY,
  RankedRails,
  Raw,
  sortRows,
  type DataTableColumn,
  type FactCells,
  type RawRow,
  type SortState,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ValidatorCompareBar } from "@/components/metagraphed/compare-bar";
import { ValidatorCompareToggle } from "@/components/metagraphed/compare-toggle";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  concentration,
  filterOperators,
  fmtStake,
  median,
  shortKey,
  takeLabel,
  type OperatorRow,
} from "@/components/metagraphed/validators-index/validators-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  validatorEconomicsQuery,
  validatorOperatorDirectoryQuery,
} from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber, formatPct } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { deserializeOperatorRows } from "@/lib/metagraphed/validator-operators";
import { Route } from "./validators.index";

const SECTIONS = [
  { id: "operators", name: "Operators" },
  { id: "concentration", name: "Concentration" },
  { id: "cost", name: "Cost to validate" },
] as const;

const API_PATHS = ["/api/v1/validators/operators", "/api/v1/validators/economics"];

const MIN_STAKE_OPTIONS = [
  { value: 0, label: "Any stake" },
  { value: 1_000, label: "1kτ and up" },
  { value: 10_000, label: "10kτ and up" },
  { value: 100_000, label: "100kτ and up" },
];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function ValidatorsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<SortState | null>({ key: "stake", dir: "desc" });
  const { ref: costRef, nearViewport: costNearViewport } = useNearViewport("0px 0px");

  const { data: listed } = useSuspenseQuery(validatorOperatorDirectoryQuery());
  const economics = useQuery({
    ...validatorEconomicsQuery(130),
    // Permit cost is a distinct third reading after the directory. Preserve
    // its anchor and its loading/error geometry without fetching a 130-row
    // comparison before a reader chooses to inspect it.
    enabled: costNearViewport,
    retry: 0,
  });

  const operators = useMemo(
    () => deserializeOperatorRows(listed.data.operators),
    [listed.data.operators],
  );
  const comparisonNames = useMemo(
    () => Object.fromEntries(operators.map((row) => [row.primaryHotkey, row.name])),
    [operators],
  );
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

  const medianTake = median(operators.flatMap((operator) => operator.keys.map((key) => key.take)));
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
      width: "35%",
      value: (row) => row.name,
      render: (row) => (
        <span className="mg-dt-identity">
          <span className="truncate">{row.name}</span>
          <span className="mg-dt-count">
            {formatNumber(row.keyCount)} {row.keyCount === 1 ? "hotkey" : "hotkeys"}
          </span>
        </span>
      ),
      definition: "Operator",
    },
    {
      key: "stake",
      label: "Total stake",
      width: "25%",
      kind: "number",
      sortable: true,
      value: (row) => row.totalStakeTao,
      format: (value) => (typeof value === "number" ? fmtStake(value) : "—"),
      render: (row) => (
        <span className="mg-dt-share">
          <span>{fmtStake(row.totalStakeTao)}</span>
          {row.dominance !== null ? (
            <span className="mg-dt-share-context">
              <span className="mg-dt-share-track" aria-hidden="true">
                <i style={{ "--share": `${row.dominance * 100}%` } as CSSProperties} />
              </span>
              <span>{formatPct(row.dominance, 1)} of listed</span>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "take",
      label: "Take",
      kind: "number",
      sortable: true,
      width: 130,
      value: (row) => takeLabel(row.takeMin, row.takeMax),
      definition: "Take",
    },
    {
      key: "apy",
      label: "Est. APY",
      width: 130,
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
      demote: true,
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
      demote: true,
      width: 160,
      value: (row) => row.nominators,
      format: (value) => (typeof value === "number" ? formatNumber(value) : "—"),
      definition: "Nominators",
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
      render: (row) => (
        <ValidatorCompareToggle
          hotkey={row.primaryHotkey}
          name={row.name}
          primary={row.keyCount > 1}
        />
      ),
      definition: "Compare",
    },
  ];

  const sorted = sortRows(shown, sort, (row, key) =>
    key === "take" ? row.takeMax : columns.find((column) => column.key === key)?.value?.(row),
  );
  const changeSort = (next: SortState | null) => {
    setSort(next);
  };
  const sortOptions = columns
    .filter((column) => column.sortable)
    .flatMap((column) => [
      {
        value: `${column.key}:desc`,
        label: `${column.key === "take" ? "Maximum take" : column.label} · ${column.kind === "text" ? "Z–A" : "high to low"}`,
      },
      {
        value: `${column.key}:asc`,
        label: `${column.key === "take" ? "Maximum take" : column.label} · ${column.kind === "text" ? "A–Z" : "low to high"}`,
      },
    ]);

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
            className="mg-hero--directory mg-hero--entity"
            name="Validators"
            sentence={
              <FactSentence>
                Compare operators across all subnets. {formatNumber(listed.data.hotkey_count)}{" "}
                validator hotkeys, grouped by declared identity.
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
          id="operators"
          name="Operators"
          question="Search and compare validator operators."
          className="mg-directory-section mg-directory-section--table-first"
          visual={
            <DataTable
              rows={sorted}
              columns={columns}
              rowKey={(row) => row.key}
              caption="Operators"
              sort={sort}
              onSort={changeSort}
              pageResetKey={`${search.q}:${search.minStake}:${search.named}:${sort?.key}:${sort?.dir}`}
              className="mg-dt--directory"
              rowHref={(row) => `/validators/${row.primaryHotkey}`}
              link={RouterLink}
              source="validator-operator"
              mobile="cards"
              compactMobileLabels
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
                  <FilterField label="Sort by">
                    <FilterSelect
                      value={sort ? `${sort.key}:${sort.dir}` : ""}
                      onChange={(event) => {
                        const [key, dir] = event.target.value.split(":");
                        changeSort(key ? { key, dir: dir === "asc" ? "asc" : "desc" } : null);
                      }}
                    >
                      <option value="">Default order</option>
                      {sortOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </FilterSelect>
                  </FilterField>
                  {filtersActive ? (
                    <button
                      type="button"
                      className="mg-compare-action"
                      onClick={() => setSearch({ q: "", minStake: 0, named: false })}
                    >
                      Clear filters
                    </button>
                  ) : null}
                </>
              }
              expand={(row) =>
                row.keyCount > 1 ? (
                  <RankGrid
                    items={row.keys.map((validator) => ({
                      key: validator.hotkey,
                      label: shortKey(validator.hotkey),
                      value: fmtStake(validator.totalStakeTao),
                      share:
                        typeof validator.take === "number"
                          ? `${formatPct(validator.take, 1)} take`
                          : undefined,
                      href: `/validators/${validator.hotkey}`,
                    }))}
                    cols={3}
                    ariaLabel={`${row.name} hotkeys`}
                    source="validator-key"
                  />
                ) : null
              }
            />
          }
          footnote="Operator totals include every grouped hotkey. Comparison opens each operator’s largest-stake hotkey. Take sorting uses the maximum take."
        >
          <ValidatorCompareBar names={comparisonNames} primary />
        </AnalyticsSection>
        <AnalyticsSection
          id="concentration"
          name="Concentration"
          question={
            topShare === null
              ? "How listed stake is distributed."
              : `The top 10 operators hold ${formatPct(topShare, 1)} of listed stake.`
          }
          visual={
            segments.length > 0 ? (
              <CompositionBreakdown
                segments={segments}
                formatValue={(value) => fmtStake(value)}
                legendCols={3}
                className="mg-composition--ledger"
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
