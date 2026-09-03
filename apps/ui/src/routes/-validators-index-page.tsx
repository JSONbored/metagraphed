import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  CompositionBreakdown,
  EntityHero,
  Fact,
  FactSentence,
  FactStrip,
  RESIDUAL_KEY,
  RankedRails,
  Raw,
  type FactCells,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { ErrorState } from "@/components/metagraphed/states";
import { OperatorDirectory } from "@/components/metagraphed/validators-index/operator-directory";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  concentration,
  fmtStake,
  median,
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

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function ValidatorsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
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
  const { segments, listedTotal } = useMemo(() => concentration(operators, 10), [operators]);

  const medianTake = median(operators.flatMap((operator) => operator.keys.map((key) => key.take)));
  const medianApy = median(operators.map((operator) => operator.apyEstimate));
  const topTen = segments
    .filter((segment) => segment.key !== RESIDUAL_KEY)
    .reduce((acc, segment) => acc + segment.value, 0);
  const topShare = listedTotal > 0 ? topTen / listedTotal : null;

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
        className="mg-page--validators"
        hero={
          <EntityHero
            className="mg-hero--validators"
            name="Validators"
            sentence={
              <FactSentence>
                Compare stake, estimated yield and the operators behind{" "}
                <Fact>{formatNumber(listed.data.hotkey_count)} validator hotkeys</Fact>
              </FactSentence>
            }
            facts={
              <div className="mg-validator-summary">
                <FactStrip cells={cells} />
                <div className="mg-validator-concentration">
                  <div className="mg-validator-concentration-label">
                    <span>Listed stake distribution</span>
                    <a href="#concentration">
                      Top 10 {topShare === null ? "—" : formatPct(topShare, 1)}
                    </a>
                  </div>
                  <CompositionBreakdown
                    segments={segments}
                    formatValue={fmtStake}
                    legendCols={3}
                    legendLimit={3}
                    ariaLabel="Listed stake by operator"
                    source="validator-operator"
                    className="mg-composition--preview"
                  />
                </div>
              </div>
            }
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
          question="Find and compare validator operators."
          className="mg-directory-section mg-directory-section--table-first"
          visual={<OperatorDirectory operators={operators} search={search} onSearch={setSearch} />}
        />
        <AnalyticsSection
          id="concentration"
          name="Concentration"
          question="How much listed stake the largest operators hold."
          visual={
            segments.length > 0 ? (
              <CompositionBreakdown
                segments={segments}
                formatValue={fmtStake}
                legendCols={3}
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
