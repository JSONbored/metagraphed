import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  RangeControl,
  RankGrid,
  StackedColumns,
  type RankGridItem,
} from "@jsonbored/ui-kit";
import { accountStakeFlowQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  FLOW_WINDOWS,
  flowColumns,
  fmtCompactTao,
  fmtSignedTao,
  type FlowWindow,
} from "./account-detail-logic";

/**
 * Section 2 — stake moving in and out, per subnet.
 *
 * Columns are subnets, not weeks: `/stake-flow` publishes a per-subnet total
 * for the window and no series, so a time axis would be invented. The window
 * control changes what is totalled, which is the real dimension available.
 */
export function FlowSection({
  ss58,
  window,
  onWindow,
  nameOf,
}: {
  ss58: string;
  window: FlowWindow;
  onWindow: (next: FlowWindow) => void;
  nameOf: (netuid: number) => string;
}) {
  const { data } = useQuery({ ...accountStakeFlowQuery(ss58, { window }), retry: 0 });
  const flow = data?.data;
  const columns = flowColumns(flow?.subnets ?? [], nameOf);

  const legend: RankGridItem[] = [
    { key: "in", label: "Staked in", value: fmtCompactTao(flow?.total_staked_tao) },
    { key: "out", label: "Unstaked out", value: fmtCompactTao(flow?.total_unstaked_tao) },
    { key: "net", label: "Net", value: fmtSignedTao(flow?.net_flow_tao) },
    { key: "subnets", label: "Subnets touched", value: formatNumber(flow?.subnet_count ?? 0) },
  ];

  return (
    <AnalyticsSection
      id="flow"
      name="Flow"
      question="Stake moving in and out, by subnet."
      controls={
        <RangeControl label="Window" options={FLOW_WINDOWS} value={window} onChange={onWindow} />
      }
      visual={
        columns.length > 0 ? (
          <StackedColumns
            columns={columns}
            seriesOrder={["staked", "unstaked"]}
            formatValue={(value) => fmtCompactTao(value)}
            ariaLabel="Stake moved per subnet"
            columnSource="account-flow"
          />
        ) : null
      }
      legend={
        columns.length > 0 ? <RankGrid items={legend} cols={4} ariaLabel="Flow totals" /> : null
      }
      footnote={
        columns.length > 0
          ? `${window} · ${flow?.direction ?? "flat"} · chain-direct`
          : `${window} · no stake moved in this window`
      }
    />
  );
}
