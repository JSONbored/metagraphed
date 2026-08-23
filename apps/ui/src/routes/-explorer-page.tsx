import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
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
import {
  CHAIN_WINDOWS,
  callSegments,
  feePoints,
  flowColumns,
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
import { formatNumber } from "@/lib/metagraphed/format";
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

  const { data: activity } = useSuspenseQuery(chainActivityQuery(window));
  const blocks = useQuery({ ...blocksSummaryQuery(), retry: 0 });
  const calls = useQuery({ ...chainCallsQuery(window), retry: 0 });
  const fees = useQuery({ ...chainFeesQuery(window), retry: 0 });
  const flow = useQuery({ ...chainStakeFlowQuery(window), retry: 0 });
  const concentration = useQuery({ ...chainConcentrationQuery(), retry: 0 });
  const runtime = useQuery({ ...runtimeVersionHistoryQuery(), retry: 0 });
  const sudo = useQuery({ ...sudoCallsQuery({ limit: 50 }), retry: 0 });
  const config = useQuery({ ...governanceConfigChangesQuery({ limit: 50 }), retry: 0 });
  const pipeline = useQuery({ ...emissionPipelineQuery(), retry: 0 });
  const economics = useQuery({ ...economicsQuery({ fields: "identity" }), retry: 0 });

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of economics.data?.data ?? []) {
      map.set(row.netuid, row.name ?? `Subnet ${row.netuid}`);
    }
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [economics.data]);

  const days = activity.data.days ?? [];
  const latest = lastCompleteDay(days);
  const segments = callSegments(calls.data?.data.calls ?? []);
  const points = feePoints(fees.data?.data.daily ?? []);
  const columns = flowColumns(flow.data?.data.subnets ?? [], nameOf);
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

  const setWindow = (next: ChainWindowValue) => {
    navigate({ search: (prev) => ({ ...prev, window: next }), replace: true });
  };

  const sentence: FactNodes = [
    <Fact key="head">
      {summary?.last_block ? `head #${formatNumber(summary.last_block)}` : "head —"}
    </Fact>,
    <Fact key="time">
      {summary?.block_time?.p50_ms
        ? `${(summary.block_time.p50_ms / 1000).toFixed(0)}s blocks`
        : "—"}
    </Fact>,
    <Fact key="per">
      {summary?.throughput?.mean_extrinsics_per_block
        ? `${summary.throughput.mean_extrinsics_per_block.toFixed(1)} extrinsics/block`
        : "—"}
    </Fact>,
    <Fact key="nakamoto">
      {stake?.nakamoto_coefficient
        ? `Nakamoto ${formatNumber(stake.nakamoto_coefficient)}`
        : "Nakamoto —"}
    </Fact>,
    <Fact key="spec">
      {runtime.data?.data.current_spec_version
        ? `spec ${runtime.data.data.current_spec_version}`
        : "spec —"}
    </Fact>,
  ];

  const cells: FactCells = [
    {
      label: "Head block",
      value: summary?.last_block ? formatNumber(summary.last_block) : "—",
    },
    {
      label: "Block time p50",
      value: summary?.block_time?.p50_ms
        ? `${(summary.block_time.p50_ms / 1000).toFixed(1)}s`
        : "—",
    },
    // The last COMPLETE day, not the one in progress -- see lastCompleteDay.
    { label: `Extrinsics ${latest?.day ?? ""}`.trim(), value: fmtCount(latest?.extrinsic_count) },
    { label: "Events", value: fmtCount(latest?.event_count) },
    { label: "Signers", value: fmtCount(latest?.unique_signers) },
  ];

  const callLegend: RankGridItem[] = segments.map((segment) => ({
    key: segment.key,
    label: segment.label,
    value: fmtCount(segment.value),
    share: fmtShare(segment.value / (calls.data?.data.total_extrinsics || 1)),
  }));

  const feeCells: FactCells = [
    {
      label: `Fees ${window}`,
      value: fmtTao(
        (fees.data?.data.daily ?? []).reduce((acc, day) => acc + (day.total_fee_tao ?? 0), 0),
        4,
      ),
    },
    {
      label: "Per extrinsic",
      value: fmtTao(
        (fees.data?.data.daily ?? []).reduce((acc, day) => acc + (day.avg_fee_tao ?? 0), 0) /
          Math.max(1, (fees.data?.data.daily ?? []).length),
        6,
      ),
    },
    {
      label: `Tips ${window}`,
      value: fmtTao(
        (fees.data?.data.daily ?? []).reduce((acc, day) => acc + (day.total_tip_tao ?? 0), 0),
        4,
      ),
    },
    { label: "Days measured", value: formatNumber(fees.data?.data.day_count ?? 0) },
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
        sections={SECTIONS}
        hero={
          <EntityHero
            name="Chain"
            sentence={<FactSentence>{sentence}</FactSentence>}
            cells={cells}
            live={{
              updatedAt: activity.data.observed_at ?? null,
              source: "chain-direct",
              onRefresh: () => void queryClient.invalidateQueries({ queryKey: ["mg"] }),
            }}
          />
        }
      >
        <AnalyticsSection
          id="throughput"
          name="Throughput"
          question="What the chain's extrinsics are actually doing."
          controls={
            <RangeControl
              label="Window"
              options={CHAIN_WINDOWS}
              value={window}
              onChange={setWindow}
            />
          }
          visual={
            segments.length > 0 ? (
              <CompositionBreakdown
                segments={segments}
                formatValue={(value) => fmtCount(value)}
                legendCols={4}
                ariaLabel="Extrinsics by call module"
                source="chain-call"
              />
            ) : null
          }
          legend={
            callLegend.length > 0 ? (
              <RankGrid items={callLegend} cols={4} ariaLabel="Call modules" source="chain-call" />
            ) : null
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
              {`${window} · ${fmtCount(
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
          visual={
            points.length > 1 ? (
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
          footnote={`${window} · signed extrinsics only · chain-direct`}
        />
        <AnalyticsSection
          id="stake-flow"
          name="Stake flow"
          question="Where stake moved."
          visual={
            columns.length > 0 ? (
              <StackedColumns
                columns={columns}
                seriesOrder={["staked", "unstaked"]}
                formatValue={(value) => fmtTao(value, 0)}
                ariaLabel="Stake moved per subnet"
                columnSource="chain-flow"
              />
            ) : null
          }
          footnote={`${window} · net ${fmtTao(
            flow.data?.data.network?.net_flow_tao,
            0,
          )} across ${formatNumber(flow.data?.data.subnet_count ?? 0)} subnets · chain-direct`}
        />
        <AnalyticsSection
          id="concentration"
          name="Concentration"
          question="How concentrated the stake is."
          visual={
            concentrationRail.length > 0 ? (
              <MarkerRail
                items={concentrationRail}
                max={100}
                formatValue={(value) => `${value.toFixed(1)}%`}
                columns={{ ratio: "Share", name: "Measure", scale: "0–100%" }}
                ariaLabel="Stake concentration measures"
                source="chain-concentration"
              />
            ) : null
          }
          footnote={
            stake
              ? `${formatNumber(stake.holders ?? 0)} holders · Nakamoto ${formatNumber(
                  stake.nakamoto_coefficient ?? 0,
                )} — the smallest number of holders that together control half the stake · chain-direct`
              : "concentration unavailable"
          }
        />
        <AnalyticsSection
          id="emission"
          name="Emission"
          question="How a subnet's published share becomes the share it is paid."
          visual={
            emissionRail.length > 0 ? (
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
                },
                {
                  label: "Block emission",
                  value: fmtTao(pipeline.data?.data.block_emission_tao, 4),
                },
                { label: "Pool liquidity", value: fmtTao(aggregate?.tao_in_emission, 4) },
                { label: "Chain buys", value: fmtTao(aggregate?.excess_tao, 4) },
              ]}
            />
          }
          // Ranked by what a subnet is PAID, not by what it would be paid
          // before the gate -- ranking by the pre-gate figure puts a disabled
          // subnet above a paid one, which is the gate stated backwards.
          footnote={`live chain state · ${formatNumber(tally.unpaid)} receive nothing: ${formatNumber(
            tally.ineligible,
          )} never eligible, ${formatNumber(tally.disabled)} with emission off, ${formatNumber(
            tally.zeroWeighted,
          )} zeroed by the weighting · chain-direct`}
        />
        <AnalyticsSection
          id="governance"
          name="Governance"
          question="What changed about how the chain runs."
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
            />
          }
          // Three routes and three tables answered one question, and a reader
          // had to know which of the three a change would have landed in.
          footnote={`${formatNumber(shownGov.length)} of ${formatNumber(
            gov.length,
          )} changes · runtime upgrades, sudo calls and AdminUtils config, one stream · chain-direct`}
        />
        <Raw rows={rawRows} title="Chain API" />
      </AnalyticsPage>
    </AppShell>
  );
}
