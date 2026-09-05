import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  EntityHero,
  Fact,
  FactSentence,
  RankedRails,
  Raw,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { ErrorState } from "@/components/metagraphed/states";
import { OperatorDirectory } from "@/components/metagraphed/validators-index/operator-directory";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { fmtStake } from "@/components/metagraphed/validators-index/validators-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  validatorEconomicsQuery,
  validatorOperatorDirectoryQuery,
} from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { deserializeOperatorRows } from "@/lib/metagraphed/validator-operators";
import { Route } from "./validators.index";

const SECTIONS = [
  { id: "operators", name: "Operators" },
  { id: "concentration", name: "Data scope" },
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
  const setSearch = (next: Partial<typeof search>) => {
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  };

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
                Find operators, inspect their hotkeys and compare individual keys.{" "}
                <Fact>{formatNumber(operators.length)} operators</Fact>{" "}
                <Fact>{formatNumber(listed.data.hotkey_count)} validator hotkeys</Fact>
              </FactSentence>
            }
            live={{
              updatedAt: listed.data.captured_at,
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
          question="Find a validator."
          className="mg-directory-section mg-directory-section--table-first"
          visual={<OperatorDirectory operators={operators} search={search} onSearch={setSearch} />}
          footnote={`${formatNumber(listed.data.hotkey_count)} validator hotkeys · chain-direct`}
        />
        <AnalyticsSection
          id="concentration"
          name="Data scope"
          question="What these records describe."
          visual={
            <p className="max-w-prose text-13 text-ink-muted">
              Declared names are labels, not verification. Expand a row to inspect its individual
              hotkeys. Balance, return and holdings-concentration figures are unavailable here.
            </p>
          }
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
