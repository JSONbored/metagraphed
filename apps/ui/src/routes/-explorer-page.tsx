import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  CompositionBreakdown,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FactStrip,
  FilterField,
  FilterSelect,
  LineWithWindow,
  MarkerRail,
  RangeControl,
  RankedRails,
  Raw,
  type DataTableColumn,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import {
  CHAIN_WINDOWS,
  callSegments,
  feePoints,
  summarizeFeeWindow,
  flowRails,
  fmtCount,
  fmtShare,
  fmtTao,
  governanceKinds,
  governanceRows,
  lastCompleteDay,
  pipelineRails,
  pipelineTally,
  type ChainWindowValue,
  type GovernanceRow,
} from "@/components/metagraphed/chain-hub/chain-hub-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  blocksSummaryQuery,
  chainActivityQuery,
  chainCallsQuery,
  chainConcentrationQuery,
  chainFeesQuery,
  chainStakeFlowQuery,
  economicsQuery,
  emissionPipelineQuery,
  governanceConfigChangesQuery,
  runtimeVersionHistoryQuery,
  sudoCallsQuery,
} from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { Route } from "./chain.index";

const SECTIONS = [
  { id: "throughput", name: "Throughput" },
  { id: "fees", name: "Fees" },
  { id: "stake-flow", name: "Stake flow" },
  { id: "concentration", name: "Concentration" },
  { id: "emission", name: "Emission" },
  { id: "governance", name: "Governance" },
] as const;

const API_PATHS = [
  "/api/v1/chain/activity",
  "/api/v1/chain/calls",
  "/api/v1/chain/fees",
  "/api/v1/chain/stake-flow",
  "/api/v1/chain/concentration",
  "/api/v1/chain/emission-pipeline",
  "/api/v1/runtime",
  "/api/v1/sudo",
  "/api/v1/governance/config-changes",
];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function ExplorerPage() {
  const { window } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [govKind, setGovKind] = useState("");
  const { ref: throughputRef, nearViewport: throughputNearViewport } = useNearViewport("0px 0px");
  const { ref: feesRef, nearViewport: feesNearViewport } = useNearViewport("0px 0px");
  const { ref: flowRef, nearViewport: flowNearViewport } = useNearViewport("0px 0px");
  const { ref: concentrationRef, nearViewport: concentrationNearViewport } =
    useNearViewport("0px 0px");
  const { ref: emissionRef, nearViewport: emissionNearViewport } = useNearViewport("0px 0px");
  const { ref: governanceRef, nearViewport: governanceNearViewport } = useNearViewport("0px 0px");

  // Daily activity is one independently fallible rollup, not the route's
  // availability gate. If its projection declines, the blocks, calls, fees,
  // stake, emission, and governance sources below can still answer. Keeping
  // this as a normal query also avoids blocking the whole SSR stream on the
  // slowest overview source.
  const activity = useQuery({ ...chainActivityQuery(window), retry: 0 });
  const blocks = useQuery({ ...blocksSummaryQuery(), retry: 0 });
  const calls = useQuery({
    ...chainCallsQuery(window),
    enabled: throughputNearViewport,
    retry: 0,
  });
  const fees = useQuery({ ...chainFeesQuery(window), enabled: feesNearViewport, retry: 0 });
  const flow = useQuery({ ...chainStakeFlowQuery(window), enabled: flowNearViewport, retry: 0 });
  const concentration = useQuery({
    ...chainConcentrationQuery(),
    enabled: concentrationNearViewport,
    retry: 0,
  });
  const runtime = useQuery({
    ...runtimeVersionHistoryQuery(),
    enabled: governanceNearViewport,
    retry: 0,
  });
  const sudo = useQuery({
    ...sudoCallsQuery({ limit: 50 }),
    enabled: governanceNearViewport,
    retry: 0,
  });
  const config = useQuery({
    ...governanceConfigChangesQuery({ limit: 50 }),
    enabled: governanceNearViewport,
    retry: 0,
  });
  const pipeline = useQuery({
    ...emissionPipelineQuery(),
    enabled: emissionNearViewport,
    retry: 0,
  });
  const economics = useQuery({
    ...economicsQuery({ fields: "identity" }),
    enabled: emissionNearViewport || flowNearViewport,
    retry: 0,
  });

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of economics.data?.data ?? []) {
      map.set(row.netuid, row.name ?? `Subnet ${row.netuid}`);
    }
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [economics.data]);

  const days = activity.data?.data.days ?? [];
  const latest = lastCompleteDay(days);
  const segments = callSegments(calls.data?.data.calls ?? []);
  const points = feePoints(fees.data?.data.daily ?? []);
  const flowRailItems = flowRails(flow.data?.data.subnets ?? [], nameOf, (value) =>
    fmtTao(value, 0),
  );
  const summary = blocks.data?.data;
  const stake = concentration.data?.data.stake;

  const gov = useMemo(
    () =>
      governanceRows(
        runtime.data?.data.transitions ?? [],
        sudo.data?.data ?? [],
        config.data?.data ?? [],
      ),
    [runtime.data, sudo.data, config.data],
  );
  const shownGov = govKind ? gov.filter((row) => row.kind === govKind) : gov;
  const emissionRail = useMemo(
    () => pipelineRails(pipeline.data?.data.subnets ?? [], nameOf),
    [pipeline.data, nameOf],
  );
  const aggregate = pipeline.data?.data.aggregate;
  const tally = useMemo(() => pipelineTally(pipeline.data?.data.subnets ?? []), [pipeline.data]);
  const governanceLoading =
    governanceNearViewport && (runtime.isPending || sudo.isPending || config.isPending);
  const governanceUnavailable =
    governanceNearViewport && runtime.isError && sudo.isError && config.isError;
  const governanceError = runtime.error ?? sudo.error ?? config.error;

  const setWindow = (next: ChainWindowValue) => {
    navigate({ search: (prev) => ({ ...prev, window: next }), replace: true });
  };

  // The head block and the block time were chips AND cells -- and at two
  // different precisions, "12s blocks" above "Block time p50 12.0s", which
  // reads as two measurements of one thing (#11693). The strip keeps them.
  const sentence: FactNodes = [
    <Fact key="per">
      {blocks.isPending
        ? "loading throughput"
        : summary?.throughput?.mean_extrinsics_per_block
          ? `${formatDecimal(summary.throughput.mean_extrinsics_per_block, 1)} extrinsics/block`
          : "—"}
    </Fact>,
  ];

  const cells: FactCells = [
    {
      label: "Head block",
      value: summary?.last_block ? formatNumber(summary.last_block) : "—",
      loading: blocks.isPending,
    },
    {
      label: "Block time p50",
      value: summary?.block_time?.p50_ms
        ? `${formatDecimal(summary.block_time.p50_ms / 1000, 1)}s`
        : "—",
      loading: blocks.isPending,
    },
    // The last COMPLETE day, not the one in progress -- see lastCompleteDay.
    {
      label: `Extrinsics ${latest?.day ?? ""}`.trim(),
      value: fmtCount(latest?.extrinsic_count),
      loading: activity.isPending,
    },
    { label: "Events", value: fmtCount(latest?.event_count), loading: activity.isPending },
    { label: "Signers", value: fmtCount(latest?.unique_signers), loading: activity.isPending },
  ];

  const feeDays = fees.data?.data.daily ?? [];
  const feeWindow = summarizeFeeWindow(feeDays);

  const feeCells: FactCells = [
    {
      label: `Fees ${window}`,
      value: feeWindow ? fmtTao(feeWindow.totalFeeTao, 4) : "—",
      loading: fees.isPending,
    },
    {
      label: "Per extrinsic",
      value: fmtTao(feeWindow?.averageFeeTao, 6),
      loading: fees.isPending,
    },
    {
      label: `Tips ${window}`,
      value: feeWindow ? fmtTao(feeWindow.totalTipTao, 4) : "—",
      loading: fees.isPending,
    },
    {
      label: "Days measured",
      value: feeWindow ? formatNumber(fees.data?.data.day_count ?? feeWindow.dayCount) : "—",
      loading: fees.isPending,
    },
  ];

  const concentrationRail = useMemo(() => {
    const rows = [
      // Percentile shares, not counts: the endpoint publishes "the top 1% of
      // holders hold X", which is the reading that survives the holder count
      // changing underneath it.
      { key: "stake-top1", label: "Top 1% of holders", value: stake?.top_1pct_share },
      { key: "stake-top5", label: "Top 5%", value: stake?.top_5pct_share },
      { key: "stake-top10", label: "Top 10%", value: stake?.top_10pct_share },
      { key: "stake-gini", label: "Gini", value: stake?.gini },
    ];
    return rows
      .filter((row) => typeof row.value === "number")
      .map((row) => ({ key: row.key, label: row.label, value: (row.value as number) * 100 }));
  }, [stake]);

  const govColumns: DataTableColumn<GovernanceRow>[] = [
    { key: "at", label: "When", kind: "time", value: (row) => row.at },
    { key: "kind", label: "Kind", kind: "status", value: (row) => row.kind },
    { key: "summary", label: "Change", kind: "text", value: (row) => row.summary },
    {
      key: "block",
      label: "Block",
      kind: "link",
      value: (row) => (row.block == null ? "—" : String(row.block)),
      href: (row) => (row.block == null ? undefined : `/blocks/${row.block}`),
    },
    {
      key: "signer",
      label: "Signer",
      kind: "identifier",
      demote: true,
      value: (row) => row.signer ?? "—",
    },
  ];

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <AnalyticsPage
        className="mg-page--chain-story"
        sections={SECTIONS}
        hero={
          <EntityHero
            className="mg-hero--operational mg-hero--chain"
            name="Chain"
            sentence={
              <FactSentence>
                What the chain is doing right now, and what it charged for it. {sentence}
              </FactSentence>
            }
            cells={cells}
            live={{
              updatedAt: activity.data?.data.observed_at ?? null,
              source: "chain-direct",
              onRefresh: () =>
                void queryClient.invalidateQueries(metagraphedQueryInvalidationTarget()),
            }}
          />
        }
      >
        <AnalyticsSection
          className="mg-chain-throughput"
          id="throughput"
          name="Throughput"
          question="What the chain's extrinsics are actually doing."
          visualRef={throughputRef}
          controls={
            <RangeControl
              label="Window"
              options={CHAIN_WINDOWS}
              value={window}
              onChange={setWindow}
            />
          }
          visual={
            <div className="grid gap-6">
              {activity.isError ? (
                <ErrorState
                  error={activity.error}
                  context="daily chain activity"
                  onRetry={() => void activity.refetch()}
                />
              ) : null}
              {!throughputNearViewport || calls.isPending ? (
                <CompositionBreakdown
                  formatValue={(value) => fmtCount(value)}
                  legendCols={3}
                  ariaLabel="Extrinsics by call module"
                  source="chain-call"
                  loading
                />
              ) : segments.length > 0 ? (
                <CompositionBreakdown
                  segments={segments}
                  formatValue={(value) => fmtCount(value)}
                  // Throughput sits beside its reading lens on wide screens.
                  // Three columns retain the whole module name and measured
                  // value instead of turning the ranked legend into ellipses.
                  legendCols={3}
                  ariaLabel="Extrinsics by call module"
                  source="chain-call"
                />
              ) : null}
            </div>
          }
          // Per-module totals for the window, not an hourly series:
          // /chain/calls publishes the former and nothing else.
          //
          // The three stream routes hang off THIS section's footnote and
          // nowhere else on the page. They were reachable through the hub's
          // nine-tab strip until #11619 removed it, and the footnote is where
          // the design system already puts a section's one way down into its
          // rows -- the same slot and the same `.mg-section-more` set as a
          // "show all N". Throughput is the section they belong under: it
          // says what the extrinsics are doing in aggregate, and the streams
          // are the same extrinsics one at a time.
          footnote={
            <>
              {!throughputNearViewport
                ? `${window} call-module mix · chain-direct · row by row: `
                : calls.isPending
                  ? `Loading ${window} call mix · chain-direct · row by row: `
                  : calls.isError
                    ? "Call mix is temporarily unavailable · chain-direct · row by row: "
                    : `${window} · ${fmtCount(
                        calls.data?.data.total_extrinsics,
                      )} extrinsics across ${formatNumber(
                        calls.data?.data.call_count ?? 0,
                      )} modules · chain-direct · row by row: `}
              <RouterLink href="/chain/blocks" className="mg-section-more">
                blocks
              </RouterLink>
              {" · "}
              <RouterLink href="/chain/extrinsics" className="mg-section-more">
                extrinsics
              </RouterLink>
              {" · "}
              <RouterLink href="/chain/events" className="mg-section-more">
                events
              </RouterLink>
            </>
          }
        />
        <AnalyticsSection
          id="fees"
          name="Fees"
          question="What the chain charged."
          visualRef={feesRef}
          visual={
            !feesNearViewport || fees.isPending ? (
              <LineWithWindow
                id="chain-fees"
                points={[]}
                window={{ from: 0, to: 0 }}
                unit="τ"
                formatValue={(value) => fmtTao(value, 4)}
                ariaLabel={`Daily fees, ${window}`}
                source="chain-fees"
                loading
              />
            ) : points.length > 1 ? (
              <LineWithWindow
                id="chain-fees"
                points={points}
                window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
                unit="τ"
                formatValue={(value) => fmtTao(value, 4)}
                ariaLabel={`Daily fees, ${window}`}
                source="chain-fees"
              />
            ) : null
          }
          legend={<FactStrip cells={feeCells} />}
          footnote={
            !feesNearViewport
              ? `${window} · signed extrinsic fees · chain-direct`
              : fees.isPending
                ? `Loading ${window} fees · chain-direct`
                : fees.isError
                  ? "Fee history is temporarily unavailable · chain-direct"
                  : `${window} · signed extrinsics only · chain-direct`
          }
        />
        <AnalyticsSection
          id="stake-flow"
          name="Stake flow"
          question="Where stake moved."
          visualRef={flowRef}
          visual={
            !flowNearViewport || flow.isPending ? (
              <RankedRails
                items={[]}
                formatValue={(value) => fmtTao(value, 0)}
                formatSecondary={(value) => fmtTao(value, 0)}
                scale="sqrt"
                columns={{
                  value: "Staked in",
                  name: "Subnet",
                  track: "Against the largest inflow",
                  secondary: "Unstaked out",
                }}
                limit={12}
                ariaLabel="Stake moved per subnet"
                source="chain-flow"
                loading
                loadingRows={12}
                loadingSecondary
              />
            ) : flowRailItems.length > 0 ? (
              <RankedRails
                items={flowRailItems}
                formatValue={(value) => fmtTao(value, 0)}
                formatSecondary={(value) => fmtTao(value, 0)}
                scale="sqrt"
                columns={{
                  value: "Staked in",
                  name: "Subnet",
                  track: "Against the largest inflow",
                  secondary: "Unstaked out",
                }}
                limit={12}
                ariaLabel="Stake moved per subnet"
                source="chain-flow"
              />
            ) : null
          }
          footnote={
            !flowNearViewport
              ? `${window} stake inflow and outflow by subnet · chain-direct`
              : flow.isPending
                ? `Loading ${window} stake flow · chain-direct`
                : flow.isError
                  ? "Stake flow is temporarily unavailable · chain-direct"
                  : `${window} · the 12 busiest, ordered by inflow · net ${fmtTao(
                      flow.data?.data.network?.net_flow_tao,
                      0,
                    )} across ${formatNumber(flow.data?.data.subnet_count ?? 0)} subnets · chain-direct`
          }
        />
        <AnalyticsSection
          id="concentration"
          name="Concentration"
          question="How concentrated the stake is."
          visualRef={concentrationRef}
          visual={
            !concentrationNearViewport || concentration.isPending ? (
              <MarkerRail
                loading
                loadingRows={4}
                max={100}
                formatValue={(value) => `${formatDecimal(value, 1)}%`}
                columns={{ ratio: "Share", name: "Measure", scale: "0–100%" }}
                ariaLabel="Stake concentration measures"
                source="chain-concentration"
              />
            ) : concentrationRail.length > 0 ? (
              <MarkerRail
                items={concentrationRail}
                max={100}
                formatValue={(value) => `${formatDecimal(value, 1)}%`}
                columns={{ ratio: "Share", name: "Measure", scale: "0–100%" }}
                ariaLabel="Stake concentration measures"
                source="chain-concentration"
              />
            ) : null
          }
          empty={
            concentration.isError
              ? "Stake concentration is temporarily unavailable."
              : "No concentration measure for this window."
          }
          footnote={
            !concentrationNearViewport
              ? "holder shares and Nakamoto coefficient · chain-direct"
              : concentration.isPending
                ? "Loading stake concentration · chain-direct"
                : concentration.isError
                  ? "Stake concentration is temporarily unavailable · chain-direct"
                  : stake
                    ? `${formatNumber(stake.holders ?? 0)} holders · Nakamoto ${formatNumber(
                        stake.nakamoto_coefficient ?? 0,
                      )} — the smallest number of holders that together control half the stake · chain-direct`
                    : "No concentration reading is published for this window · chain-direct"
          }
        />
        <AnalyticsSection
          id="emission"
          name="Emission"
          question="How a subnet's published share becomes the share it is paid."
          visualRef={emissionRef}
          visual={
            !emissionNearViewport || pipeline.isPending ? (
              <RankedRails
                items={[]}
                formatValue={(value: number) => fmtShare(value, 3)}
                scale="sqrt"
                columns={{ value: "Paid share", name: "Subnet", track: "Share of block emission" }}
                ariaLabel="Subnets by the share of emission they receive"
                source="chain-emission"
                loading
                loadingRows={12}
              />
            ) : emissionRail.length > 0 ? (
              <RankedRails
                items={emissionRail}
                formatValue={(value: number) => fmtShare(value, 3)}
                scale="sqrt"
                columns={{ value: "Paid share", name: "Subnet", track: "Share of block emission" }}
                ariaLabel="Subnets by the share of emission they receive"
                source="chain-emission"
              />
            ) : null
          }
          legend={
            <FactStrip
              cells={[
                {
                  label: "Paid",
                  value: `${formatNumber(tally.paid)} / ${formatNumber(tally.total)}`,
                  loading: !emissionNearViewport || pipeline.isPending,
                },
                {
                  label: "Block emission",
                  value: fmtTao(pipeline.data?.data.block_emission_tao, 4),
                  loading: !emissionNearViewport || pipeline.isPending,
                },
                {
                  label: "Pool liquidity",
                  value: fmtTao(aggregate?.tao_in_emission, 4),
                  loading: !emissionNearViewport || pipeline.isPending,
                },
                {
                  label: "Chain buys",
                  value: fmtTao(aggregate?.excess_tao, 4),
                  loading: !emissionNearViewport || pipeline.isPending,
                },
              ]}
            />
          }
          // Ranked by what a subnet is PAID, not by what it would be paid
          // before the gate -- ranking by the pre-gate figure puts a disabled
          // subnet above a paid one, which is the gate stated backwards.
          footnote={
            !emissionNearViewport
              ? "paid emission share and eligibility state · chain-direct"
              : pipeline.isPending
                ? "Loading live emission state · chain-direct"
                : pipeline.isError
                  ? "Live emission state is temporarily unavailable · chain-direct"
                  : `live chain state · ${formatNumber(tally.unpaid)} receive nothing: ${formatNumber(
                      tally.ineligible,
                    )} never eligible, ${formatNumber(tally.disabled)} with emission off, ${formatNumber(
                      tally.zeroWeighted,
                    )} zeroed by the weighting · chain-direct`
          }
        />
        <AnalyticsSection
          id="governance"
          name="Governance"
          question="What changed about how the chain runs."
          visualRef={governanceRef}
          controls={
            <FilterField label="Kind">
              <FilterSelect value={govKind} onChange={(event) => setGovKind(event.target.value)}>
                <option value="">Any kind</option>
                {governanceKinds(gov).map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </FilterSelect>
            </FilterField>
          }
          visual={
            <DataTable
              rows={shownGov}
              columns={govColumns}
              rowKey={(row) => row.key}
              caption="Runtime upgrades, sudo calls and config changes"
              link={RouterLink}
              source="chain-governance"
              pageSize={25}
              mobile="cards"
              dense
              storageKey="chain-governance-columns"
              loading={!governanceNearViewport || governanceLoading}
              error={
                governanceUnavailable && governanceError ? (
                  <ErrorState
                    error={governanceError}
                    context="governance changes"
                    onRetry={() => {
                      void runtime.refetch();
                      void sudo.refetch();
                      void config.refetch();
                    }}
                  />
                ) : undefined
              }
              empty="No governance changes were indexed for this history."
            />
          }
          // Three routes and three tables answered one question, and a reader
          // had to know which of the three a change would have landed in.
          footnote={
            !governanceNearViewport
              ? "runtime upgrades, sudo calls and AdminUtils changes · chain-direct"
              : governanceLoading
                ? "Loading governance changes · chain-direct"
                : governanceUnavailable
                  ? "Governance sources are temporarily unavailable · chain-direct"
                  : `${formatNumber(shownGov.length)} of ${formatNumber(
                      gov.length,
                    )} changes · runtime upgrades, sudo calls and AdminUtils config, one stream · chain-direct`
          }
        />
        <Raw rows={rawRows} title="Chain API" />
        <HubSections path="/chain" />
      </AnalyticsPage>
    </AppShell>
  );
}
